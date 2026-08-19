import { deploymentPreviewEnabled } from "./deployment-preview";

/**
 * The API can live on a separate origin from the Vercel app in a hosted deployment.
 *
 * Existing application code intentionally uses relative `/api/...` requests. Installing one adapter
 * here keeps that code same-origin by default while allowing the production build to point every API
 * request at the Hetzner gateway. The preview build remains entirely local and never reaches it.
 */
function configuredApiOrigin(): string | null {
  if (deploymentPreviewEnabled) return null;

  const configured = import.meta.env.VITE_OPENBOT_API_URL?.trim();
  if (!configured) return null;

  const parsed = new URL(configured);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("VITE_OPENBOT_API_URL must be an HTTP(S) URL.");
  }
  if (
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "VITE_OPENBOT_API_URL must be an origin without a path, query, or fragment.",
    );
  }

  return parsed.origin;
}

export const openbotApiOrigin = configuredApiOrigin();

export function apiUrl(path: string): string {
  if (!openbotApiOrigin) return path;
  return new URL(path, `${openbotApiOrigin}/`).toString();
}

export function apiWebSocketUrl(path: string): string {
  const url = new URL(apiUrl(path), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

/** Prefix same-origin `/api` fetches with the configured production API origin. */
export function installApiOrigin(): void {
  if (!openbotApiOrigin) return;

  const networkFetch = globalThis.fetch.bind(globalThis);
  const routedFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const source = new URL(requestUrl(input), window.location.origin);
    if (
      source.origin !== window.location.origin ||
      (source.pathname !== "/api" && !source.pathname.startsWith("/api/"))
    ) {
      return networkFetch(input, init);
    }

    const target = new URL(
      `${source.pathname}${source.search}${source.hash}`,
      `${openbotApiOrigin}/`,
    );
    if (input instanceof Request) {
      const routedRequest = new Request(target, input);
      return networkFetch(routedRequest, {
        ...init,
        credentials: init?.credentials ?? "include",
      });
    }

    return networkFetch(target, {
      ...init,
      credentials: init?.credentials ?? "include",
    });
  };

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: routedFetch,
    writable: true,
  });
}
