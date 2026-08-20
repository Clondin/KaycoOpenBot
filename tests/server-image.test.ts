import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("gives the native Codex client trusted HTTPS roots", () => {
  const dockerfile = readFileSync(
    join(import.meta.dir, "..", "server", "Dockerfile"),
    "utf8",
  );

  // Bun carries its own trust store, so ordinary fetch checks can pass even while the native Codex
  // binary cannot reach ChatGPT's device-auth endpoint.
  expect(dockerfile).toMatch(
    /apt-get install -y --no-install-recommends ca-certificates/,
  );
});
