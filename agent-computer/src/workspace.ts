/**
 * The Bot's files, and the boundary they must not escape.
 *
 * The computer has a `/workspace` volume so that anything a Bot should still have next week
 * survives the container. A Bot can read and write in it, which turns a durable directory into an
 * attack surface: the process runs as root inside its container, so `write_file("../../etc/passwd")`
 * is the obvious first thing to try and `read_file("../../root/.ssh/id_rsa")` the second.
 *
 * Path confinement is enforced in three layers:
 *
 *  1. Absolute paths are refused outright. A Bot names a file relative to its own workspace; there is
 *     no legitimate request that begins with `/`.
 *  2. The resolved path must be inside the root lexically. This catches `..` traversal.
 *  3. The resolved path must still be inside the root after symlinks are followed. This is the layer
 *     people miss: a symlink placed inside the workspace (by an earlier write, or by a page the Bot
 *     downloaded something from) passes the lexical check and then points anywhere on the filesystem.
 *     For a write, the file may not exist yet, so it is the deepest existing ancestor that gets
 *     resolved, which is the directory the write will actually land in.
 *
 * A factory taking its root as an argument rather than reading the environment, so the confinement
 * can be tested against a temporary directory instead of being taken on trust.
 */
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export type WorkspaceLimits = {
  /**
   * Most bytes a read hands back.
   *
   * Bounded for the same reason page text is: the contents go into a model's context, and one large
   * file would push the rest of the conversation out of it.
   */
  readBytes: number;
  /** Most bytes a single write accepts, so a loop cannot fill the volume. */
  writeBytes: number;
  /** Most entries a listing describes, so a Bot cannot paste a whole disk into its own context. */
  listEntries: number;
  /** Most bytes accepted from one browser download. */
  downloadBytes?: number;
};

/**
 * One thing in the workspace. Folders included so a Bot can see the shape, not just the leaves.
 *
 * Mirrors `WorkspaceEntry` in the server's published contract (`server/src/computer/schema.ts`), the
 * same way `SnapshotElement` does. Duplicated rather than shared because this process is a separate
 * deployable with no code in common with the server; the two must be changed together, and a field
 * added here and not there is invisible until a Bot asks for it.
 */
export type WorkspaceEntry = {
  /** Relative to the workspace root, which is the only form a request may use. */
  path: string;
  kind: "file" | "folder";
  bytes?: number;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  readBytes: 64_000,
  writeBytes: 1_000_000,
  listEntries: 500,
  downloadBytes: 50 * 1024 * 1024,
};

const HISTORY_DIRECTORY = ".openbot-history";
const MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024;

export type WorkspaceCheckpoint = {
  id: string;
  path: string;
  operation: "write" | "append" | "rollback";
  existed: boolean;
  beforeHash: string | null;
  afterHash: string;
  bytesBefore: number;
  createdAt: string;
};

