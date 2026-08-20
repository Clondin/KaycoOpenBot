import type {
  ConnectorAdapter,
  ConnectorChange,
  ConnectorUpsert,
} from "../../server/src/connectors/contract";
import type { EmbedTexts } from "../../server/src/knowledge/embeddings";
import {
  type AddressResolver,
  createOutboundFetch,
} from "../../server/src/network/outbound";

const DRIVE_API = "https://www.googleapis.com/drive/v3/";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_CHANGES = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  md5Checksum?: string;
  parents?: string[];
  trashed?: boolean;
};

type CrawlCursor = {
  phase: "crawl";
  startToken: string;
  roots: string[];
  folders: string[];
  folder?: string;
  pageToken?: string;
};
type ChangesCursor = { phase: "changes"; token: string; roots: string[] };
type DriveCursor = CrawlCursor | ChangesCursor;

export function createGoogleDriveAdapter(options: {
  serviceAccountJson: string;
  impersonationSubject: string;
  roots: string[];
  embed: EmbedTexts;
  fetchImpl?: typeof fetch;
  resolver?: AddressResolver;
}): ConnectorAdapter {
  const serviceAccount = parseServiceAccount(options.serviceAccountJson);
  const outbound = createOutboundFetch({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.resolver ? { resolver: options.resolver } : {}),
  });

  return {
    async discover({ cursor, signal }) {
      const token = await accessToken(
        serviceAccount,
        options.impersonationSubject,
        outbound,
        signal,
      );
      const drive = driveClient(token, outbound, signal);
      const state = cursor ? parseCursor(cursor) : null;
      if (!state) {
        const [roots, startToken] = await Promise.all([
          resolveRoots(drive, options.roots),
          drive.startPageToken(),
        ]);
        return crawl(drive, options.embed, {
          phase: "crawl",
          startToken,
          roots,
          folders: [...roots],
        });
      }
      return state.phase === "crawl"
        ? crawl(drive, options.embed, state)
        : changes(drive, options.embed, state);
    },
  };
}

async function crawl(
  drive: ReturnType<typeof driveClient>,
  embed: EmbedTexts,
  initial: CrawlCursor,
) {
  const state: CrawlCursor = structuredClone(initial);
  const found: ConnectorChange[] = [];
  while (found.length < MAX_CHANGES) {
    const folder = state.folder ?? state.folders.shift();
    if (!folder) {
      return {
        changes: found,
        nextCursor: JSON.stringify({
          phase: "changes",
          token: state.startToken,
          roots: state.roots,
        } satisfies ChangesCursor),
      };
    }
    const page = await drive.listFiles(
      `'${escapeQuery(folder)}' in parents and trashed = false`,
      state.pageToken,
      Math.max(1, Math.min(100, MAX_CHANGES - found.length)),
    );
    for (const file of page.files) {
      if (file.mimeType === FOLDER) {
        state.folders.push(file.id);
        continue;
      }
      const change = await upsertFor(drive, embed, file);
      if (change) found.push(change);
      if (found.length >= MAX_CHANGES) break;
    }
    if (page.nextPageToken && found.length < MAX_CHANGES) {
      state.folder = folder;
      state.pageToken = page.nextPageToken;
    } else if (page.nextPageToken) {
      state.folder = folder;
      state.pageToken = page.nextPageToken;
      break;
    } else {
      state.folder = undefined;
      state.pageToken = undefined;
    }
  }
  return { changes: found, nextCursor: JSON.stringify(state) };
}

async function changes(
  drive: ReturnType<typeof driveClient>,
  embed: EmbedTexts,
  state: ChangesCursor,
) {
  const page = await drive.listChanges(state.token);
  const discovered: ConnectorChange[] = [];
  for (const change of page.changes.slice(0, MAX_CHANGES)) {
    if (change.removed || change.file?.trashed) {
      discovered.push({ kind: "delete", sourceId: change.fileId });
      continue;
    }
    const file = change.file;
    if (
      !file ||
      file.mimeType === FOLDER ||
      !(await drive.isDescendant(file, new Set(state.roots)))
    ) {
      continue;
    }
    const upsert = await upsertFor(drive, embed, file);
    if (upsert) discovered.push(upsert);
  }
  return {
    changes: discovered,
    nextCursor: JSON.stringify({
      ...state,
      token: page.nextPageToken ?? page.newStartPageToken ?? state.token,
    }),
  };
}

