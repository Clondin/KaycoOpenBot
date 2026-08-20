import {
  IconCheck,
  IconChevronDown,
  IconClock,
  IconRefresh,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  channelRunsQueryOptions,
  decideApproval,
  type ApprovalRequest,
  runApprovalsQueryOptions,
  runEventsQueryOptions,
  runKeys,
  type TaskRun,
  type TaskRunEvent,
} from "@/lib/runs/queries";

const STATUS_LABEL: Record<TaskRun["status"], string> = {
  queued: "Queued",
  running: "Working",
  waiting_for_approval: "Waiting for your approval",
  waiting_for_input: "Waiting for you",
  succeeded: "Completed",
  failed: "Needs attention",
  cancelled: "Stopped",
};

const ACTIVE = new Set<TaskRun["status"]>([
  "queued",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

export function TaskRunStatus({
  channelId,
  onRetry,
}: {
  channelId: string;
  onRetry: (runId: string) => void;
}) {
  const runs = useQuery(channelRunsQueryOptions(channelId));
  const ordered = runs.data ?? [];
  const current = ordered.find((run) => ACTIVE.has(run.status)) ?? ordered[0];
  const history = current
    ? ordered.filter((run) => run.id !== current.id).slice(0, 4)
    : [];

  if (!current) return null;

  return (
    <section aria-label="Task activity" className="my-3 min-w-0">
      <RunCard onRetry={onRetry} run={current} />
      {history.length > 0 ? (
        <details className="group/run-history mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            <IconChevronDown className="size-3.5 transition-transform group-open/run-history:rotate-180" />
            Earlier work
          </summary>
          <div className="mt-2 grid gap-2 border-l pl-3">
            {history.map((run) => (
              <RunCard compact key={run.id} onRetry={onRetry} run={run} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function RunCard({
  compact = false,
  onRetry,
  run,
}: {
  compact?: boolean;
  onRetry: (runId: string) => void;
  run: TaskRun;
}) {
  const events = useQuery({
    ...runEventsQueryOptions(run.id),
    refetchInterval: ACTIVE.has(run.status) ? 2_000 : false,
  });
  const approvals = useQuery({
    ...runApprovalsQueryOptions(run.id),
    refetchInterval: ACTIVE.has(run.status) ? 1_000 : false,
  });
  const pending = approvals.data?.find(
    (approval) => approval.status === "pending",
  );
  const completedApprovals = approvals.data?.filter(
    (approval) => approval.status !== "pending",
  );
  const steps = useMemo(
    () => visibleSteps(events.data ?? [], run),
    [events.data, run],
  );

  return (
    <article
      className={
        compact
          ? "rounded-lg border bg-card/50 px-3 py-2"
          : "overflow-hidden rounded-xl border bg-card shadow-xs"
      }
      data-run-status={run.status}
    >
      <div className={compact ? "flex items-center gap-3" : "px-3 py-3"}>
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <StatusMark status={run.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-sm">
                {STATUS_LABEL[run.status]}
              </span>
              <span className="text-xs text-muted-foreground">
                {durationLabel(run)}
              </span>
              {run.attempt > 1 ? (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  Attempt {run.attempt} of {run.maxAttempts}
                </span>
              ) : null}
            </div>
            {!compact ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {run.title}
              </p>
            ) : null}
          </div>
        </div>
        {run.status === "failed" || run.status === "cancelled" ? (
          <Button
            className="shrink-0"
            onClick={() => onRetry(run.id)}
            size="sm"
            variant="outline"
          >
            <IconRefresh />
            Retry
          </Button>
        ) : null}
      </div>

      {!compact ? (
        <>
          {steps.length > 0 ? <RunSteps steps={steps} /> : null}
          {pending ? <ApprovalCard approval={pending} run={run} /> : null}
          {!pending && completedApprovals?.length ? (
            <ApprovalHistory approvals={completedApprovals} />
          ) : null}
          {run.error ? (
            <p
              className="border-t bg-destructive/5 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {run.error}
            </p>
          ) : null}
          {run.output ? (
            <details className="border-t px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
                Saved output
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-sans">
                {run.output}
              </pre>
            </details>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function StatusMark({ status }: { status: TaskRun["status"] }) {
  const base =
    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full";
  if (status === "succeeded") {
    return (
      <span
        aria-hidden="true"
        className={`${base} bg-emerald-500/15 text-emerald-600`}
      >
        <IconCheck className="size-3.5" />
      </span>
    );
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <span
        aria-hidden="true"
        className={`${base} bg-destructive/10 text-destructive`}
      >
        <IconX className="size-3.5" />
      </span>
    );
  }
  if (status === "waiting_for_approval" || status === "waiting_for_input") {
    return (
      <span
        aria-hidden="true"
        className={`${base} bg-amber-500/15 text-amber-600`}
      >
        <IconShieldCheck className="size-3.5" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`${base} bg-primary/10 text-primary`}>
      <span className="size-2 animate-pulse rounded-full bg-current" />
    </span>
  );
}

type VisibleStep = {
  id: string;
  label: string;
  at: string;
  active: boolean;
};

function visibleSteps(
  events: readonly TaskRunEvent[],
  run: TaskRun,
): VisibleStep[] {
  const steps = events.flatMap((event): VisibleStep[] => {
    if (event.type !== "status") return [];
    const status = event.payload.status;
    if (typeof status !== "string") return [];
    const label = STATUS_LABEL[status as TaskRun["status"]];
    if (!label) return [];
    return [
      {
        id: event.id,
        label,
        at: event.createdAt,
        active: status === run.status && ACTIVE.has(run.status),
      },
    ];
  });
  return steps.slice(-5);
}

function RunSteps({ steps }: { steps: readonly VisibleStep[] }) {
  return (
    <ol aria-label="Task progress" className="border-t px-3 py-2">
      {steps.map((step, index) => (
        <li className="relative flex gap-2 pb-2 last:pb-0" key={step.id}>
          {index < steps.length - 1 ? (
            <span
              aria-hidden="true"
              className="absolute left-[3px] top-2 h-full w-px bg-border"
            />
          ) : null}
          <span
            aria-hidden="true"
            className={`relative mt-1.5 size-[7px] shrink-0 rounded-full ${
              step.active
                ? "animate-pulse bg-primary"
                : "bg-muted-foreground/40"
            }`}
          />
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 text-xs">
            <span
              className={step.active ? "font-medium" : "text-muted-foreground"}
            >
              {step.label}
            </span>
            <time
              className="shrink-0 text-[11px] text-muted-foreground"
              dateTime={step.at}
            >
              {timeLabel(step.at)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ApprovalCard({
  approval,
  run,
}: {
  approval: ApprovalRequest;
  run: TaskRun;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const decision = useMutation({
    mutationFn: (value: "approved" | "declined") =>
      decideApproval(approval.id, value, note),
    onSuccess: async () => {
      setNote("");
      setProblem(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runKeys.approvals(run.id) }),
        queryClient.invalidateQueries({ queryKey: runKeys.events(run.id) }),
        queryClient.invalidateQueries({
          queryKey: runKeys.channel(run.channelId),
        }),
      ]);
    },
    onError: (error) => {
      setProblem(
        error instanceof Error ? error.message : "That decision failed.",
      );
    },
  });

  return (
    <section
      aria-label="Approval needed"
      className="border-t bg-amber-500/5 px-3 py-3"
    >
      <div className="flex items-start gap-2">
        <IconShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{approval.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {approval.summary}
          </p>
        </div>
      </div>
      {approval.details.length > 0 ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,7rem)_1fr] gap-x-3 gap-y-1.5 rounded-lg border bg-background/70 p-2.5 text-xs">
          {approval.details.map((detail) => (
            <div className="contents" key={`${detail.label}:${detail.value}`}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <label
        className="mt-3 block text-xs font-medium"
        htmlFor={`approval-note-${approval.id}`}
      >
        Add an instruction{" "}
        <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <input
        className="mt-1.5 w-full rounded-md border bg-background px-2.5 py-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        disabled={decision.isPending}
        id={`approval-note-${approval.id}`}
        onChange={(event) => setNote(event.target.value)}
        placeholder="For example: approve this once, but do not contact anyone"
        value={note}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={decision.isPending}
          onClick={() => decision.mutate("approved")}
          size="sm"
        >
          <IconCheck />
          {decision.isPending && decision.variables === "approved"
            ? "Approving…"
            : "Approve once"}
        </Button>
        <Button
          disabled={decision.isPending}
          onClick={() => decision.mutate("declined")}
          size="sm"
          variant="outline"
        >
          <IconX />
          {decision.isPending && decision.variables === "declined"
            ? "Declining…"
            : "Decline"}
        </Button>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <IconClock className="size-3" />
          Expires {timeLabel(approval.expiresAt)}
        </span>
      </div>
      {problem ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

function ApprovalHistory({
  approvals,
}: {
  approvals: readonly ApprovalRequest[];
}) {
  const last = approvals[0];
  if (!last) return null;
  return (
    <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
      {last.status === "approved" ? (
        <IconCheck className="size-3.5 text-emerald-600" />
      ) : (
        <IconX className="size-3.5 text-destructive" />
      )}
      <span>
        {last.title}: {last.status}
        {last.note ? ` — ${last.note}` : ""}
      </span>
    </div>
  );
}

function durationLabel(run: TaskRun) {
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = new Date(run.completedAt ?? run.updatedAt).getTime();
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  if (ACTIVE.has(run.status)) {
    return `Started ${timeLabel(run.startedAt ?? run.createdAt)}`;
  }
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function timeLabel(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(time);
}
