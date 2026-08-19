import { describe, expect, test } from "bun:test";
import { isTrustedWebSocketOrigin } from "../src/origin";

describe("WebSocket browser origin boundary", () => {
  const trustedOrigins = ["https://openbot.example.com"];

  test("allows the configured browser application", () => {
    const request = new Request(
      "https://api.openbot.example.com/api/channels/ws",
      {
        headers: { Origin: "https://openbot.example.com" },
      },
    );

    expect(isTrustedWebSocketOrigin(request, trustedOrigins)).toBe(true);
  });

  test("rejects an unconfigured browser application", () => {
    const request = new Request(
      "https://api.openbot.example.com/api/channels/ws",
      {
        headers: { Origin: "https://attacker.example" },
      },
    );

    expect(isTrustedWebSocketOrigin(request, trustedOrigins)).toBe(false);
  });

  test("rejects non-browser upgrades without an Origin header", () => {
    const request = new Request(
      "https://api.openbot.example.com/api/channels/ws",
    );

    expect(isTrustedWebSocketOrigin(request, trustedOrigins)).toBe(false);
  });
});