async function upsertFor(
  drive: ReturnType<typeof driveClient>,
  embed: EmbedTexts,
  file: DriveFile,
): Promise<ConnectorUpsert | null> {
  const content = await drive.text(file);
  if (!content?.trim()) return null;
  const pieces = chunkText(content);
  const vectors: number[][] = [];
  for (let offset = 0; offset < pieces.length; offset += 64) {
    vectors.push(...(await embed(pieces.slice(offset, offset + 64))));
  }
  const acls = await drive.acls(file.id);
  return {
    kind: "upsert",
    sourceId: file.id,
    title: file.name,
    canonicalUrl:
      file.webViewLink ?? `https://drive.google.com/open?id=${file.id}`,
    contentHash: await sha256(content),
    metadata: {
      mimeType: file.mimeType,
      ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
      ...(file.md5Checksum ? { md5Checksum: file.md5Checksum } : {}),
    },
    chunks: pieces.map((piece, position) => ({
      position,
      content: piece,
      embedding: vectors[position] as number[],
    })),
    acls,
  };
}

function driveClient(
  token: string,
  outbound: ReturnType<typeof createOutboundFetch>,
  signal?: AbortSignal,
) {
  const request = async <T>(path: string, query: Record<string, string>) => {
    const url = new URL(path, DRIVE_API);
    for (const [name, value] of Object.entries(query)) {
      if (value) url.searchParams.set(name, value);
    }
    const response = await outbound(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Google Drive answered ${response.status} for ${path}.`);
    }
    return (await response.json()) as T;
  };

  const fileFields =
    "id,name,mimeType,modifiedTime,webViewLink,md5Checksum,parents,trashed";
  return {
    async startPageToken() {
      const body = await request<{ startPageToken: string }>(
        "changes/startPageToken",
        { supportsAllDrives: "true" },
      );
      return body.startPageToken;
    },
    async listFiles(q: string, pageToken?: string, pageSize = 100) {
      return request<{ files: DriveFile[]; nextPageToken?: string }>("files", {
        q,
        pageSize: String(Math.max(1, Math.min(pageSize, 100))),
        fields: `nextPageToken,files(${fileFields})`,
        spaces: "drive",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
    },
    async getFile(id: string) {
      return request<DriveFile>(`files/${encodeURIComponent(id)}`, {
        fields: fileFields,
        supportsAllDrives: "true",
      });
    },
    async listChanges(pageToken: string) {
      return request<{
        changes: Array<{
          fileId: string;
          removed?: boolean;
          file?: DriveFile;
        }>;
        nextPageToken?: string;
        newStartPageToken?: string;
      }>("changes", {
        pageToken,
        pageSize: String(MAX_CHANGES),
        spaces: "drive",
        includeRemoved: "true",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${fileFields}))`,
      });
    },
    async isDescendant(file: DriveFile, roots: Set<string>) {
      let parents = file.parents ?? [];
      const visited = new Set<string>();
      for (let depth = 0; depth < 30 && parents.length; depth += 1) {
        if (parents.some((parent) => roots.has(parent))) return true;
        const unseen = parents.filter((parent) => !visited.has(parent));
        for (const parent of unseen) visited.add(parent);
        const records = await Promise.all(unseen.map((id) => this.getFile(id)));
        parents = records.flatMap((parent) => parent.parents ?? []);
      }
      return false;
    },
    async text(file: DriveFile) {
      const exportType = exportMime(file.mimeType);
      const url = exportType
        ? new URL(`files/${encodeURIComponent(file.id)}/export`, DRIVE_API)
        : new URL(`files/${encodeURIComponent(file.id)}`, DRIVE_API);
      if (exportType) url.searchParams.set("mimeType", exportType);
      else url.searchParams.set("alt", "media");
      url.searchParams.set("supportsAllDrives", "true");
      if (!exportType && !isTextMime(file.mimeType)) return null;
      const response = await outbound(url, {
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) return null;
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_FILE_BYTES) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_FILE_BYTES) return null;
      return new TextDecoder().decode(bytes).replace(/\0/g, "");
    },
    async acls(fileId: string) {
      const body = await request<{
        permissions: Array<{
          type?: string;
          emailAddress?: string;
          domain?: string;
          deleted?: boolean;
        }>;
      }>(`files/${encodeURIComponent(fileId)}/permissions`, {
        fields: "permissions(type,emailAddress,domain,deleted)",
        supportsAllDrives: "true",
      });
      return body.permissions.flatMap((permission) => {
        if (permission.deleted) return [];
        const email = permission.emailAddress?.toLowerCase();
        if (permission.type === "user" && email) {
          return [{ principal: `user:${email}`, effect: "allow" as const }];
        }
        if (permission.type === "group" && email) {
          return [{ principal: `group:${email}`, effect: "allow" as const }];
        }
        if (permission.type === "domain" && permission.domain) {
          return [
            {
              principal: `group:domain:${permission.domain.toLowerCase()}`,
              effect: "allow" as const,
            },
          ];
        }
        if (permission.type === "anyone") {
          return [{ principal: "group:*", effect: "allow" as const }];
        }
        return [];
      });
    },
  };
}

