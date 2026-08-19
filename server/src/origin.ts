/**
 * Browser WebSocket upgrades bypass Hono's CORS middleware, so they need the same origin boundary
 * applied explicitly before Bun upgrades the connection.
 */
export function isTrustedWebSocketOrigin(
  request: Request,
  trustedOrigins: readonly string[],
): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && trustedOrigins.includes(origin);
}
