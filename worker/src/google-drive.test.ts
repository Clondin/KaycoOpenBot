import { expect, test } from "bun:test";
import { createGoogleDriveAdapter } from "./google-drive";

test("Google Drive discovery exchanges a JWT and returns embedded ACL-aware chunks", async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----`;
  const requested: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    requested.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.hostname === "oauth2.googleapis.com") {
      expect(String(init?.body)).toContain(
        "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
      );
      return json({ access_token: "drive-token" });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer drive-token",
    );
    if (url.pathname.endsWith("/changes/startPageToken")) {
      return json({ startPageToken: "changes-1" });
    }
    if (
      url.pathname.endsWith("/files") &&
      url.searchParams.get("q")?.startsWith("name =")
    ) {
      return json({
        files: [
          {
            id: "root-1",
            name: "Policies",
            mimeType: "application/vnd.google-apps.folder",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/files")) {
      return json({
        files: [
          {
            id: "doc-1",
            name: "Security policy",
            mimeType: "text/plain",
            parents: ["root-1"],
            webViewLink: "https://drive.google.com/file/d/doc-1/view",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/files/doc-1/permissions")) {
      return json({
        permissions: [
          { type: "user", emailAddress: "Alice@Example.com" },
          { type: "group", emailAddress: "Risk@Example.com" },
          { type: "domain", domain: "Example.com" },
        ],
      });
    }
    if (url.pathname.endsWith("/files/doc-1")) {
      return new Response("Policy content for authorized readers.", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const adapter = createGoogleDriveAdapter({
    serviceAccountJson: JSON.stringify({
      client_email: "sync@example.test",
      private_key: privateKey,
    }),
    impersonationSubject: "admin@example.com",
    roots: ["Policies"],
    embed: async (texts) => texts.map(() => Array(1_536).fill(0.25)),
    fetchImpl,
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
  });

  const discovered = await adapter.discover({ cursor: null, mode: "sync" });
  expect(discovered.changes).toHaveLength(1);
  expect(discovered.nextCursor).toContain('"phase":"changes"');
  expect(discovered.changes[0]).toMatchObject({
    kind: "upsert",
    sourceId: "doc-1",
    title: "Security policy",
    canonicalUrl: "https://drive.google.com/file/d/doc-1/view",
    acls: [
      { principal: "user:alice@example.com", effect: "allow" },
      { principal: "group:risk@example.com", effect: "allow" },
      { principal: "group:domain:example.com", effect: "allow" },
    ],
  });
  const change = discovered.changes[0];
  if (change?.kind !== "upsert") throw new Error("Expected an upsert.");
  expect(change.chunks[0]?.content).toContain("Policy content");
  expect(change.chunks[0]?.embedding).toHaveLength(1_536);
  expect(requested).toContain("POST /token");
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
