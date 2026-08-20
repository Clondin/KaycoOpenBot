import { describe, expect, test } from "bun:test";
import { runEvalSuite } from "../src/runner.ts";

describe("evaluation runner", () => {
  test("scores every case and reports latency percentiles", async () => {
    const report = await runEvalSuite({
      name: "numbers",
      cases: [
        { id: "one", input: 1, expected: 2 },
        { id: "two", input: 2, expected: 5 },
      ],
      execute: (value) => value * 2,
      grade: (output, expected) =>
        output === expected
          ? true
          : `Expected ${expected}, received ${output}.`,
    });

    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBe(0.5);
    expect(report.p50Ms).toBeGreaterThanOrEqual(0);
    expect(report.results[1]?.reason).toContain("Expected 5");
  });
});
