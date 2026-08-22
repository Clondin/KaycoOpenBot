import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { ScreenshotArtifact } from "@/components/computer/screenshot-artifact";
import {
  type ControlState,
  readControl,
} from "@/components/computer/take-the-wheel";
import { useActiveBotHolder } from "./active-bot";
import { type ActiveRun, useActiveRunHolder } from "./active-run";
import {
  reportComputerActivity,
  updateComputerActivity,
} from "./computer-activity";
import { waitForApprovalDecision } from "../runs/approvals";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 */

/** What every computer call returns to the model: either the result, or a reason it did not happen. */
type ToolOutcome = Record<string, unknown> & { ok: boolean };

type ObservedElement = { ref: string; role?: string; name?: string };
type RememberedObservation = {
  snapshotId: number;
  elements: Map<string, ObservedElement>;
};

const observations = new Map<string, RememberedObservation>();
const failedActions = new Map<string, string>();
const RETRY_GUARDED_ACTIONS = new Set(["/click", "/type", "/key"]);

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  try {
    const parsed = JSON.parse(init.body) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rememberObservation(botId: string, outcome: ToolOutcome): void {
  const value = outcome.observation ?? outcome;
  if (!value || typeof value !== "object") return;
  const observation = value as Record<string, unknown>;
  if (
    typeof observation.snapshotId !== "number" ||
    !Array.isArray(observation.elements)
  ) {
    return;
  }
  const elements = new Map<string, ObservedElement>();
  for (const candidate of observation.elements) {
    if (!candidate || typeof candidate !== "object") continue;
    const element = candidate as Record<string, unknown>;
    if (typeof element.ref !== "string") continue;
    elements.set(element.ref, {
      ref: element.ref,
      ...(typeof element.role === "string" ? { role: element.role } : {}),
      ...(typeof element.name === "string" ? { name: element.name } : {}),
    });
  }
  observations.set(botId, { snapshotId: observation.snapshotId, elements });
  failedActions.delete(botId);
}

function actionKey(path: string, body: Record<string, unknown>): string | null {
  if (!RETRY_GUARDED_ACTIONS.has(path)) return null;
  return `${path}:${String(body.snapshotId ?? "")}:${String(body.ref ?? "")}:${path === "/key" ? String(body.key ?? "") : ""}`;
}

/**
 * Human-assistance wait window. Long enough for a user to return, finite so the run can unblock.
 */
const WAIT_FOR_PERSON_MS = 10 * 60_000;

/** How often the waiting handler asks whether the person has answered yet. */
const WAIT_POLL_MS = 1_000;

/** Hold the tool call open until the human control/secret prompt is answered, cancelled, or expires. */
async function waitForPerson(
  botId: string,
  done: (state: ControlState) => boolean,
  signal: AbortSignal | undefined,
  giveUpAfterMs = WAIT_FOR_PERSON_MS,
): Promise<"answered" | "gave up" | "cancelled"> {
  const deadline = Date.now() + giveUpAfterMs;
  while (Date.now() < deadline) {
    // Stop must actually stop, including out of a wait. The SDK aborts this when a person presses it.
    if (signal?.aborted) return "cancelled";
    const state = await readControl(botId).catch(() => null);
    if (state && done(state)) return "answered";
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}

async function callComputer(
  botId: string,
  task: ActiveRun,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Announce before the call so the screen can open while the action is running.
  const bodyInput = requestBody(init);
  const progress = progressFor(botId, path, bodyInput);
  const activity = reportComputerActivity(botId, progress);
  const startedAt = performance.now();
  const finish = (outcome: ToolOutcome): ToolOutcome => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (outcome.ok) rememberObservation(botId, outcome);
    updateComputerActivity(activity, {
      stage: outcome.ok ? "complete" : "error",
      label: outcome.ok
        ? completedLabel(path, progress.label, outcome)
        : String(outcome.reason ?? "Computer step failed"),
      elapsedMs,
      ...(typeof outcome.code === "string" ? { code: outcome.code } : {}),
      ...(typeof outcome.maxRunning === "number"
        ? { maxRunning: outcome.maxRunning }
        : {}),
      ...(Array.isArray(outcome.activeComputers)
        ? {
            activeComputers: outcome.activeComputers.filter(
              (entry): entry is { botId: string; startedAt?: string } =>
                !!entry &&
                typeof entry === "object" &&
                typeof (entry as { botId?: unknown }).botId === "string",
            ),
          }
        : {}),
    });
    return { ...outcome, clientElapsedMs: elapsedMs };
  };
  const failureKey = actionKey(path, bodyInput);
  if (failureKey && failedActions.get(botId) === failureKey) {
    return finish({
      ok: false,
      code: "refresh_required",
      staleRefs: true,
      needsObservation: true,
      reason:
        "That exact action already failed on this snapshot. Observe the page and use a fresh ref before trying again.",
    });
  }
  const request = async (approvalId?: string) => {
    const headers = new Headers(init?.headers);
    if (task.runId) headers.set("X-OpenBot-Run-Id", task.runId);
    if (task.channelId) headers.set("X-OpenBot-Channel-Id", task.channelId);
    if (approvalId) headers.set("X-OpenBot-Approval-Id", approvalId);
    return fetch(`/api/computers/${botId}${path}`, {
      credentials: "include",
      ...(signal ? { signal } : {}),
      ...init,
      headers,
    });
  };

  let response: Response;
  try {
    response = await request();
  } catch (error) {
    // An abort is a stopped run, not a computer failure.
    if (error instanceof DOMException && error.name === "AbortError") {
      return finish({ ok: false, reason: "Stopped.", stopped: true });
    }
    return finish({
      ok: false,
      reason: "The assistant's computer could not be reached.",
    });
  }

  let body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (response.status === 428 && body?.approvalRequired === true) {
    updateComputerActivity(activity, {
      stage: "waiting",
      label: "Waiting for your approval",
    });
    const approval = body.approval as { id?: unknown } | undefined;
    const approvalId =
      typeof approval?.id === "string" ? approval.id : undefined;
    if (!approvalId || !task.runId) {
      return finish({
        ok: false,
        refused: true,
        reason:
          "This action requires approval, but it is not running inside a durable task.",
      });
    }
    const decision = await waitForApprovalDecision(approvalId, signal);
    if (decision !== "approved") {
      return finish({
        ok: false,
        refused: true,
        reason:
          decision === "declined"
            ? "The person declined this action."
            : decision === "cancelled"
              ? "The approval wait was stopped."
              : "The approval request expired before it was decided.",
      });
    }
    try {
      response = await request(approvalId);
      body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return finish({ ok: false, reason: "Stopped.", stopped: true });
      }
      return finish({
        ok: false,
        reason: "The approved action could not reach the assistant's computer.",
      });
    }
  }

  if (!response.ok) {
    if (
      failureKey &&
      response.status === 409 &&
      body?.code !== "human_control"
    ) {
      failedActions.set(botId, failureKey);
    }
    return finish({
      ok: false,
      ...(body ?? {}),
      reason: (body?.error as string) ?? "That did not work.",
      // Preserve refusal/stale-ref/control distinctions for the model's next step.
      ...(response.status === 403
        ? { refused: true, rule: body?.rule ?? null }
        : {}),
      ...(response.status === 423 || body?.code === "human_control"
        ? { humanHasControl: true }
        : response.status === 409
          ? body?.humanHasControl === true
            ? { humanHasControl: true }
            : { staleRefs: true }
          : {}),
    });
  }

  return finish({ ok: true, ...(body ?? {}) });
}

