/**
 * Wait for a person to decide an approval without coupling the poller to a particular tool family.
 * Browser actions and MCP calls both use this path, so cancellation and expiry mean the same thing.
 */

const APPROVAL_WAIT_MS = 10 * 60_000;
const APPROVAL_POLL_MS = 1_000;

export type ApprovalDecision =
  | "approved"
  | "declined"
  | "expired"
  | "cancelled";

export async function waitForApprovalDecision(
  approvalId: string,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return "cancelled";

    let response: Response | null = null;
    try {
      response = await fetch(
        `/api/runs/approvals/${encodeURIComponent(approvalId)}`,
        { credentials: "include", ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      if (signal?.aborted) return "cancelled";
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
    }

    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as {
        approval?: { status?: string };
      } | null;
      const status = body?.approval?.status;
      if (status === "approved" || status === "declined") return status;
      if (status === "expired" || status === "cancelled") return "expired";
    }

    await wait(APPROVAL_POLL_MS, signal);
  }
  return signal?.aborted ? "cancelled" : "expired";
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