async function resolveRoots(
  drive: ReturnType<typeof driveClient>,
  configured: string[],
) {
  const resolved: string[] = [];
  for (const root of configured) {
    if (root.startsWith("id:")) {
      const file = await drive.getFile(root.slice(3));
      if (file.mimeType === FOLDER) resolved.push(file.id);
      continue;
    }
    const result = await drive.listFiles(
      `name = '${escapeQuery(root)}' and mimeType = '${FOLDER}' and trashed = false`,
    );
    resolved.push(...result.files.map((file) => file.id));
  }
  if (resolved.length === 0) {
    throw new Error("None of the configured Google Drive roots were found.");
  }
  return [...new Set(resolved)];
}

async function accessToken(
  account: ServiceAccount,
  subject: string,
  outbound: ReturnType<typeof createOutboundFetch>,
  signal?: AbortSignal,
) {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  if (new URL(tokenUri).origin !== "https://oauth2.googleapis.com") {
    throw new Error("The service account token endpoint is not Google OAuth.");
  }
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      sub: subject,
      scope: DRIVE_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3_600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const response = await outbound(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}`,
    }),
    signal,
  });
  if (!response.ok)
    throw new Error(`Google OAuth answered ${response.status}.`);
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") {
    throw new Error("Google OAuth returned no access token.");
  }
  return body.access_token;
}

function parseServiceAccount(raw: string): ServiceAccount {
  let value: Partial<ServiceAccount>;
  try {
    value = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch {
    throw new Error("The Google service account credential is not JSON.");
  }
  if (!value.client_email || !value.private_key) {
    throw new Error(
      "The Google service account is missing its email or private key.",
    );
  }
  return value as ServiceAccount;
}

function parseCursor(raw: string): DriveCursor {
  try {
    const value = JSON.parse(raw) as DriveCursor;
    if (value.phase === "crawl" || value.phase === "changes") return value;
  } catch {}
  throw new Error("The Google Drive sync cursor is invalid.");
}

function chunkText(raw: string) {
  const text = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chunks: string[] = [];
  const size = 1_500;
  const overlap = 200;
  for (let start = 0; start < text.length; start += size - overlap) {
    const chunk = text.slice(start, start + size).trim();
    if (chunk) chunks.push(chunk);
    if (start + size >= text.length) break;
  }
  return chunks.slice(0, 2_000);
}

function exportMime(mime: string) {
  if (mime === "application/vnd.google-apps.document") return "text/plain";
  if (mime === "application/vnd.google-apps.spreadsheet") return "text/csv";
  return null;
}

function isTextMime(mime: string) {
  return (
    mime.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(
      mime,
    )
  );
}

function pemBytes(pem: string) {
  const base64 = pem.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    "",
  );
  return Buffer.from(base64, "base64");
}

function base64Url(value: string | Uint8Array) {
  return Buffer.from(
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  )
    .toString("base64url")
    .replace(/=+$/, "");
}

function escapeQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function sha256(value: string) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}
