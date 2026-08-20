import { expect, test } from "bun:test";
import { join } from "node:path";

test("an idle connector worker stays alive until it is stopped", async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "index.ts")],
    {
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        CONNECTOR_POLL_MS: "1000",
        DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:1/openbot",
        KEY_ENCRYPTION_KEY: "test-only-worker-key",
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  try {
    await Bun.sleep(1_500);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await child.exited;
  }
});
