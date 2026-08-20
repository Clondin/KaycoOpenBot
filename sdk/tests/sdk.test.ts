import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_API_VERSION,
  ConnectorContractError,
  createConnectorHarness,
  defineConnector,
  definePlugin,
  PLUGIN_API_VERSION,
  validateConnectorBatch,
} from "../src";

describe("OpenBot connector SDK", () => {
  test("defines a versioned connector and freezes its reviewed manifest", () => {
    const connector = defineConnector({
      manifest: {
        apiVersion: CONNECTOR_API_VERSION,
        id: "company-handbook",
        name: "Company handbook",
        version: "1.0.0",
        description: "Indexes handbook pages.",
        networkHosts: ["handbook.example.com"],
        capabilities: {
          incremental: true,
          deletions: true,
          sourceAcls: true,
        },
      },
      create: () => ({
        discover: async () => ({ changes: [], nextCursor: "next" }),
      }),
    });

    expect(connector.manifest.id).toBe("company-handbook");
    expect(Object.isFrozen(connector.manifest)).toBe(true);
  });

  test("rejects an unsafe network wildcard", () => {
    expect(() =>
      defineConnector({
        manifest: {
          apiVersion: CONNECTOR_API_VERSION,
          id: "unsafe",
          name: "Unsafe",
          version: "1.0.0",
          description: "An invalid connector.",
          networkHosts: ["*.example.com"],
          capabilities: {
            incremental: false,
            deletions: false,
            sourceAcls: false,
          },
        },
        create: () => ({
          discover: async () => ({ changes: [], nextCursor: null }),
        }),
      }),
    ).toThrow(ConnectorContractError);
  });

  test("rejects duplicate source ids before persistence", () => {
    expect(() =>
      validateConnectorBatch({
        nextCursor: null,
        changes: [
          { kind: "delete", sourceId: "same" },
          { kind: "delete", sourceId: "same" },
        ],
      }),
    ).toThrow("appears more than once");
  });

  test("provides a framework-neutral determinism check", async () => {
    const harness = createConnectorHarness({
      discover: async ({ cursor }) => ({
        changes: [],
        nextCursor: cursor ?? "first",
      }),
    });

    await expect(harness.proveDeterministic()).resolves.toBeUndefined();
  });
});

describe("OpenBot plugin SDK", () => {
  test("packages declarative skills while keeping action tools on MCP", () => {
    const plugin = definePlugin({
      manifest: {
        apiVersion: PLUGIN_API_VERSION,
        id: "operations-kit",
        name: "Operations kit",
        version: "1.0.0",
        description: "Shared operations workflows.",
      },
      skills: [
        {
          slug: "incident-brief",
          title: "Incident brief",
          summary: "Prepare an evidence-backed handoff.",
          instructions: "Separate facts, inferences, owners, and next steps.",
        },
      ],
    });

    expect(plugin.skills?.[0]?.slug).toBe("incident-brief");
    expect(Object.isFrozen(plugin.skills)).toBe(true);
  });
});
