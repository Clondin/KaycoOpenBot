/** Resolve the documented API port, retaining PORT as the legacy fallback. */
export function resolveListenPort(
  environment: Record<string, string | undefined> = process.env,
): number {
  const raw =
    environment.SERVER_PORT?.trim() || environment.PORT?.trim() || "3001";
  return Number.parseInt(raw, 10);
}
