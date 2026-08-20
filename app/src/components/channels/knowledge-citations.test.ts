import { describe, expect, test } from "bun:test";
import { parseKnowledgeCitations } from "./knowledge-citations";

describe("knowledge citations", () => {
  test("unwraps the encoded tool result and keeps usable evidence", () => {
    const result = JSON.stringify(
      JSON.stringify({
        citations: [
          {
            citation: 3,
            title: "Quarterly plan",
            url: "https://example.com/plan",
            excerpt: "The launch is planned for October.",
            score: 0.91,
          },
        ],
      }),
    );

    expect(parseKnowledgeCitations(result)).toEqual([
      {
        citation: 3,
        title: "Quarterly plan",
        url: "https://example.com/plan",
        excerpt: "The launch is planned for October.",
        score: 0.91,
      },
    ]);
  });

  test("drops malformed entries without hiding valid sources", () => {
    const result = JSON.stringify({
      citations: [
        { title: "Missing excerpt" },
        { title: "Runbook", excerpt: "Escalate to the incident lead." },
      ],
    });

    expect(parseKnowledgeCitations(result)).toEqual([
      {
        citation: 2,
        title: "Runbook",
        url: "",
        excerpt: "Escalate to the incident lead.",
        score: 0,
      },
    ]);
  });

  test("reports an unreadable result instead of throwing", () => {
    expect(parseKnowledgeCitations("not-json")).toBeNull();
    expect(parseKnowledgeCitations(JSON.stringify({ other: [] }))).toBeNull();
  });
});
