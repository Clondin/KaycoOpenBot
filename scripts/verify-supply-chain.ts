import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const ignoredDirectories = new Set([".git", ".turbo", "dist", "node_modules"]);
const problems: string[] = [];

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : filesBelow(fullPath);
      }
      return [fullPath];
    }),
  );
  return nested.flat();
}

function relative(file: string) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

const workflowDirectory = path.join(repositoryRoot, ".github", "workflows");
for (const file of (await filesBelow(workflowDirectory)).filter((entry) =>
  /\.ya?ml$/i.test(entry),
)) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    const action = /^\s*-?\s*uses:\s*["']?([^\s"'#]+)/.exec(line)?.[1];
    if (!action || action.startsWith("./")) return;
    const ref = action.slice(action.lastIndexOf("@") + 1);
    if (!/^[0-9a-f]{40}$/i.test(ref)) {
      problems.push(
        `${relative(file)}:${index + 1} must pin ${action} to a full commit SHA.`,
      );
    }
  });
}

for (const file of (await filesBelow(repositoryRoot)).filter((entry) =>
  /(^|[\\/])Dockerfile(?:\..+)?$/.test(entry),
)) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    const source = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line)?.[1];
    if (!source || source === "scratch" || source.includes("${")) return;
    const lastSlash = source.lastIndexOf("/");
    const tag = source.indexOf(":", lastSlash + 1);
    const digest = source.indexOf("@sha256:");
    if (tag < 0 && digest < 0) {
      problems.push(
        `${relative(file)}:${index + 1} must use a versioned image tag or digest.`,
      );
    } else if (source.slice(tag + 1).toLowerCase() === "latest") {
      problems.push(`${relative(file)}:${index + 1} must not use :latest.`);
    }
  });
}

await access(path.join(repositoryRoot, "bun.lock")).catch(() =>
  problems.push("bun.lock is required for reproducible installs."),
);

const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
) as { patchedDependencies?: Record<string, string> };
for (const [dependency, patchFile] of Object.entries(
  packageJson.patchedDependencies ?? {},
)) {
  await access(path.join(repositoryRoot, patchFile)).catch(() =>
    problems.push(`The patch for ${dependency} is missing: ${patchFile}`),
  );
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}

console.log(
  "Supply-chain policy passed: actions are SHA-pinned, containers are versioned, and lock/patch files exist.",
);
