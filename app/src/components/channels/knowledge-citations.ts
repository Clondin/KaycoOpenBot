import { asText } from "@/lib/plugins/tool-result";

export type KnowledgeCitation = {
  citation: number;
  title: string;
  url: string;
  excerpt: string;
  score: number;
};

/** Turn the server tool's JSON-string result into the evidence UI's safe presentation model. */
export function parseKnowledgeCitations(
  result: string,
): KnowledgeCitation[] | null {
  try {
    const parsed: unknown = JSON.parse(asText(result));
    if (!parsed || typeof parsed !== "object" || !("citations" in parsed)) {
      return null;
    }
    const citations = (parsed as { citations?: unknown }).citations;
    if (!Array.isArray(citations)) return null;
    return citations.flatMap((entry, index): KnowledgeCitation[] => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      if (
        typeof value.title !== "string" ||
        typeof value.excerpt !== "string"
      ) {
        return [];
      }
      return [
        {
          citation:
            typeof value.citation === "number" ? value.citation : index + 1,
          title: value.title,
          url: typeof value.url === "string" ? value.url : "",
          excerpt: value.excerpt,
          score: typeof value.score === "number" ? value.score : 0,
        },
      ];
    });
  } catch {
    return null;
  }
}