export function createWorkspace(
  rootPath: string,
  limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS,
) {
  /**
   * Turn a Bot's requested path into a real one inside the workspace, or refuse.
   *
   * `forWrite` changes only which part of the path must already exist: a read resolves the file
   * itself, a write resolves the directory it would be created in.
   */
  async function resolvePath(
    requested: string,
    forWrite: boolean,
  ): Promise<string> {
    if (typeof requested !== "string" || !requested.trim()) {
      throw new WorkspacePathError("A file path is required.");
    }
    const wanted = requested.trim();

    if (wanted.split(/[\\/]/)[0] === HISTORY_DIRECTORY) {
      throw new WorkspacePathError(
        "OpenBot's checkpoint history is not a workspace path.",
      );
    }

    if (isAbsolute(wanted)) {
      throw new WorkspacePathError(
        "Use a path relative to your workspace, not an absolute one.",
      );
    }
    // Refused explicitly rather than left to the containment check, so the Bot is told what it did
    // wrong and can correct it, instead of receiving a generic denial it may retry verbatim.
    if (wanted.split(/[\\/]/).includes("..")) {
      throw new WorkspacePathError(
        "A file path may not contain '..'. You can only reach files inside your own workspace.",
      );
    }

    const root = await realpath(rootPath);
    const target = resolve(root, wanted);
    assertInside(root, target);

    // Layer three. Resolve what exists on disk and check again, because everything above
    // reasons about the path as text and a symlink makes the text a lie.
    const anchor = forWrite ? dirname(target) : target;
    let realAnchor: string;
    try {
      realAnchor = await realpath(anchor);
    } catch {
      if (!forWrite) {
        throw new WorkspaceFileError(`There is no file at ${wanted}.`);
      }
      // The parent directory does not exist yet. Walk up to the nearest one that does and verify it,
      // so a write into a new subdirectory is allowed but cannot be aimed through a symlink.
      realAnchor = await nearestExistingAncestor(root, anchor);
    }
    assertInside(root, realAnchor, wanted);

    // For a write, return the full lexical target. It is already proven contained lexically, and the
    // deepest existing directory is proven contained after symlinks, so `mkdir -p` can only create the
    // rest inside the workspace.
    return forWrite ? target : realAnchor;
  }

  return {
    resolvePath,

    /**
     * What is in the workspace.
     *
     * Recursive, because a Bot that saved `reports/august/summary.csv` needs to find it again, and a
     * listing that stops at the first level would show a `reports` directory and no way in. Bounded by
     * entry count for the same reason everything else here is bounded.
     */
    async list(requested = "."): Promise<{
      path: string;
      entries: WorkspaceEntry[];
      truncated: boolean;
    }> {
      const root = await realpath(rootPath);
      // "." and "" both mean the workspace itself, which `resolvePath` would reject as a bare relative
      // path with nothing in it. Anything else goes through the same confinement as a read.
      const start =
        requested === "." || requested.trim() === ""
          ? root
          : await resolvePath(requested, false);

      const info = await stat(start).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no folder at ${requested}.`);
      }
      if (!info.isDirectory()) {
        throw new WorkspaceFileError(`${requested} is a file, not a folder.`);
      }

      const entries: WorkspaceEntry[] = [];
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated) return;
        const found = await readdir(dir, { withFileTypes: true });
        for (const item of found) {
          // Checkpoint blobs are implementation data, not Bot files and never enter model context.
          if (dir === root && item.name === HISTORY_DIRECTORY) continue;
          if (entries.length >= limits.listEntries) {
            truncated = true;
            return;
          }
          const full = `${dir}/${item.name}`;
          // Relative to the workspace root, because that is the only form a Bot may name in a request.
          const shown = full.slice(root.length + 1);
          if (item.isDirectory()) {
            entries.push({ path: shown, kind: "folder" });
            await walk(full);
            continue;
          }
          if (!item.isFile()) continue;
          const size = await stat(full).catch(() => null);
          entries.push({
            path: shown,
            kind: "file",
            ...(size ? { bytes: size.size } : {}),
          });
        }
      };

      await walk(start);
      return { path: requested, entries, truncated };
    },

    /** Read a text file. Bounded, and it says when it gave you less than the whole thing. */
    async read(requested: string): Promise<{
      path: string;
      text: string;
      truncated: boolean;
      bytes: number;
    }> {
      const full = await resolvePath(requested, false);
      const info = await stat(full).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no file at ${requested}.`);
      }
      if (info.isDirectory()) {
        throw new WorkspaceFileError(
          `${requested} is a directory, not a file.`,
        );
      }

      const buffer = await readFile(full);
      const slice = buffer.subarray(0, limits.readBytes);
      return {
        path: requested,
        // Decoded as UTF-8. A binary file therefore comes back as replacement characters rather
        // than as a base64 blob nothing can read: this tool is for the notes, CSVs and JSON a Bot
        // actually works with, and pretending otherwise would invite it to try images.
        text: slice.toString("utf8"),
        truncated: buffer.byteLength > slice.byteLength,
        bytes: buffer.byteLength,
      };
    },

    /** Write a text file, creating parent directories inside the workspace as needed. */
    async write(
      requested: string,
      contents: string,
      options: { append?: boolean } = {},
    ): Promise<{
      path: string;
      bytes: number;
      appended: boolean;
      checkpointId: string;
    }> {
      if (typeof contents !== "string") {
        throw new WorkspaceFileError("The contents to write must be text.");
      }
      const bytes = Buffer.byteLength(contents, "utf8");
      if (bytes > limits.writeBytes) {
        throw new WorkspaceFileError(
          `That is ${bytes} bytes and the limit is ${limits.writeBytes}.`,
        );
      }

      const full = await resolvePath(requested, true);
      const checkpoint = await captureCheckpoint(
        rootPath,
        full,
        requested,
        options.append ? "append" : "write",
      );
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, {
        encoding: "utf8",
        flag: options.append ? "a" : "w",
      });
      await finishCheckpoint(rootPath, checkpoint, full);
      return {
        path: requested,
        bytes,
        appended: options.append === true,
        checkpointId: checkpoint.id,
      };
    },

    /** Recent pre-write checkpoints, newest first. Internal blobs never leave this process. */
    async checkpoints(requested?: string): Promise<{
      checkpoints: WorkspaceCheckpoint[];
    }> {
      if (requested) await resolvePath(requested, true);
      const manifests = await readCheckpointManifests(rootPath);
      return {
        checkpoints: manifests
          .filter((checkpoint) => !requested || checkpoint.path === requested)
          .slice(0, 100),
      };
    },

    /** Text comparison for one checkpoint, bounded by the ordinary read limit. */
    async checkpointDiff(
      checkpointId: string,
      expectedPath?: string,
    ): Promise<{
      checkpoint: WorkspaceCheckpoint;
      before: string;
      current: string;
      truncated: boolean;
      changedSinceWrite: boolean;
    }> {
      const checkpoint = await readCheckpoint(rootPath, checkpointId);
      if (expectedPath && checkpoint.path !== expectedPath) {
        throw new WorkspaceFileError(
          "That checkpoint does not belong to the requested file.",
        );
      }
      const full = await resolvePath(checkpoint.path, true);
      const beforeBuffer = checkpoint.existed
        ? await readFile(checkpointBlob(rootPath, checkpoint.id)).catch(() =>
            Buffer.alloc(0),
          )
        : Buffer.alloc(0);
      const currentBuffer = await readFile(full).catch(() => Buffer.alloc(0));
      const currentHash = await fileHash(full);
      return {
        checkpoint,
        before: beforeBuffer.subarray(0, limits.readBytes).toString("utf8"),
        current: currentBuffer.subarray(0, limits.readBytes).toString("utf8"),
        truncated:
          beforeBuffer.byteLength > limits.readBytes ||
          currentBuffer.byteLength > limits.readBytes,
        changedSinceWrite: currentHash !== checkpoint.afterHash,
      };
    },

    /**
     * Restore exactly one Bot-written file. A later human edit is preserved unless force is explicit.
     * The rollback itself gets a checkpoint, so the person can undo the undo.
     */
    async rollback(
      checkpointId: string,
      options: { force?: boolean } = {},
    ): Promise<{
      restored: true;
      path: string;
      checkpointId: string;
      undoCheckpointId: string;
    }> {
      const checkpoint = await readCheckpoint(rootPath, checkpointId);
      const full = await resolvePath(checkpoint.path, true);
      const currentHash = await fileHash(full);
      if (!options.force && currentHash !== checkpoint.afterHash) {
        throw new WorkspaceFileError(
          "That file changed after the Bot wrote it. Review the diff or explicitly force the rollback to avoid overwriting a person's work.",
        );
      }
      const inverse = await captureCheckpoint(
        rootPath,
        full,
        checkpoint.path,
        "rollback",
      );
      if (checkpoint.existed) {
        await mkdir(dirname(full), { recursive: true });
        await copyFile(checkpointBlob(rootPath, checkpoint.id), full);
      } else {
        await unlink(full).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      await finishCheckpoint(rootPath, inverse, full);
      return {
        restored: true,
        path: checkpoint.path,
        checkpointId,
        undoCheckpointId: inverse.id,
      };
    },

    /** Save a browser download without trusting its suggested path or overwriting an existing file. */
    async saveDownload(
      suggestedName: string,
      contents: Buffer,
    ): Promise<{ path: string; bytes: number }> {
      const limit = limits.downloadBytes ?? 50 * 1024 * 1024;
      if (contents.byteLength > limit) {
        throw new WorkspaceFileError(
          `That download is ${contents.byteLength} bytes and the limit is ${limit}.`,
        );
      }
      const raw = basename(suggestedName || "download");
      const safe =
        raw
          .replace(/[^A-Za-z0-9._ -]+/g, "_")
          .replace(/^\.+/, "")
          .slice(0, 180) || "download";
      const extension = extname(safe);
      const stem = safe.slice(0, safe.length - extension.length) || "download";

      for (let suffix = 0; suffix < 1_000; suffix += 1) {
        const name = suffix === 0 ? safe : `${stem} (${suffix})${extension}`;
        const requested = `downloads/${name}`;
        const full = await resolvePath(requested, true);
        await mkdir(dirname(full), { recursive: true });
        try {
          await writeFile(full, contents, { flag: "wx" });
          return { path: requested, bytes: contents.byteLength };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
      }
      throw new WorkspaceFileError(
        "That download name has too many existing copies.",
      );
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

type PendingCheckpoint = Omit<WorkspaceCheckpoint, "afterHash">;

async function captureCheckpoint(
  rootPath: string,
  full: string,
  requested: string,
  operation: WorkspaceCheckpoint["operation"],
): Promise<PendingCheckpoint> {
  const info = await stat(full).catch(() => null);
  if (info?.isDirectory()) {
    throw new WorkspaceFileError(`${requested} is a directory, not a file.`);
  }
  if (info && info.size > MAX_CHECKPOINT_BYTES) {
    throw new WorkspaceFileError(
      `That file is ${info.size} bytes, above the ${MAX_CHECKPOINT_BYTES}-byte checkpoint limit, so OpenBot will not overwrite it without a recovery point.`,
    );
  }
  const id = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  const directory = checkpointDirectory(rootPath);
  await mkdir(directory, { recursive: true });
  if (info) await copyFile(full, checkpointBlob(rootPath, id));
  return {
    id,
    path: requested,
    operation,
    existed: Boolean(info),
    beforeHash: info ? await fileHash(full) : null,
    bytesBefore: info?.size ?? 0,
    createdAt: new Date().toISOString(),
  };
}

async function finishCheckpoint(
  rootPath: string,
  checkpoint: PendingCheckpoint,
  full: string,
) {
  const complete: WorkspaceCheckpoint = {
    ...checkpoint,
    afterHash: await fileHash(full),
  };
  await writeFile(
    checkpointManifest(rootPath, checkpoint.id),
    JSON.stringify(complete),
    "utf8",
  );
}

async function readCheckpointManifests(rootPath: string) {
  const directory = checkpointDirectory(rootPath);
  const files = await readdir(directory).catch(() => []);
  const checkpoints = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return JSON.parse(
            await readFile(resolve(directory, file), "utf8"),
          ) as WorkspaceCheckpoint;
        } catch {
          return null;
        }
      }),
  );
  return checkpoints
    .filter((value): value is WorkspaceCheckpoint => Boolean(value))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function readCheckpoint(rootPath: string, checkpointId: string) {
  if (!/^[a-z0-9-]{20,100}$/i.test(checkpointId)) {
    throw new WorkspaceFileError("Checkpoint ID is invalid.");
  }
  try {
    return JSON.parse(
      await readFile(checkpointManifest(rootPath, checkpointId), "utf8"),
    ) as WorkspaceCheckpoint;
  } catch {
    throw new WorkspaceFileError("That checkpoint does not exist.");
  }
}

