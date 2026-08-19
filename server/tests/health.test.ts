import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

describe("health endpoint", () => {
  test("reports the server as healthy", async () => {
    const response = await app.request("http://openbot.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("runtime capabilities", () => {
  test("reports the Intelligence runtime without exposing configuration secrets", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "intelligence",
      durableHistory: true,
    });
  });

  // The runtime object holds the Intelligence API key and licence token. This endpoint has no
  // authentication, so a projection bug here publishes deployment secrets to anyone who asks.
  test("never serves the Intelligence credentials", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");
    const body = await response.text();
    const parsed = (await new Response(body).json()) as Record<string, unknown>;

    expect(body).not.toContain("tenant-api-key");
    expect(body).not.toContain("license-token");
    // The settings object itself must not be projected, whatever it happens to hold today.
    expect(Object.keys(parsed)).toEqual(["mode", "durableHistory"]);
  });
});

describe("browser origin boundary", () => {
  const corsApp = createApp(
    loadConfig({
      ...testEnvironment(),
      TRUSTED_ORIGINS: "https://openbot.example.com",
    }),
  );

  test("allows credentialed API requests from the configured app", async () => {
    const response = await corsApp.request(
      "http://openbot.local/api/capabilities",
      { headers: { Origin: "https://openbot.example.com" } },
    );

    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://openbot.example.com",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });

  test("does not authorize an unconfigured browser origin", async () => {
    const response = await corsApp.request(
      "http://openbot.local/api/capabilities",
      { headers: { Origin: "https://attacker.example" } },
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("preflights the headers used by the CopilotKit browser client", async () => {
    const response = await corsApp.request(
      "http://openbot.local/api/copilotkit",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://openbot.example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "content-type,x-copilotcloud-public-api-key,x-copilotkit-runtime-client-gql-version",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-CopilotKit-Runtime-Client-GQL-Version",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-CopilotKit-Runtime-Version",
    );
  });
});

describe("authentication availability", () => {
  test("fails loudly when Google authentication has not been configured", async () => {
    const response = await app.request(
      "http://openbot.local/api/auth/sign-in/social",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Google authentication is not configured.",
    });
  });

  test("forwards auth requests to the configured Better Auth handler", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response("mounted", { status: 204 }),
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/callback/google",
    );

    expect(response.status).toBe(204);
  });

  test("forwards logout requests to Better Auth", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => null,
        },
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/sign-out",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
  });
});
