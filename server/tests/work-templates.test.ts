import { describe, expect, test } from "bun:test";
import { WORK_TEMPLATES } from "../src/work/templates";

describe("work templates", () => {
  test("have stable unique identifiers and actionable instructions", () => {
    expect(new Set(WORK_TEMPLATES.map((template) => template.id)).size).toBe(
      WORK_TEMPLATES.length,
    );
    for (const template of WORK_TEMPLATES) {
      expect(template.title.length).toBeGreaterThan(5);
      expect(template.instruction.length).toBeGreaterThan(100);
      expect(template.integrationLabels.length).toBeGreaterThan(0);
      expect(["manual", "schedule", "webhook"]).toContain(template.trigger);
    }
  });

  test("makes approval boundaries explicit for cross-system recipes", () => {
    for (const template of WORK_TEMPLATES) {
      expect(template.instruction.toLowerCase()).toContain("approval");
    }
  });
});
