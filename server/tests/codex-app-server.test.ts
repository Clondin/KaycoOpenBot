import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProcessManager } from "../src/codex/manager";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const home = await mkdtemp(join(tmpdir(), "openbot-codex-test-"));
const config = loadConfig({
  ...testEnvironment(),
  OPENBOT_CODEX_ENABLED: "true",
  CODEX_HOME_ROOT: home,
  CODEX_PROCESS_IDLE_MS: "10000",
});
if (!config.codex) throw new Error("Codex should be enabled for this test.");
const manager = new CodexProcessManager(config.codex);

afterAll(async () => {
  await manager.stopAll();
  await rm(home, { recursive: true, force: true });
});

describe("Codex App Server transport", () => {
  test("initializes the bundled App Server and reads an unconnected account", async () => {
    await expect(manager.account("user-one")).resolves.toEqual({
      account: null,
      requiresOpenaiAuth: true,
    });
  });

  test("uses a different credential home for every OpenBot user", async () => {
    await manager.account("user-two");
    const homes = await readdir(home, { withFileTypes: true });
    expect(homes.filter((entry) => entry.isDirectory())).toHaveLength(2);
    expect(homes.every((entry) => /^[a-f0-9]{64}$/.test(entry.name))).toBe(
      true,
    );
  });
});
