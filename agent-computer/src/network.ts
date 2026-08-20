import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BrowserContext } from "playwright";

export type BrowserAddressResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const METADATA_NAMES = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "fd00:ec2::254",
]);

export class BrowserEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserEgressError";
  }
}

/** Validate the literal destination and every DNS answer before Chromium opens the request. */
export async function assertBrowserDestination(
  raw: string,
  options: {
    allowPrivateHosts?: boolean;
    resolver?: BrowserAddressResolver;
  } = {},
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserEgressError("The browser request is not a valid URL.");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    // data:, blob: and about: never dial a host. Other schemes are not browser network requests.
    if (["about:", "blob:", "data:"].includes(url.protocol)) return;
    throw new BrowserEgressError(
      "Only web destinations may leave the browser.",
    );
  }
  if (url.username || url.password) {
    throw new BrowserEgressError("Credentials may not be embedded in a URL.");
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (METADATA_NAMES.has(hostname)) {
    throw new BrowserEgressError(
      "Cloud metadata is never a browser destination.",
    );
  }
  if (isIP(hostname)) {
    if (!options.allowPrivateHosts && isPrivateAddress(hostname)) {
      throw new BrowserEgressError(
        "That address is inside the deployment network.",
      );
    }
    return;
  }
  if (
    !options.allowPrivateHosts &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".local") ||
      !hostname.includes("."))
  ) {
    throw new BrowserEgressError(
      "That hostname is inside the deployment network.",
    );
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (options.resolver ?? resolveAddresses)(hostname);
  } catch {
    throw new BrowserEgressError(
      "The browser destination could not be resolved.",
    );
  }
  if (addresses.length === 0) {
    throw new BrowserEgressError("The browser destination did not resolve.");
  }
  for (const { address } of addresses) {
    if (METADATA_NAMES.has(address.toLowerCase())) {
      throw new BrowserEgressError(
        "Cloud metadata is never a browser destination.",
      );
    }
    if (!options.allowPrivateHosts && isPrivateAddress(address)) {
      throw new BrowserEgressError(
        "That hostname resolves inside the deployment network.",
      );
    }
  }
}

const resolveAddresses: BrowserAddressResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Intercept navigations, redirects, frames, subresources and WebSocket handshakes. */
export async function installBrowserNetworkGuard(
  context: BrowserContext,
  allowPrivateHosts: boolean,
) {
  await context.route("**/*", async (route) => {
    try {
      await assertBrowserDestination(route.request().url(), {
        allowPrivateHosts,
      });
      await route.continue();
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "browser-egress-refused",
          url: safeUrl(route.request().url()),
          reason:
            error instanceof Error ? error.message : "Destination refused.",
        }),
      );
      await route.abort("blockedbyclient");
    }
  });
  await context.routeWebSocket(/.*/, async (socket) => {
    try {
      await assertBrowserDestination(socket.url(), { allowPrivateHosts });
      socket.connectToServer();
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "browser-websocket-egress-refused",
          url: safeUrl(socket.url()),
          reason:
            error instanceof Error ? error.message : "Destination refused.",
        }),
      );
      await socket.close({ code: 1008, reason: "Destination refused" });
    }
  });
}

function isPrivateAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(normalized) !== 6) return true;
  const groups = expandIpv6(normalized);
  if (!groups) return true;
  const embedded = embeddedIpv4(groups);
  if (embedded) return isPrivateAddress(embedded);
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }
  const first = groups[0] ?? 0;
  return (
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xfe80 && first <= 0xfebf) ||
    first >= 0xff00
  );
}

function expandIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => parseIpv6Groups(part);
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1) return head.length === 8 ? head : null;
  return missing >= 0 ? [...head, ...Array(missing).fill(0), ...tail] : null;
}

function parseIpv6Groups(part: string): number[] | null {
  if (!part) return [];
  const raw = part.split(":");
  const dotted = raw.at(-1);
  if (dotted?.includes(".")) {
    const octets = dotted.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 255,
      )
    ) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    raw.splice(
      raw.length - 1,
      1,
      (a * 256 + b).toString(16),
      (c * 256 + d).toString(16),
    );
  }
  if (raw.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return raw.map((group) => Number.parseInt(group, 16));
}

function embeddedIpv4(groups: number[]) {
  const [a, b, c, d, e, f, high = 0, low = 0] = groups;
  const zeros = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  const mapped = zeros && f === 0xffff;
  const compatible = zeros && f === 0;
  const nat64 =
    a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;
  if (!mapped && !compatible && !nat64) return null;
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function safeUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString().slice(0, 500);
  } catch {
    return "unparseable";
  }
}
