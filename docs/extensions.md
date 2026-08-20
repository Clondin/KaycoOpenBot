# Extensions

OpenBot has three deliberately different extension surfaces:

- **MCP servers** add tools that read or change external systems. Their calls keep using OpenBot's grants, action policy, approvals, credential vault, and audit trail.
- **Skills** add reusable instructions without adding authority.
- **Connectors** ingest knowledge into the document, chunk, and ACL model.

`@openbot/sdk` is the source contract for skills and connectors. It is framework-neutral TypeScript and does not require React, Hono, CopilotKit, or a particular test runner.

## Build a connector

Use `defineConnector` with the current `CONNECTOR_API_VERSION`. Manifests use stable lowercase ids, semantic versions, exact outbound hostnames, and explicit capabilities.

```ts
import { CONNECTOR_API_VERSION, defineConnector } from "@openbot/sdk";

export default defineConnector<{ token: string }>({
  manifest: {
    apiVersion: CONNECTOR_API_VERSION,
    id: "company-handbook",
    name: "Company handbook",
    version: "1.0.0",
    description: "Indexes handbook pages and their source ACLs.",
    networkHosts: ["handbook.example.com"],
    capabilities: {
      incremental: true,
      deletions: true,
      sourceAcls: true,
    },
  },
  create: ({ token }) => ({
    discover: async ({ cursor, mode, signal }) => {
      // Fetch one bounded batch. Never log token. Honor signal.
      return { changes: [], nextCursor: cursor };
    },
  }),
});
```

The worker validates every batch before persistence. It rejects oversized batches, duplicate source ids, invalid URLs, duplicate chunk positions, non-finite embeddings, empty chunks, malformed ACLs, and oversized cursors.

Use `createConnectorHarness` in any test framework to validate discovery output and prove reconcile discovery is deterministic for a stable source state.

## Build a plugin bundle

`definePlugin` packages skills and connector definitions behind a versioned manifest. It does not load arbitrary in-process action code. Add external tools through an MCP server so a plugin cannot bypass server-side authorization.

The complete reference is in `sdk/examples/operations-kit.ts`.

## Compatibility

The date-stamped API versions are checked at definition time. Adding optional fields is backwards compatible. Removing or changing an existing field requires a new API version and a migration guide. Package versions continue to use semantic versioning.
