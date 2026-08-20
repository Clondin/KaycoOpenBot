import type { AddressResolver } from "../network/outbound";
import { createOutboundFetch } from "../network/outbound";

export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;
const MAX_EMBEDDING_INPUTS = 64;
const MAX_INPUT_CODE_POINTS = 12_000;

export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

/** OpenAI-compatible embeddings with fixed dimensions matching the database schema. */
export function createEmbeddingClient(options: {
  apiKey: () => Promise<string | null>;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  resolver?: AddressResolver;
}): EmbedTexts {
  const endpoint = new URL(
    "embeddings",
    `${options.baseUrl?.replace(/\/$/, "") ?? "https://api.openai.com/v1"}/`,
  );
  const guardedFetch = createOutboundFetch({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.resolver
      ? { resolver: options.resolver }
      : options.fetchImpl
        ? { resolver: async () => [{ address: "93.184.216.34", family: 4 }] }
        : {}),
  });

  return async (texts) => {
    if (texts.length === 0) return [];
    if (texts.length > MAX_EMBEDDING_INPUTS) {
      throw new Error(
        `An embedding batch may contain at most ${MAX_EMBEDDING_INPUTS} inputs.`,
      );
    }
    const apiKey = await options.apiKey();
    if (!apiKey) {
      throw new Error(
        "Knowledge indexing needs EMBEDDING_API_KEY or an OpenAI model credential.",
      );
    }
    const response = await guardedFetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? "text-embedding-3-small",
        input: texts.map((text) =>
          Array.from(text).slice(0, MAX_INPUT_CODE_POINTS).join(""),
        ),
        dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`The embedding provider answered ${response.status}.`);
    }
    const body = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: unknown }>;
    };
    const ordered = [...(body.data ?? [])].sort(
      (left, right) => Number(left.index ?? 0) - Number(right.index ?? 0),
    );
    if (ordered.length !== texts.length) {
      throw new Error("The embedding provider returned an incomplete batch.");
    }
    return ordered.map((item) => {
      if (
        !Array.isArray(item.embedding) ||
        item.embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
        item.embedding.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        )
      ) {
        throw new Error(
          `The embedding provider must return ${KNOWLEDGE_EMBEDDING_DIMENSIONS} finite values per input.`,
        );
      }
      return item.embedding as number[];
    });
  };
}
