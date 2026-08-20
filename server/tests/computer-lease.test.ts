import { describe, expect, test } from "bun:test";
import { createLeasedSupervisor } from "../src/computer/lease";
import type { SupervisorClient } from "../src/computer/supervisor";

function fakeSupervisor(locate: (botId: string) => Promise<string>) {
  return {
    locate,
    stop: async () => undefined,
    reset: async () => undefined,
    list: async () => [],
  } as SupervisorClient;
}

describe("computer address leases", () => {
  test("reuses a location until its lease expires", async () => {
    let calls = 0;
    let time = 1_000;
    const leased = createLeasedSupervisor(
      fakeSupervisor(async () => `http://computer:${++calls}`),
      { ttlMs: 100, now: () => time },
    );

    expect(await leased.locate("sales")).toBe("http://computer:1");
    expect(await leased.locate("sales")).toBe("http://computer:1");
    time += 101;
    expect(await leased.locate("sales")).toBe("http://computer:2");
  });

  test("deduplicates simultaneous cold starts", async () => {
    let release: ((url: string) => void) | undefined;
    let calls = 0;
    const located = new Promise<string>((resolve) => {
      release = resolve;
    });
    const leased = createLeasedSupervisor(
      fakeSupervisor(async () => {
        calls += 1;
        return located;
      }),
    );

    const first = leased.locate("sales");
    const second = leased.locate("sales");
    release?.("http://computer:4100");
    expect(await Promise.all([first, second])).toEqual([
      "http://computer:4100",
      "http://computer:4100",
    ]);
    expect(calls).toBe(1);
  });

  test("stop and reset invalidate the address immediately", async () => {
    let calls = 0;
    const underlying = fakeSupervisor(async () => `http://computer:${++calls}`);
    const leased = createLeasedSupervisor(underlying);

    await leased.locate("sales");
    await leased.stop("sales");
    expect(await leased.locate("sales")).toBe("http://computer:2");
    await leased.reset("sales");
    expect(await leased.locate("sales")).toBe("http://computer:3");
  });
});
