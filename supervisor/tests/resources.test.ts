import { describe, expect, test } from "bun:test";
import { optionalPositiveInteger } from "../src/resources";

describe("computer resource limits", () => {
  test("accepts a positive integer", () => {
    expect(
      optionalPositiveInteger(
        { COMPUTER_MEMORY_BYTES: " 3221225472 " },
        "COMPUTER_MEMORY_BYTES",
      ),
    ).toBe(3_221_225_472);
  });

  test("leaves an omitted limit unset", () => {
    expect(optionalPositiveInteger({}, "COMPUTER_NANO_CPUS")).toBeUndefined();
  });

  test("accepts a one-computer test-host limit", () => {
    expect(
      optionalPositiveInteger(
        { COMPUTER_MAX_RUNNING: "1" },
        "COMPUTER_MAX_RUNNING",
      ),
    ).toBe(1);
  });

  test.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects invalid limit %s",
    (value) => {
      expect(() =>
        optionalPositiveInteger(
          { COMPUTER_NANO_CPUS: value },
          "COMPUTER_NANO_CPUS",
        ),
      ).toThrow("COMPUTER_NANO_CPUS must be a positive integer");
    },
  );
});
