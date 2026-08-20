import { checkNavigationTarget } from "../computer/target";
import {
  type AddressResolver,
  createOutboundFetch,
  OutboundRequestError,
} from "../network/outbound";

/**
 * Where an external agent lives, and whether we are willing to talk to it.
 *
 * Registering an agent hands us a URL that this server will POST to on every single run. That is a
 * server-side request to an address a user chose,
 * which is the textbook shape of SSRF: without a check, `http://169.254.169.254/` is a registrable
 * "agent" and the runtime will happily fetch cloud credentials on a user's behalf, from inside the
 * deployment, on a schedule.
 *
 * Ordering is the control. If the private-host escape hatch is consulted before the
 * deny-list, the cloud metadata endpoint is reachable under the configuration every developer
 * actually runs. Never-allowed hosts are refused first, ahead of any opt-in, which is why this reuses
 * `checkNavigationTarget` rather than a second checker that would have to get the ordering right
 * again.
 *
 * A developer's own agent legitimately lives at
 * `http://localhost:4200/ag-ui`, so on a laptop the private-host opt-in is ON, which is the case where
 * this check is weakest. That is the same trade navigation makes, and the reason the never-allowed
 * list is checked ahead of it. In a hosted deployment the opt-in is off and a private address is
 * refused.
 */

export type EndpointVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

/**
 * Check an agent endpoint before it is stored.
 *
 * Refused at registration rather than at run time: a URL that must never be fetched should
 * never reach the database, because everything downstream treats a stored agent as trustworthy.
 */
export function checkAgentEndpoint(
  raw: unknown,
  options: { allowPrivateHosts?: boolean } = {},
): EndpointVerdict {
  if (typeof raw !== "string" || !raw.trim()) {
    return { allowed: false, reason: "An agent needs a web address." };
  }

  const verdict = checkNavigationTarget(raw.trim(), options);
  if (!verdict.allowed) {
    // The navigation wording talks about "the assistant opening" a page, which is not what is
    // happening here, so the reason is restated for the form surface.
    return {
      allowed: false,
      reason: verdict.reason.replace(
        /the assistant is never allowed to open it\.|the assistant is not allowed to open it\./,
        "an agent may not live there.",
      ),
    };
  }

  return { allowed: true, url: verdict.url };
}

/**
 * How many redirects an agent is allowed before we stop believing it has somewhere to be.
 *
 * Three, which covers the ordinary shapes (`http` to `https`, a host rename, a trailing-slash
 * canonicalisation) and stops a chain that has no end.
 */
const MAX_REDIRECTS = 3;

/** A redirect this deployment will not follow, named so the person registering sees which hop. */
export class EndpointRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointRedirectError";
  }
}

/**
 * `fetch`, with the endpoint check applied to every hop rather than only the address a person typed.
 *
 * Checking the URL once and then handing it to a fetch that follows redirects is a check with a hole
 * in it: `https://agent.example.com/ag-ui` passes, answers `307`, and the request lands wherever the
 * `Location` header says, which is how a registrable agent becomes a way to read the deployment's own
 * cloud metadata. The address that gets dialled is the one that must be allowed, and a redirect makes
 * those two different addresses.
 *
 * Redirects are followed rather than refused, because a deployment that puts its agent behind one has
 * done nothing wrong and `http` to `https` is the common case. Each destination goes through
 * {@link checkAgentEndpoint} first, so following one can only ever reach somewhere registering it
 * directly would have been allowed to reach.
 *
 * The method and body are carried across every hop. A browser turns a redirected `POST` into a `GET`;
 * doing that here would only ever produce a confusing "that is not an AG-UI endpoint" from an agent
 * that is one, because AG-UI is a POST protocol and this is a server talking to an API, not a person
 * following a link.
 */
export function createAgentFetch(
  options: {
    allowPrivateHosts?: boolean;
    fetchImpl?: typeof fetch;
    resolver?: AddressResolver;
  } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const guarded = createOutboundFetch({
    maxRedirects: MAX_REDIRECTS,
    ...(options.allowPrivateHosts !== undefined
      ? { allowPrivateHosts: options.allowPrivateHosts }
      : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.resolver
      ? { resolver: options.resolver }
      : options.fetchImpl
        ? {
            // A supplied fetch is a deterministic unit-test transport and opens no socket.
            resolver: async () => [{ address: "93.184.216.34", family: 4 }],
          }
        : {}),
  });

  return async function guardedFetch(url: string, init?: RequestInit) {
    try {
      return await guarded(url, init);
    } catch (error) {
      if (error instanceof OutboundRequestError) {
        throw new EndpointRedirectError(error.message);
      }
      throw error;
    }
  };
}
