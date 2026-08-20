import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { testAgentConnection } from "../src/agents/connection-test";

/**
 * The connection test, against something that really speaks AG-UI.
 *
 * Uses a real AG-UI mock rather than a stubbed fetch. The other tests for this hand it a function that returns a hand-written
 * SSE body, which proves the parsing and nothing about the protocol: every one of them would still
 * pass if AG-UI changed its wire format underneath us, or if we had misread it in the first place.
 * The whole promise is that somebody else's agent works if it speaks this protocol, so the
 * test that matters is one where an implementation we did not write answers.
 *
 * `@copilotkit/aimock` is ours, which is the point: it is the org's deterministic backend for
 * exactly this, it tracks the protocol as the protocol moves, and using it here means OpenBot finds
 * out about a drift in the same week as everything else that depends on it rather than in a
 * customer's integration.
 *
 * Deterministic and offline. No key, no network, no spend, and the same answer on every run, so
 * this belongs in CI, which is where an agent-facing contract most needs watching.
 */

describe("registering an agent that really answers", () => {
  const mock = new AGUIMock();
  let url = "";

  beforeAll(async () => {
    // The events a well-behaved agent sends for a trivial run: it starts, says something, finishes.
    mock.onRun(/.*/, [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "ready" },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ] as never);
    url = await mock.start();
  });

  afterAll(async () => {
    await mock.stop?.();
  });

  test("an agent speaking real AG-UI is reported as working, with what it sent", async () => {
    const result = await testAgentConnection(url, { allowPrivateHosts: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The events are shown to the person registering it, so that they can see it really answered
    // rather than being told it did.
    expect(result.events).toContain("RUN_STARTED");
    expect(result.events).toContain("RUN_FINISHED");
  });

  test("the address is still checked before anything is dialled", async () => {
    // Same guard as registration: the button must not become a way to probe the internal network,
    // and a live server on the other end does not change that.
    const result = await testAgentConnection("http://169.254.169.254/", {
      allowPrivateHosts: true,
    });
    expect(result.ok).toBe(false);
  });

  test("a redirect cannot carry the request somewhere the check refuses", async () => {
    // The check only ever sees the URL a person typed. Following a redirect blindly makes that check
    // decorative: anything registrable can bounce the server at the metadata endpoint.
    const bounced: string[] = [];
    const redirector = Bun.serve({
      port: 0,
      fetch: (request) => {
        bounced.push(request.url);
        return new Response(null, {
          status: 307,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      },
    });

    try {
      const result = await testAgentConnection(
        `http://127.0.0.1:${redirector.port}/ag-ui`,
        { allowPrivateHosts: true, timeoutMs: 4_000 },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/redirect/i);
      // The first hop is the registered address and is expected. Nothing beyond it should have been
      // dialled, which is what the refusal is for.
      expect(bounced.length).toBe(1);
    } finally {
      redirector.stop(true);
    }
  });

  test("a redirect to an address the check permits is still followed", async () => {
    // A deployment that puts its agent behind a redirect, http to https being the ordinary case, has
    // done nothing wrong. Refusing every redirect would break it, so the destination is checked
    // rather than the hop count.
    const redirector = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, { status: 307, headers: { location: url } }),
    });

    try {
      const result = await testAgentConnection(
        `http://127.0.0.1:${redirector.port}/ag-ui`,
        { allowPrivateHosts: true, timeoutMs: 8_000 },
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.events).toContain("RUN_STARTED");
    } finally {
      redirector.stop(true);
    }
  });

  test("a redirect that never arrives anywhere gives up rather than looping", async () => {
    const looper = Bun.serve({
      port: 0,
      fetch: (request) =>
        new Response(null, { status: 307, headers: { location: request.url } }),
    });

    try {
      const result = await testAgentConnection(
        `http://127.0.0.1:${looper.port}/ag-ui`,
        { allowPrivateHosts: true, timeoutMs: 8_000 },
      );
      expect(result.ok).toBe(false);
    } finally {
      looper.stop(true);
    }
  });

  test("a port with nothing on it reports the direction of the connection", async () => {
    // The server dials the agent, so localhost must be tested from the server side.
    const dead = await testAgentConnection("http://127.0.0.1:9/", {
      allowPrivateHosts: true,
      timeoutMs: 2_000,
    });
    expect(dead.ok).toBe(false);
    if (!dead.ok) {
      expect(dead.reason).toMatch(/reachable from|did not answer/);
    }
  });
});
