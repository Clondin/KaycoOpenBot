import { describe, expect, test } from "bun:test";
import { assertBrowserDestination, BrowserEgressError } from "./network";

describe("browser egress", () => {
  test("allows a public destination", async () => {
    await expect(
      assertBrowserDestination("https://example.test/", {
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).resolves.toBeUndefined();
  });

  test("refuses private DNS answers before Chromium requests them", async () => {
    for (const address of ["127.0.0.1", "10.0.0.8", "::1", "fd00::8"]) {
      await expect(
        assertBrowserDestination("https://public.example.test/", {
          resolver: async () => [
            { address, family: address.includes(":") ? 6 : 4 },
          ],
        }),
      ).rejects.toBeInstanceOf(BrowserEgressError);
    }
  });

  test("refuses dotted IPv4-mapped IPv6 DNS answers", async () => {
    await expect(
      assertBrowserDestination("https://public.example.test", {
        resolver: async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
      }),
    ).rejects.toThrow("inside the deployment network");
  });

  test("never allows cloud metadata", async () => {
    await expect(
      assertBrowserDestination("http://169.254.169.254/latest/meta-data", {
        allowPrivateHosts: true,
      }),
    ).rejects.toBeInstanceOf(BrowserEgressError);
  });

  test("allows private development services only after explicit opt-in", async () => {
    const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      assertBrowserDestination("http://devbox.example.test/", { resolver }),
    ).rejects.toBeInstanceOf(BrowserEgressError);
    await expect(
      assertBrowserDestination("http://devbox.example.test/", {
        resolver,
        allowPrivateHosts: true,
      }),
    ).resolves.toBeUndefined();
  });
});
