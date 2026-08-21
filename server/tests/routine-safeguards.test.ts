import { describe, expect, test } from "bun:test";
import { routinePreflight } from "../src/work/routines";

describe("routine safeguards", () => {
  test("accepts pinned model and tool limits", () => {
    expect(
      routinePreflight({
        model: { provider: "openai", model: "gpt-5.4" },
        allowedTools: ["search", "create_ticket"],
      }),
    ).toEqual({ ok: true, message: "Preflight passed." });
  });

  test("requires an approved program reference for deterministic work", () => {
    expect(routinePreflight({ deterministic: true }).ok).toBe(false);
    expect(
      routinePreflight({ deterministic: true, toolProgramId: "program-id" }).ok,
    ).toBe(true);
  });

  test("rejects safeguards this runtime cannot actually enforce", () => {
    expect(routinePreflight({ maxCostCents: 500 }).ok).toBe(false);
    expect(routinePreflight({ requireApprovalForWrites: true }).ok).toBe(false);
    expect(routinePreflight({ allowedTools: "all" }).ok).toBe(false);
  });
});