function progressFor(
  botId: string,
  path: string,
  body: Record<string, unknown>,
): {
  stage: "starting" | "opening" | "reading" | "acting" | "waiting";
  label: string;
} {
  if (path === "/warm")
    return { stage: "starting", label: "Starting the computer" };
  if (path === "/navigate") {
    const url = typeof body.url === "string" ? body.url : "";
    let site = "the page";
    try {
      site = new URL(url).hostname.replace(/^www\./, "") || site;
    } catch {
      // The server will provide the useful validation error.
    }
    return { stage: "opening", label: `Opening ${site}` };
  }
  if (
    path === "/observe" ||
    path === "/snapshot" ||
    path === "/read" ||
    path === "/table"
  )
    return { stage: "reading", label: "Checking the page" };
  const observed = observations.get(botId);
  const ref = typeof body.ref === "string" ? body.ref : "";
  const target = observed?.elements.get(ref)?.name?.trim();
  if (path === "/click")
    return {
      stage: "acting",
      label: target ? `Clicking “${target}”` : "Clicking a control",
    };
  if (path === "/type")
    return {
      stage: "acting",
      label: target ? `Filling “${target}”` : "Filling in a field",
    };
  if (path === "/key")
    return {
      stage: "acting",
      label: `Pressing ${typeof body.key === "string" ? body.key : "a key"}${target ? ` in “${target}”` : ""}`,
    };
  if (path === "/scroll")
    return { stage: "acting", label: "Moving through the page" };
  if (path.includes("/control"))
    return { stage: "waiting", label: "Waiting for you" };
  if (path.includes("/files"))
    return { stage: "reading", label: "Working with a file" };
  return { stage: "acting", label: "Using the computer" };
}

