import { describe, expect, test } from "bun:test";
import { parseContextReferences } from "../src/lib/continuity/context-references";

describe("context references", () => {
  test("parses quoted paths, results, and URLs", () => {
    expect(
      parseContextReferences(
        'Compare @file:"reports/Q3 plan.md" with @diff:notes.md and @result:abc @url:https://example.com/a',
      ),
    ).toEqual([
      { kind: "file", value: "reports/Q3 plan.md" },
      { kind: "diff", value: "notes.md" },
      { kind: "result", value: "abc" },
      { kind: "url", value: "https://example.com/a" },
    ]);
  });

  test("deduplicates references and caps the context fanout", () => {
    const text = [
      "@file:a",
      "@file:a",
      ...Array.from({ length: 12 }, (_, index) => `@folder:f${index}`),
    ].join(" ");
    expect(parseContextReferences(text)).toHaveLength(8);
  });
});
