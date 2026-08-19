import { describe, expect, test } from "bun:test";
import { hasComputerCapacity } from "../src/capacity";

describe("running computer capacity", () => {
  test("allows the only computer on a single-user host", () => {
    expect(hasComputerCapacity("bot-a", [], 1)).toBe(true);
  });

  test("allows re-ensuring the computer that already owns the slot", () => {
    expect(
      hasComputerCapacity("bot-a", [{ botId: "bot-a", status: "running" }], 1),
    ).toBe(true);
  });

  test("blocks a second running computer on a single-user host", () => {
    expect(
      hasComputerCapacity("bot-b", [{ botId: "bot-a", status: "running" }], 1),
    ).toBe(false);
  });

  test("stopped computers retain profiles without occupying a slot", () => {
    expect(
      hasComputerCapacity("bot-b", [{ botId: "bot-a", status: "exited" }], 1),
    ).toBe(true);
  });
});
