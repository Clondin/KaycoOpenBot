import type { Message } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { TaskRunStatus } from "@/components/tasks/task-run-status";
import {
  seedMessage,
  takeAssignedWork,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { recordChannelActivityMutationOptions } from "@/lib/channels/mutations";
import type { AgentChannel } from "@/lib/channels/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useActiveRun } from "@/lib/copilot/active-run";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import {
  channelRunsQueryOptions,
  createTaskRun,
  runKeys,
  transitionTaskRun,
} from "@/lib/runs/queries";

/**
 * Backstop for the first message of a new channel; a stalled join must not lose the message.
 */
const SEND_WITHOUT_JOIN_AFTER_MS = 1500;

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
export function ChannelChat({
  channel,
  runtimeAgentId,
}: {
  channel: AgentChannel;
  runtimeAgentId: string;
}) {
  const queryClient = useQueryClient();
  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  // Mentions are scoped to the channel's permitted agents.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const { agent, isReady } = useAgent({
    agentId: `channel:${channel.id}`,
    runtimeAgentId,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });

  const runHistory = useQuery(channelRunsQueryOptions(channel.id));
  const [activeRunId, setActiveRunId] = useState<string | undefined>();
  const activeRunIdRef = useRef<string | undefined>(activeRunId);
  activeRunIdRef.current = activeRunId;
  useActiveRun({ runId: activeRunId, channelId: channel.id });

  // Recover the durable identity after a reload while Intelligence reconnects to the same run.
  useEffect(() => {
    if (activeRunId) return;
    const recoverable = runHistory.data?.find((run) =>
      [
        "queued",
        "running",
        "waiting_for_approval",
        "waiting_for_input",
      ].includes(run.status),
    );
    if (recoverable) setActiveRunId(recoverable.id);
  }, [activeRunId, runHistory.data]);

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [assigned] = useState(() => takeAssignedWork(channel.id));
  const [seed] = useState<Message | null>(() => {
    const pending = assigned?.text ?? takeFirstMessage(channel.id);
    return pending ? seedMessage(pending, crypto.randomUUID()) : null;
  });

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const assignedRunRef = useRef(assigned?.runId);

  /** Promise gate for ordering the first message after the thread join when possible. */
  const openJoinGate = useRef<() => void>(() => {});
  const joinGate = useRef<Promise<void> | null>(null);
  if (joinGate.current === null) {
    joinGate.current = new Promise<void>((resolve) => {
      openJoinGate.current = resolve;
    });
  }
  const joinGatePromise = joinGate.current;

  /** Promise gate so messages typed before runtime readiness wait instead of being discarded. */
  const openReadyGate = useRef<() => void>(() => {});
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      openReadyGate.current = resolve;
    });
  }
  const readyGatePromise = readyGate.current;
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;
  useEffect(() => {
    if (isReady) openReadyGate.current();
  }, [isReady]);

  // Join the gateway socket, restore durable history, then release the first-message gate.
  useEffect(() => {
    if (!isReady) return;
    let current = true;

    void (async () => {
      try {
        await copilotkit.connectAgent({ agent });
      } catch {
        // Reported by the run-failure subscriber below; history is still worth restoring.
      }

      try {
        const response = await fetch(
          `/api/copilotkit/threads/${encodeURIComponent(channel.threadId)}/messages?agentId=${encodeURIComponent(runtimeAgentId)}`,
          { credentials: "include" },
        );
        if (response.ok && current) {
          const stored = (await response.json())?.messages;
          // Never overwrite local messages that arrived while history was loading.
          if (
            Array.isArray(stored) &&
            stored.length > 0 &&
            agent.messages.length === 0
          ) {
            agent.setMessages(stored);
          }
        }
      } catch {
        // An unreadable history is not a reason to block the composer.
      } finally {
        // Release even on join/restore failure; the gate orders messages, not withholds them.
        openJoinGate.current();
      }
    })();

    return () => {
      current = false;
    };
  }, [copilotkit, agent, isReady, channel.threadId, runtimeAgentId]);

  // Tool calls from this conversation act on this coworker's own computer.
  useActiveBot(runtimeAgentId);

  const skillCommands = useSkillCommands(runtimeAgentId);

  // Run failures arrive as events and are reported only for turns started in this mount.
  const [runError, setRunError] = useState<string | null>(null);
  const awaitingReply = useRef(false);
  const memoryContextRef = useRef("");

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const report = (text: string, agentId: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    recordActivity.mutate({
      agentId,
      at: new Date().toISOString(),
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   */
  const say = async (
    text: string,
    skillInstructions: string[] = [],
    parentRunId?: string,
    existingRunId?: string,
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Wait briefly for the runtime agent instance before adding the message.
    if (!isReadyRef.current) {
      await Promise.race([
        readyGatePromise,
        new Promise((resolve) =>
          setTimeout(resolve, SEND_WITHOUT_JOIN_AFTER_MS),
        ),
      ]);
    }

    setRunError(null);
    awaitingReply.current = true;

    let runId: string;
    try {
      const run = existingRunId
        ? { id: existingRunId }
        : await createTaskRun({
            channelId: channel.id,
            agentId: runtimeAgentId,
            title: parentRunId
              ? "Retried conversation task"
              : "Conversation task",
            ...(parentRunId ? { parentRunId } : {}),
          });
      runId = run.id;
      activeRunIdRef.current = run.id;
      setActiveRunId(run.id);
      await transitionTaskRun(run.id, "running");
      void queryClient.invalidateQueries({
        queryKey: runKeys.channel(channel.id),
      });
    } catch (error) {
      awaitingReply.current = false;
      setRunError(
        error instanceof Error
          ? error.message
          : "The task could not be recorded, so it was not started.",
      );
      return;
    }

    // Inspectable memory is automatically supplied as system context and only appended when its
    // content changes, so durable preferences work without silently bloating every turn.
    try {
      const response = await fetch("/api/work/memory", {
        credentials: "include",
      });
      if (response.ok) {
        const body = (await response.json()) as {
          memory: Array<{
            agentId: string | null;
            confidence: number;
            content: string;
            kind: string;
            pinned: boolean;
            scope: "user" | "agent" | "project";
            title: string;
          }>;
        };
        const relevant = body.memory
          .filter(
            (item) =>
              item.scope === "user" ||
              (item.scope === "agent" && item.agentId === runtimeAgentId),
          )
          .sort((left, right) => Number(right.pinned) - Number(left.pinned))
          .slice(0, 20)
          .map(
            (item) =>
              `- [${item.kind}; confidence ${item.confidence}%] ${item.title}: ${item.content}`,
          )
          .join("\n")
          .slice(0, 8_000);
        const memoryContext = relevant
          ? `Inspectable OpenBot memory for this conversation follows. Treat it as potentially stale, use it only when relevant, and do not claim it came from the current message.\n${relevant}`
          : "";
        if (memoryContext && memoryContext !== memoryContextRef.current) {
          agent.addMessage({
            content: memoryContext,
            id: crypto.randomUUID(),
            role: "system",
          });
          memoryContextRef.current = memoryContext;
        }
      }
    } catch {
      // Memory is supporting context; an unavailable memory endpoint must not block the task.
    }

    /*
     * THE SKILL GOES IN FRONT OF THE MESSAGE, AS A SYSTEM TURN. A `/` chip is one token in the
     * composer; what it stands for is the instruction added here, ahead of what the person typed, so
     * the Bot reads the job before the request.
     *
     * A system message rather than text prepended to theirs, because the two are not the same kind
     * of thing: the transcript should show what a person said, and pasting the skill into their
     * words puts sentences in their mouth and makes the reply quote instructions back at them.
     *
     * `transcriptMessages` draws user and assistant turns, so this never appears on screen — the
     * chip is what says a skill was used, and it stays visible in the message they sent.
     */
    for (const instruction of skillInstructions) {
      agent.addMessage({
        content: instruction,
        id: crypto.randomUUID(),
        role: "system",
      });
    }

    agent.addMessage({
      content: trimmed,
      id: crypto.randomUUID(),
      role: "user",
    });
    report(trimmed, null);

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(agent.messages);
    if (repaired !== agent.messages) {
      agent.setMessages(repaired as typeof agent.messages);
    }

    try {
      await copilotkit.runAgent({ agent });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The Bot stopped without saying why.";
      await transitionTaskRun(runId, "failed", message).catch(() => undefined);
      awaitingReply.current = false;
      activeRunIdRef.current = undefined;
      setActiveRunId(undefined);
      void queryClient.invalidateQueries({
        queryKey: runKeys.channel(channel.id),
      });
      throw error;
    }
  };

  useEffect(() => {
    const fail = (message: string) => {
      if (!awaitingReply.current) return;
      awaitingReply.current = false;
      setRunError(message);
      const runId = activeRunIdRef.current;
      if (runId) {
        void transitionTaskRun(runId, "failed", message)
          .catch(() => undefined)
          .finally(() => {
            activeRunIdRef.current = undefined;
            setActiveRunId(undefined);
            void queryClient.invalidateQueries({
              queryKey: runKeys.channel(channel.id),
            });
          });
      }
    };
    const subscription = agent.subscribe?.({
      onRunErrorEvent: ({ event }) =>
        fail(event?.message ?? "The Bot stopped without saying why."),
      onRunFailed: ({ error }) =>
        fail(
          error instanceof Error
            ? error.message
            : "The Bot stopped without saying why.",
        ),
      onRunFinishedEvent: () => {
        const wasOurs = awaitingReply.current;
        awaitingReply.current = false;
        if (!wasOurs) return;

        const reply = [...agent.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        const content = typeof reply?.content === "string" ? reply.content : "";
        if (content) reportRef.current(content, runtimeAgentId);
        const runId = activeRunIdRef.current;
        if (runId) {
          void transitionTaskRun(runId, "succeeded")
            .catch(() => undefined)
            .finally(() => {
              activeRunIdRef.current = undefined;
              setActiveRunId(undefined);
              void queryClient.invalidateQueries({
                queryKey: runKeys.channel(channel.id),
              });
            });
        }
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, runtimeAgentId, queryClient, channel.id]);

  // A live browser tab proves a running task has not been abandoned by a crashed client.
  useEffect(() => {
    if (!agent.isRunning || !activeRunId) return;
    const heartbeat = window.setInterval(() => {
      void transitionTaskRun(activeRunId, "running").catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(heartbeat);
  }, [agent.isRunning, activeRunId]);

  /** Stable reference for effects and component callbacks. */
  const sayRef = useRef(say);
  sayRef.current = say;

  /**
   * Component buttons speak as user turns without forcing every transcript card to re-render.
   */
  const askFromComponent = useCallback((text: string) => {
    void sayRef.current(text);
  }, []);

  /**
   * Send the create-channel seed once, after the join gate opens or the backstop expires.
   */
  useEffect(() => {
    const pending = seedRef.current;
    if (!pending) return;
    seedRef.current = null;

    void (async () => {
      await Promise.race([
        joinGatePromise,
        new Promise((resolve) =>
          setTimeout(resolve, SEND_WITHOUT_JOIN_AFTER_MS),
        ),
      ]);
      const existingRunId = assignedRunRef.current;
      assignedRunRef.current = undefined;
      await sayRef.current(
        typeof pending.content === "string" ? pending.content : "",
        [],
        undefined,
        existingRunId,
      );
    })();

    // Keep `seed` in state; transcriptMessages hides it as soon as agent messages exist.
  }, [joinGatePromise]);

  return (
    <ConversationProvider ask={askFromComponent}>
      <ConversationView
        agents={toAgentOptions(agentProfiles, channel.agentIds)}
        busy={agent.isRunning}
        // The `/` menu exposes only skills granted to this Bot.
        commands={skillCommands}
        // Readiness is handled by `say`; deletion is the only disabled-chat state.
        disabled={!channel.active}
        messages={transcriptMessages(agent.messages, seed)}
        notice={
          <>
            <TaskRunStatus
              channelId={channel.id}
              onRetry={(runId) => {
                void sayRef.current(
                  "Please retry the last request in this conversation.",
                  [],
                  runId,
                );
              }}
            />
            {runError ? (
              <p
                className="pb-2 text-sm text-destructive"
                data-testid="channel-run-error"
                role="alert"
              >
                {runError}
              </p>
            ) : null}
            {channel.active ? null : (
              <p className="pb-2 text-sm text-muted-foreground" role="status">
                This coworker has been deleted. The conversation stays readable,
                but it can no longer reply.
              </p>
            )}
          </>
        }
        onSubmit={async (draft) => {
          // `draft.agentId` carries the @mentioned coworker, but nothing routes on it yet: this
          // channel is pinned to one `runtimeAgentId` for the life of its thread, so honouring a
          // per-message mention is a change to that binding, not to the composer.
          //
          // `commandIds` are the `/` chips that survived into the send, in the order they were
          // typed. Resolved against the same list the menu was built from, so a chip left over from
          // a skill that has since been revoked resolves to nothing rather than to a stale
          // instruction — the menu is refetched, and this reads from it.
          const skillInstructions = draft.commandIds
            .map(
              (id) =>
                skillCommands.find((command) => command.id === id)?.prompt,
            )
            .filter((instruction): instruction is string =>
              Boolean(instruction),
            );

          await say(draft.text, skillInstructions);
        }}
        /**
         * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
         * unanswered tool call before the next turn.
         */
        onStop={() => {
          awaitingReply.current = false;
          copilotkit.stopAgent({ agent });
          const runId = activeRunIdRef.current;
          if (runId) {
            void transitionTaskRun(runId, "cancelled")
              .catch(() => undefined)
              .finally(() => {
                activeRunIdRef.current = undefined;
                setActiveRunId(undefined);
                void queryClient.invalidateQueries({
                  queryKey: runKeys.channel(channel.id),
                });
              });
          }
        }}
        pending={agent.isRunning}
      />
    </ConversationProvider>
  );
}
