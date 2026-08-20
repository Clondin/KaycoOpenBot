import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  channelRunsQueryOptions,
  decideApproval,
  runApprovalsQueryOptions,
  runKeys,
  type TaskRun,
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

export function TaskRunStatus({
  channelId,
  onRetry,
}: {
  channelId: string;
  onRetry: (runId: string) => void;
}) {
  const runs = useQuery(channelRunsQueryOptions(channelId));
  const latest = runs.data?.[0];

  if (!latest) return null;

  return (
    <div className="mb-2 rounded-lg border border-border bg-background/95 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${tone(latest.status)}`}
            />
            <span className="font-medium">{STATUS_LABEL[latest.status]}</span>
          </div>
          {latest.error ? (
            <p className="mt-1 line-clamp-2 text-xs text-destructive">
              {latest.error}
            </p>
          ) : null}
        </div>
        {latest.status === "failed" || latest.status === "cancelled" ? (
          <Button
            onClick={() => onRetry(latest.id)}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        ) : null}
      </div>
      <RunApprovals run={latest} />
    </div>
  );
}

function RunApprovals({ run }: { run: TaskRun }) {
  const queryClient = useQueryClient();
  const approvals = useQuery({
    ...runApprovalsQueryOptions(run.id),
    enabled: run.status === "waiting_for_approval" || run.status === "running",
  });
  const pending = approvals.data?.find(
    (approval) => approval.status === "pending",
  );
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const decision = useMutation({
    mutationFn: (value: "approved" | "declined") =>
      pending
        ? decideApproval(pending.id, value, note)
        : Promise.reject(new Error("There is no pending approval.")),
    onSuccess: async () => {
      setNote("");
      setProblem(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runKeys.approvals(run.id) }),
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

  if (!pending) return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="font-medium">{pending.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{pending.summary}</p>
      {pending.details.length ? (
        <dl className="mt-2 grid grid-cols-[minmax(0,6rem)_1fr] gap-x-3 gap-y-1 text-xs">
          {pending.details.map((detail) => (
            <div className="contents" key={`${detail.label}:${detail.value}`}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <input
        aria-label="Approval note"
        className="mt-2 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs"
        disabled={decision.isPending}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Optional note"
        value={note}
      />
      <div className="mt-2 flex gap-2">
        <Button
          disabled={decision.isPending}
          onClick={() => decision.mutate("approved")}
          size="sm"
        >
          {decision.isPending && decision.variables === "approved"
            ? "Approving…"
            : "Approve"}
        </Button>
        <Button
          disabled={decision.isPending}
          onClick={() => decision.mutate("declined")}
          size="sm"
          variant="outline"
        >
          {decision.isPending && decision.variables === "declined"
            ? "Declining…"
            : "Decline"}
        </Button>
      </div>
      {problem ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function tone(status: TaskRun["status"]) {
  switch (status) {
    case "succeeded":
      return "bg-emerald-500";
    case "failed":
    case "cancelled":
      return "bg-red-500";
    case "waiting_for_approval":
    case "waiting_for_input":
      return "bg-amber-500";
    default:
      return "bg-sky-500 animate-pulse";
  }
}
