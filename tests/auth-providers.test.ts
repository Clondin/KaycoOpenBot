import { describe, expect, test } from "bun:test";
import { applicationAuthProviders } from "../scripts/auth-providers";

describe("application auth providers", () => {
  test("uses the public provider list for a frontend-only deployment", () => {
    expect(
      applicationAuthProviders({ VITE_OPENBOT_AUTH_PROVIDERS: "google" }),
    ).toEqual(["google"]);
  });

  test("normalizes and deduplicates the public provider list", () => {
    expect(
      applicationAuthProviders({
        VITE_OPENBOT_AUTH_PROVIDERS: " Google,google ",
      }),
    ).toEqual(["google"]);
  });

  test("allows an explicitly unauthenticated frontend build", () => {
    expect(
      applicationAuthProviders({ VITE_OPENBOT_AUTH_PROVIDERS: "" }),
    ).toEqual([]);
  });

  test("rejects provider names the application cannot render", () => {
    expect(() =>
      applicationAuthProviders({
        VITE_OPENBOT_AUTH_PROVIDERS: "google,unknown",
      }),
    ).toThrow(
      "VITE_OPENBOT_AUTH_PROVIDERS contains an unsupported provider: unknown",
    );
  });

  test("preserves shared-environment Google configuration", () => {
    expect(
      applicationAuthProviders({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        BETTER_AUTH_SECRET: "auth-secret",
        BETTER_AUTH_URL: "http://localhost:3001",
      }),
    ).toEqual(["google"]);
  });
});
