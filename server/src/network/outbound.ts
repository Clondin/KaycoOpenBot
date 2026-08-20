import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkNavigationTarget } from "../computer/target";

export type AddressRecord = { address: string; family: number };
export type AddressResolver = (hostname: string) => Promise<AddressRecord[]>;

export type OutboundOptions = {
  allowPrivateHosts?: boolean;
  resolver?: AddressResolver;
};

export class OutboundRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRequestError";
  }
}

const defaultResolver: AddressResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Validate the supplied name and every address DNS currently gives that name. */
export async function assertOutboundUrl(
  raw: string | URL,
  options: OutboundOptions = {},
): Promise<URL> {
  const verdict = checkNavigationTarget(String(raw), {
    allowPrivateHosts: options.allowPrivateHosts,
  });
  if (!verdict.allowed) throw new OutboundRequestError(verdict.reason);

  const url = new URL(verdict.url);
  if (url.username || url.password) {
    throw new OutboundRequestError(
      "Credentials must be supplied through the credential vault, not embedded in an address.",
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return url;

  let addresses: AddressRecord[];
  try {
    addresses = await (options.resolver ?? defaultResolver)(hostname);
  } catch {
    throw new OutboundRequestError(
      "That hostname could not be resolved from this deployment.",
    );
  }
  if (addresses.length === 0) {
    throw new OutboundRequestError(
      "That hostname did not resolve to an address.",
    );
  }

  // Refuse a mixed public/private answer. This validation does not pin fetch's later DNS lookup, so
  // every answer in the set has to be safe for the network client to choose.
  for (const { address } of addresses) {
    const literal = isIP(address) === 6 ? `[${address}]` : address;
    const resolved = checkNavigationTarget(`https://${literal}/`, {
      allowPrivateHosts: options.allowPrivateHosts,
    });
    if (!resolved.allowed) {
      throw new OutboundRequestError(
        `That hostname resolves inside this deployment's network. ${resolved.reason}`,
      );
    }
  }
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
];

export type GuardedFetchOptions = OutboundOptions & {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
};

/** A fetch implementation that revalidates DNS on the first request and every redirect. */
export function createOutboundFetch(options: GuardedFetchOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maximum = Math.max(0, Math.min(options.maxRedirects ?? 3, 10));

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let target =
      input instanceof Request ? new URL(input.url) : new URL(String(input));
    let requestInit: RequestInit =
      input instanceof Request
        ? {
            method: input.method,
            headers: input.headers,
            body:
              input.method === "GET" || input.method === "HEAD"
                ? undefined
                : input.body,
            signal: input.signal,
            ...init,
          }
        : { ...init };

    for (let hop = 0; hop <= maximum; hop += 1) {
      target = await assertOutboundUrl(target, options);
      const response = await fetchImpl(target, {
        ...requestInit,
        redirect: "manual",
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (hop === maximum) {
        throw new OutboundRequestError(
          `That address redirected more than ${maximum} times without arriving anywhere.`,
        );
      }

      const next = new URL(location, target);
      try {
        await assertOutboundUrl(next, options);
      } catch (error) {
        if (error instanceof OutboundRequestError) {
          throw new OutboundRequestError(
            `That address redirected to ${next.toString()}, and ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}`,
          );
        }
        throw error;
      }
      if (next.origin !== target.origin) {
        const headers = new Headers(requestInit.headers);
        for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
        requestInit = { ...requestInit, headers };
      }
      await response.body?.cancel().catch(() => undefined);
      target = next;
    }

    throw new OutboundRequestError(
      "The outbound request could not be completed.",
    );
  };
}
