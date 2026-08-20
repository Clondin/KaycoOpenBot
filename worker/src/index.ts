import { createDatabase } from "../../server/src/db/client";
import { startConnectorWorker } from "./runtime";

const databaseUrl = process.env.DATABASE_URL?.trim();
const encryptionKey = process.env.KEY_ENCRYPTION_KEY?.trim();
if (!databaseUrl || !encryptionKey) {
  throw new Error(
    "The connector worker requires DATABASE_URL and KEY_ENCRYPTION_KEY.",
  );
}

const database = createDatabase(databaseUrl);
const stop = startConnectorWorker({
  database,
  encryptionKey,
  intervalMs: numberSetting("CONNECTOR_POLL_MS", 10_000),
  successIntervalMs: numberSetting("CONNECTOR_SYNC_INTERVAL_MS", 300_000),
  failureRetryMs: numberSetting("CONNECTOR_RETRY_MS", 60_000),
});

console.info(JSON.stringify({ type: "connector-worker", status: "ready" }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop().finally(async () => {
      await database.$client.close();
      process.exit(0);
    });
  });
}

function numberSetting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