async function fileHash(full: string) {
  const contents = await readFile(full).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (contents === null) return "missing";
  const digest = await crypto.subtle.digest("SHA-256", contents);
  return Buffer.from(digest).toString("hex");
}

function checkpointDirectory(rootPath: string) {
  return resolve(rootPath, HISTORY_DIRECTORY, "checkpoints");
}

function checkpointManifest(rootPath: string, id: string) {
  return resolve(checkpointDirectory(rootPath), `${id}.json`);
}

function checkpointBlob(rootPath: string, id: string) {
  return resolve(checkpointDirectory(rootPath), `${id}.before`);
}

/** Containment, as a path comparison that cannot be fooled by a shared prefix. */
function assertInside(root: string, candidate: string, shown?: string): void {
  const rel = relative(root, candidate);
  // `relative` returns "" for the root itself, which is inside. It returns something starting with
  // ".." for anything outside, and an absolute path when the two are on different roots. Comparing
  // with startsWith on the raw strings instead would let "/workspace-evil" pass as "/workspace".
  const outside =
    rel !== "" &&
    (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  if (outside) {
    throw new WorkspacePathError(
      `${shown ?? candidate} is outside your workspace, so it cannot be reached.`,
    );
  }
}

/** The closest ancestor of `target` that exists, never above `root`. */
async function nearestExistingAncestor(
  root: string,
  target: string,
): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Ran out of path without finding anything. Only reachable if the root itself vanished.
        throw new WorkspacePathError("The workspace directory is missing.");
      }
      assertInside(root, parent);
      current = parent;
    }
  }
}
