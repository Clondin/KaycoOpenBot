import { describe, expect, test } from "bun:test";
import {
  assertOutboundUrl,
  createOutboundFetch,
  OutboundRequestError,
} from "../src/network/outbound";

describe("outbound network policy", () => {
  test("accepts a hostname only when every DNS answer is public", async () => {
    const url = await assertOutboundUrl("https://api.example.test/mcp", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700::1111", family: 6 },
      ],
    });
    expect(url.toString()).toBe("https://api.example.test/mcp");
  });

  test("refuses DNS rebinding answers into loopback or RFC1918 space", async () => {
    for (const address of ["127.0.0.1", "10.0.0.7", "::1", "fd00::7"]) {
      await expect(
        assertOutboundUrl("https://public-looking.example.test/mcp", {
          resolver: async () => [
            { address: "93.184.216.34", family: 4 },
            { address, family: address.includes(":") ? 6 : 4 },
          ],
        }),
      ).rejects.toBeInstanceOf(OutboundRequestError);
    }
  });

  test("refuses non-public carrier, benchmark, and reserved DNS answers", async () => {
    for (const address of [
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "ff02::1",
    ]) {
      await expect(
        assertOutboundUrl("https://public.example.test", {
          resolver: async () => [
            { address, family: address.includes(":") ? 6 : 4 },
          ],
        }),
      ).rejects.toThrow("inside this deployment's network");
    }
  });

  test("metadata stays forbidden even when development allows private hosts", async () => {
    await expect(
      assertOutboundUrl("https://friendly.example.test/", {
        allowPrivateHosts: true,
        resolver: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(OutboundRequestError);
  });

  test("validates a redirect before the second address is fetched", async () => {
    const fetched: string[] = [];
    const guarded = createOutboundFetch({
      resolver: async (hostname) => [
        {
          address:
            hostname === "safe.example.test" ? "93.184.216.34" : "127.0.0.1",
          family: 4,
        },
      ],
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return new Response(null, {
          status: 307,
          headers: { location: "https://rebound.example.test/private" },
        });
      },
    });

    await expect(guarded("https://safe.example.test/mcp")).rejects.toThrow(
      /redirected/i,
    );
    expect(fetched).toEqual(["https://safe.example.test/mcp"]);
  });

  test("does not forward bearer credentials across origins", async () => {
    const authorizations: Array<string | null> = [];
    const guarded = createOutboundFetch({
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return authorizations.length === 1
          ? new Response(null, {
              status: 307,
              headers: { location: "https://canonical.example.test/mcp" },
            })
          : new Response("ok");
      },
    });

    await guarded("https://start.example.test/mcp", {
      headers: { authorization: "Bearer secret" },
    });
    expect(authorizations).toEqual(["Bearer secret", null]);
  });
});
