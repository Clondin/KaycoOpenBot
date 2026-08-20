import {
  type ConnectorAdapter,
  type ConnectorBatch,
  validateConnectorBatch,
} from "./connector";

/** Framework-neutral contract harness; test it with Bun, Vitest, Jest, or Node. */
export function createConnectorHarness(
  adapter: ConnectorAdapter,
  options: { maxChanges?: number; maxChunksPerDocument?: number } = {},
) {
  return {
    async discover(
      cursor: string | null = null,
      mode: "sync" | "reconcile" = "sync",
    ): Promise<ConnectorBatch> {
      return validateConnectorBatch(
        await adapter.discover({ cursor, mode }),
        options,
      );
    },
    async proveDeterministic(cursor: string | null = null): Promise<void> {
      const first = await this.discover(cursor, "reconcile");
      const second = await this.discover(cursor, "reconcile");
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error(
          "A reconcile discovery must return the same batch for the same cursor and source state.",
        );
      }
    },
  };
}
