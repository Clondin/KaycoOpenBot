import {
  CONNECTOR_API_VERSION,
  defineConnector,
  definePlugin,
  PLUGIN_API_VERSION,
} from "../src";

type HandbookConfig = {
  documents: Array<{ id: string; title: string; url: string; text: string }>;
};

const handbook = defineConnector<HandbookConfig>({
  manifest: {
    apiVersion: CONNECTOR_API_VERSION,
    id: "operations-handbook",
    name: "Operations handbook",
    version: "1.0.0",
    description: "Indexes a versioned set of operations handbook pages.",
    networkHosts: ["handbook.example.com"],
    capabilities: {
      incremental: false,
      deletions: false,
      sourceAcls: true,
    },
  },
  create: (configuration) => ({
    discover: async () => ({
      nextCursor: null,
      changes: configuration.documents.map((document) => ({
        kind: "upsert" as const,
        sourceId: document.id,
        title: document.title,
        canonicalUrl: document.url,
        contentHash: `${document.id}:${document.text.length}`,
        metadata: { source: "operations-handbook" },
        chunks: [{ position: 0, content: document.text, embedding: [] }],
        acls: [{ principal: "group:operations", effect: "allow" as const }],
      })),
    }),
  }),
});

export default definePlugin({
  manifest: {
    apiVersion: PLUGIN_API_VERSION,
    id: "operations-kit",
    name: "Operations kit",
    version: "1.0.0",
    description:
      "A reference OpenBot extension with knowledge and a reusable workflow skill.",
  },
  connectors: [handbook as never],
  skills: [
    {
      slug: "incident-brief",
      title: "Incident brief",
      summary: "Turn incident evidence into a concise, sourced handoff.",
      instructions:
        "Summarize the impact, timeline, evidence, open questions, owner, and next checkpoint. Do not invent missing facts.",
    },
  ],
});
