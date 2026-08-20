import { describe, expect, test } from "bun:test";
import {
  createEmbeddingClient,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
} from "../src/knowledge/embeddings";

describe("knowledge embeddings", () => {
  test("requests the schema's dimensions and preserves provider order", async () => {
    let request: Record<string, unknown> = {};
    const embed = createEmbeddingClient({
      apiKey: async () => "secret",
      fetchImpl: async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return Response.json({
          data: [
            {
              index: 1,
              embedding: Array(KNOWLEDGE_EMBEDDING_DIMENSIONS).fill(2),
            },
            {
              index: 0,
              embedding: Array(KNOWLEDGE_EMBEDDING_DIMENSIONS).fill(1),
            },
          ],
        });
      },
    });

    const result = await embed(["first", "second"]);
    expect(request.dimensions).toBe(KNOWLEDGE_EMBEDDING_DIMENSIONS);
    expect(result[0]?.[0]).toBe(1);
    expect(result[1]?.[0]).toBe(2);
  });

  test("fails closed on a dimension mismatch", async () => {
    const embed = createEmbeddingClient({
      apiKey: async () => "secret",
      fetchImpl: async () =>
        Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    });
    await expect(embed(["text"])).rejects.toThrow(/1536/);
  });
});