function completedLabel(
  path: string,
  runningLabel: string,
  outcome: ToolOutcome,
): string {
  const element = outcome.element as { name?: unknown } | undefined;
  const name = typeof element?.name === "string" ? element.name.trim() : "";
  if (path === "/click" && name) return `Clicked “${name}”`;
  if (path === "/type" && name) return `Filled “${name}”`;
  if (path === "/key" && typeof outcome.key === "string")
    return `Pressed ${outcome.key}${name ? ` in “${name}”` : ""}`;
  return `${runningLabel} — done`;
}

/** What a computer tool's render can read back out of its own result. */
type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  entries?: unknown[];
  refused?: boolean;
  reason?: string;
  staleRefs?: boolean;
  elements?: unknown[];
  tables?: unknown[];
  element?: { role?: string; name?: string };
};

/**
 * Parse the SDK-render result string so the transcript can distinguish success, refusal, and failure.
 */
function outcomeOf(result: string | undefined): ComputerOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ComputerOutcome)
      : {};
  } catch {
    // Runtime stringifies thrown handlers as "Error: <message>".
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not taken from the model's arguments: those carry only a ref. The server looked the element up in
 * the snapshot it took itself, which is the same value it wrote to the audit trail, so the transcript
 * and the audit row name the thing identically.
 */
function labelOf(result: string | undefined): string | undefined {
  const element = (outcomeOf(result) as { element?: { name?: unknown } })
    .element;
  const name = element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * A compact transcript line that distinguishes policy refusals from ordinary failures.
 */
function ActionLine({
  label,
  detail,
  running,
  refused,
  failed,
}: {
  label: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
}) {
  return (
    <ToolLine
      detail={detail}
      failed={failed}
      label={label}
      refused={refused}
      running={running}
    />
  );
}

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

export function ComputerTools() {
  const bot = useActiveBotHolder();
  const run = useActiveRunHolder();

  useFrontendTool({
    name: "computer_navigate",
    description:
      "Open an interactive or visual web page on your own computer so the person can watch. Prefer " +
      "a connected structured search, database, or app tool for plain facts when one is available; " +
      "use the browser for websites, logins, forms, and visual checks. The result includes compact " +
      "page text and fresh actionable refs in observation, so do not immediately call read or snapshot.",
    parameters: z.object({
      url: z.string().describe("Full web address to open, including https://"),
    }),
    handler: async (
      { url }: { url: string },
      // Context is optional in the SDK.
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const result = await callComputer(
        bot.current,
        run.current,
        "/navigate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        },
        signal,
      );
      return result.ok
        ? {
            ok: true,
            title: result.title,
            url: result.url,
            text: result.text,
            truncated: result.truncated,
            observation: result.observation,
            clientElapsedMs: result.clientElapsedMs,
          }
        : result;
    },
    render: ({ result, status }) => {
      const outcome = outcomeOf(result) as ComputerOutcome & {
        title?: unknown;
      };
      return (
        <ActionLine
          running={status !== "complete"}
          label="Opened a page"
          detail={
            typeof outcome.title === "string"
              ? outcome.title
              : typeof outcome.reason === "string"
                ? outcome.reason
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_screenshot",
    description:
      "Capture the current screen as a point-in-time image in the conversation. Use this when the " +
      "person asks to see what is on your screen or when a visual result is important to the record.",
    parameters: z.object({}),
    handler: async () => callComputer(bot.current, run.current, "/screenshot"),
    render: ({ result, status }) => (
      <ScreenshotArtifact result={result} running={status !== "complete"} />
    ),
  });

  useFrontendTool({
    name: "computer_read",
    description:
      "Read a longer text extract from the page currently open. Actions already return a compact " +
      "observation, so use this only when that extract was truncated or you need more page text.",
    parameters: z.object({}),
    handler: async () => callComputer(bot.current, run.current, "/read"),
    /*
     * A QUIET LINE, NOT A NULL ONE. These three were registered with `render: () => null`, which
     * reads as "draw nothing" — but a non-null renderer element still comes back from
     * `useRenderToolCall`, so the transcript's own fallback never fired and the step drew as a
     * blank row inside its group: two actions in the summary, one visible line beneath it. Drawing
     * the step costs one muted line while the run is live, which is the point of watching.
     */
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          failed={didNotWork(outcome)}
          label="Read the page"
          refused={outcome.refused === true}
          running={status !== "complete"}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_extract_table",
    description:
      "Extract visible HTML tables and accessible data grids into rows and columns. Use this instead " +
      "of reading or taking a screenshot when the answer is in a table. Results are bounded; click " +
      "the page's next control and call this again for another page.",
    parameters: z.object({}),
    handler: async () => callComputer(bot.current, run.current, "/table"),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const tables = Array.isArray(outcome.tables) ? outcome.tables : [];
      const rows = tables.reduce<number>((total, table) => {
        if (!table || typeof table !== "object") return total;
        const value = (table as { rows?: unknown }).rows;
        return total + (Array.isArray(value) ? value.length : 0);
      }, 0);
      return (
        <ActionLine
          running={status !== "complete"}
          label="Extracted table data"
          detail={
            outcome.refused === true || didNotWork(outcome)
              ? outcome.reason
              : `${rows} row${rows === 1 ? "" : "s"} from ${tables.length} table${tables.length === 1 ? "" : "s"}`
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_observe",
    description:
      "Get compact page text, the most useful actionable controls, and what changed in one call. " +
      "Use this after a stale-ref error or when an older computer action did not return observation.",
    parameters: z.object({}),
    handler: async () =>
      callComputer(bot.current, run.current, "/observe", { method: "POST" }),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          failed={didNotWork(outcome)}
          label="Observed the page"
          refused={outcome.refused === true}
          running={status !== "complete"}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_snapshot",
    description:
      "List up to 200 actionable controls on a very large page. Navigation and actions already " +
      "return a smaller observation with fresh refs; use this only if that compact list was truncated.",
    parameters: z.object({}),
    handler: async () =>
      callComputer(bot.current, run.current, "/snapshot", { method: "POST" }),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          failed={didNotWork(outcome)}
          label="Checked the page"
          refused={outcome.refused === true}
          running={status !== "complete"}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_fill_form",
    description:
      "Fill several ordinary, non-secret form fields in one tool call. This is faster than one model " +
      "round trip per field. Use refs from the same recent observation; each field is still checked " +
      "and audited separately. Never put passwords, card numbers, or one-time codes here—request a " +
      "secret or ask the person to take control instead.",
    parameters: z.object({
      fields: z
        .array(
          z.object({
            ref: z.string().describe("Field ref from the recent observation"),
            snapshotId: z.number().describe("Snapshot id for the field ref"),
            text: z.string().describe("Ordinary non-secret text to enter"),
            name: z
              .string()
              .optional()
              .describe("Visible field label, used to follow a re-render"),
          }),
        )
        .min(1)
        .max(20),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after the final field is filled"),
    }),
    handler: async (
      input: {
        fields: {
          ref: string;
          snapshotId: number;
          text: string;
          name?: string;
        }[];
        submit?: boolean;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const botId = bot.current;
      const initial = observations.get(botId);
      const targets = input.fields.map((field) => {
        const known = initial?.elements.get(field.ref);
        return {
          role: known?.role,
          name: field.name?.trim() || known?.name?.trim(),
        };
      });
      let filled = 0;
      let latest: ToolOutcome | undefined;
      for (let index = 0; index < input.fields.length; index += 1) {
        const field = input.fields[index];
        if (!field) continue;
        let ref = field.ref;
        let snapshotId = field.snapshotId;
        if (index > 0) {
          const current = observations.get(botId);
          const target = targets[index];
          const match = [...(current?.elements.values() ?? [])].find(
            (candidate) =>
              !!target?.name &&
              candidate.name?.trim() === target.name &&
              (!target.role || candidate.role === target.role),
          );
          if (!current || !match) {
            return {
              ok: false,
              filled,
              needsObservation: true,
              reason: `Filled ${filled} field${filled === 1 ? "" : "s"}, then could not find “${target?.name ?? "the next field"}” after the page changed. Observe the page before continuing.`,
            };
          }
          ref = match.ref;
          snapshotId = current.snapshotId;
        }
        latest = await callComputer(
          botId,
          run.current,
          "/type",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ref,
              snapshotId,
              text: field.text,
              submit:
                input.submit === true && index === input.fields.length - 1,
            }),
          },
          signal,
        );
        if (!latest.ok) return { ...latest, filled };
        filled += 1;
      }
      return { ...(latest ?? { ok: true }), ok: true, filled };
    },
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result) as ComputerOutcome & {
        filled?: unknown;
      };
      const expected = Array.isArray(args?.fields) ? args.fields.length : 0;
      const filled =
        typeof outcome.filled === "number" ? outcome.filled : expected;
      return (
        <ActionLine
          running={status !== "complete"}
          label="Filled form"
          detail={
            didNotWork(outcome)
              ? String(outcome.reason ?? "")
              : `${filled} field${filled === 1 ? "" : "s"}${args?.submit === true ? " and submitted" : ""}`
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to safely fill and submit in one call. The result includes a fresh compact " +
      "observation; continue from its refs without a separate read or snapshot.",
    parameters: z.object({
      ref: z
        .string()
        .describe("Ref of the field, from your most recent snapshot"),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
      text: z.string().describe("The text to enter"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing, to submit a single-field form"),
    }),
    handler: async (
      input: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        run.current,
        "/type",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Filled in"
        detail={
          // Never show typed values; identify only the target field.
          labelOf(result) ??
          (typeof args?.ref === "string" ? "a field" : undefined)
        }
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent observation and the snapshotId it came from. The result includes the " +
      "changed page text and fresh refs, so continue from that observation.",
    parameters: z.object({
      ref: z
        .string()
        .describe(
          "Ref of the element to click, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        run.current,
        "/click",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        signal,
      ),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="Clicked"
          detail={
            // Show refusal reason instead of an internal element ref.
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : (labelOf(result) ??
                (typeof args?.ref === "string" ? "a control" : undefined))
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: z.object({
      key: z.string().describe("Key name, such as Enter, Tab or Escape"),
      ref: z.string().optional().describe("Optional ref to press the key on"),
      snapshotId: z
        .number()
        .optional()
        .describe("The snapshotId the ref came from, required if ref is given"),
    }),
    handler: async (
      input: {
        key: string;
        ref?: string;
        snapshotId?: number;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        run.current,
        "/key",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Pressed"
        detail={typeof args?.key === "string" ? args.key : undefined}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    name: "computer_request_secret",
    description:
      "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
      "Focus the field first with computer_click, then call this with the ref of that field and a " +
      "short label for what you need. They type it into a masked box that goes straight to the page. " +
      "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
      "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
      "if the form needs submitting, do that yourself afterwards with computer_click.",
    parameters: z.object({
      label: z
        .string()
        .describe(
          "What you need, in a few words, e.g. 'the code sent to your phone'",
        ),
      ref: z
        .string()
        .describe(
          "Ref of the field it goes in, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { label: string; ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        run.current,
        "/control/secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        signal,
      );
      if (!asked.ok) return asked;

      // Completion is `secretWanted` clearing; the value never returns to the model.
      const outcome = await waitForPerson(
        botId,
        (state) => state.secretWanted === undefined,
        signal,
      );
      return {
        ok: true,
        result:
          outcome === "answered"
            ? `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`
            : outcome === "cancelled"
              ? "The request was cancelled."
              : `Nobody entered ${input.label}. Do not ask for it another way.`,
      };
    },
    // Rendered by ComputerView as a masked prompt.
    render: () => null,
  });

  /** Self-reported model declines: audit evidence, not an enforcement control. */
  useFrontendTool({
    name: "report_refusal",
    description:
      "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
      "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
      "addition to telling the person. It changes nothing about your answer; it exists so an " +
      "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
      "not do something, only when you chose not to.",
    parameters: z.object({
      reason: z
        .string()
        .describe("Why you declined, in one sentence and in your own words"),
      request: z
        .string()
        .optional()
        .describe("What you were asked to do, in a few words"),
    }),
    handler: async (
      input: { reason: string; request?: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      try {
        const response = await fetch(
          `/api/agents/${encodeURIComponent(bot.current)}/declined`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
            ...(signal ? { signal } : {}),
          },
        );
        return response.ok
          ? "Recorded. Now tell the person what you decided and why."
          : "That could not be recorded. Tell the person what you decided anyway.";
      } catch {
        // Audit bookkeeping must not prevent the Bot from answering.
        return "That could not be recorded. Tell the person what you decided anyway.";
      }
    },
    render: () => null,
  });

  useFrontendTool({
    name: "computer_request_help",
    description:
      "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
      "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
      "will drive the browser themselves and hand it back, and you carry on in the same session. " +
      "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you.",
    parameters: z.object({
      reason: z
        .string()
        .describe(
          "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
        ),
    }),
    handler: async (
      input: { reason: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        run.current,
        "/control/request",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        signal,
      );
      if (!asked.ok) return asked;

      // Resolved when the wheel is back with the Bot and no help request remains outstanding.
      const outcome = await waitForPerson(
        botId,
        (state) => state.holder === "bot" && !state.requested,
        signal,
      );
      return {
        ok: true,
        result:
          outcome === "answered"
            ? "The person has finished and handed control back. Take a fresh snapshot: the page may have changed while they were driving."
            : outcome === "cancelled"
              ? "The request was cancelled."
              : "Nobody took control. Say what you still need rather than trying to do it yourself.",
      };
    },
    // Rendered by ComputerView as the take-the-wheel prompt.
    render: () => null,
  });

  useFrontendTool({
    name: "computer_list_files",
    description:
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
      "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
      "are not sure of. Never guess a filename.",
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe("Optional folder to list. Omit for the whole workspace."),
    }),
    handler: async (input: { path?: string }) =>
      callComputer(bot.current, run.current, "/files/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? {}),
      }),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label="Listed files"
          detail={
            outcome.refused === true || didNotWork(outcome)
              ? String(outcome.reason ?? "")
              : entries.length
                ? `${entries.length} item${entries.length === 1 ? "" : "s"} in the workspace`
                : "nothing saved yet"
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_read_file",
    description:
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
      "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
      "this to pick up notes you made before.",
    parameters: z.object({
      path: z
        .string()
        .describe("Path relative to your workspace, such as notes.md"),
    }),
    handler: async (input: { path: string }) =>
      callComputer(bot.current, run.current, "/files/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="Read file"
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_write_file",
    description:
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
      "workspace and folders are created as needed. Set append to true to add to the end of an " +
      "existing file rather than replacing it. Text only.",
    parameters: z.object({
      path: z
        .string()
        .describe(
          "Path relative to your workspace, such as reports/august.csv",
        ),
      contents: z.string().describe("The text to save"),
      append: z
        .boolean()
        .optional()
        .describe("Add to the end of the file instead of replacing it"),
    }),
    handler: async (input: {
      path: string;
      contents: string;
      append?: boolean;
    }) =>
      callComputer(bot.current, run.current, "/files/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label={args?.append === true ? "Added to file" : "Saved file"}
          // Show the path, never file contents.
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    name: "computer_scroll",
    description:
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
    parameters: z.object({
      deltaY: z
        .number()
        .optional()
        .describe("Pixels to scroll; positive is down. Defaults to 600."),
    }),
    handler: async (
      input: { deltaY?: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        run.current,
        "/scroll",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        signal,
      ),
    render: ({ result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Scrolled"
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  return null;
}
