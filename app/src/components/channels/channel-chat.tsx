import type { Message } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toAgentOptions } from "@/components/channels/composer";
import {
  attachmentInputPart,
  type ComposerAttachment,
} from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { TaskRunStatus } from "@/components/tasks/task-run-status";
import {
  seedMessage,
  stashFirstMessage,
  stashRoutedMessage,
  takeAssignedWork,
  takeFirstMessage,
  takeRoutedMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  createChannelMutationOptions,
  recordChannelActivityMutationOptions,
} from "@/lib/channels/mutations";
import { channelKeys, type AgentChannel } from "@/lib/channels/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useActiveRun } from "@/lib/copilot/active-run";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { stoppedReason } from "@/lib/copilot/stopped-turn";
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
  searchOpen = false,
  onCloseSearch,
  onSelectAgent,
}: {
  channel: AgentChannel;
  runtimeAgentId: string;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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

  // CopilotKit opens a follow-up AG-UI run after a browser tool returns, and that internal run does
  // not repeat the `forwardedProps` supplied to the first run. Inject the current durable task at
  // the agent boundary so a later server-side MCP call still pauses in the same approval UI.
  useEffect(() => {
    agent.use((input, next) => {
      const runId = activeRunIdRef.current;
      return next.run({
        ...input,
        forwardedProps: {
          ...(input.forwardedProps ?? {}),
          ...(runId
            ? {
                openbotTaskRunId: runId,
                openbotChannelId: channel.id,
              }
            : {}),
        },
      });
    });
    return () => {
      // A registry agent can outlive this component. Old middleware must become inert on unmount.
      activeRunIdRef.current = undefined;
    };
  }, [agent, channel.id]);

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
  const [routed] = useState(() =>
    takeRoutedMessage(channel.id, runtimeAgentId),
  );
  const [firstMessage] = useState(() =>
    assigned
      ? { text: assigned.text, attachments: [] as ComposerAttachment[] }
      : routed
        ? {
            text: routed.draft.text,
            attachments: routed.draft.attachments,
          }
        : takeFirstMessage(channel.id),
  );
  const [seed] = useState<Message | null>(() =>
    firstMessage
      ? seedMessage(
          firstMessage.text,
          crypto.randomUUID(),
          firstMessage.attachments,
        )
      : null,
  );

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(firstMessage);
  const assignedRunRef = useRef(assigned?.runId);
  const routedRef = useRef(routed);

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

  /*
   * TWO DIFFERENT FACTS ABOUT ONE TURN, AND NEITHER OF THEM IS `agent.isRunning`.
   *
   * `turnsInFlight` counts what a person would call the Bot having the turn: from the moment `say`
   * is entered until the whole thing has come back, browser actions in the middle included. It is
   * what decides whether the next thing typed is sent or parked, and what tells the queue its wait
   * is over.
   *
   * `runsInFlight` counts what Stop can actually reach: the run `copilotkit.runAgent` opens, and
   * nothing before it. A turn can be in flight for a second and a half before that, while `say`
   * waits for the runtime agent, and a Stop drawn in that window aborts a controller nobody has
   * made yet.
   *
   * `agent.isRunning` looks like both and is neither. It reports the run on the wire, and a turn
   * that touches the browser is several runs in a row: the Bot asks for a click, the run ENDS so
   * the browser can answer it, and another run starts carrying the answer. The agent reports itself
   * idle in every one of those gaps — the truth about the wire and a lie about the turn. OpenBot
   * registers every computer tool as a frontend tool, so the gaps open on ordinary work rather than
   * on some edge case, and anything keyed on the turn ending fires in the middle of one instead.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  const [runsInFlight, setRunsInFlight] = useState(0);

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const createBranch = useMutation(createChannelMutationOptions(queryClient));
  const createBranchRef = useRef(createBranch.mutateAsync);
  createBranchRef.current = createBranch.mutateAsync;
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
   * Everything `say` does once it has something worth sending, split out so the counter it is
   * wrapped in covers every way out of here, a throw included.
   */
  const deliver = async (
    trimmed: string,
    skillInstructions: string[] = [],
    parentRunId?: string,
    existingRunId?: string,
    attachments: readonly ComposerAttachment[] = [],
  ) => {
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
      content:
        attachments.length === 0
          ? trimmed
          : [
              ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
              ...attachments.map(attachmentInputPart),
            ],
      id: crypto.randomUUID(),
      role: "user",
    });
    report(
      trimmed ||
        `Shared ${attachments.length} file${attachments.length === 1 ? "" : "s"}.`,
      null,
    );

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(agent.messages);
    if (repaired !== agent.messages) {
      agent.setMessages(repaired as typeof agent.messages);
    }

    setRunsInFlight((count) => count + 1);
    try {
      await copilotkit.runAgent({
        agent,
        forwardedProps: {
          openbotTaskRunId: runId,
          openbotChannelId: channel.id,
        },
      });
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
    } finally {
      setRunsInFlight((count) => count - 1);
    }
  };

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   *
   * Every user turn in this channel goes through here — what the composer sends, the seed from the
   * compose screen, and a button inside a rendered component. That is what makes the counter worth
   * keeping here rather than in the view: the view sees only the turns it started itself, and a
   * queue that drains on the wrong one of those posts a correction into the middle of an answer.
   */
  const say = async (
    text: string,
    skillInstructions: string[] = [],
    parentRunId?: string,
    existingRunId?: string,
    attachments: readonly ComposerAttachment[] = [],
  ) => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    setTurnsInFlight((count) => count + 1);
    try {
      await deliver(
        trimmed,
        skillInstructions,
        parentRunId,
        existingRunId,
        attachments,
      );
    } finally {
      setTurnsInFlight((count) => count - 1);
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
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      onRunErrorEvent: ({ event }) => fail(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => fail(stoppedReason(error)),
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
  const latestRunIdRef = useRef(runHistory.data?.[0]?.id);
  latestRunIdRef.current = runHistory.data?.[0]?.id;
  const retryRun = useCallback((runId: string) => {
    void sayRef
      .current("Please retry the last request in this conversation.", [], runId)
      .catch(() => undefined);
  }, []);
  const retryLatest = useCallback(() => {
    void sayRef
      .current(
        "Please retry the previous response. Re-check the request and produce a fresh answer.",
        [],
        latestRunIdRef.current,
      )
      .catch(() => undefined);
  }, []);
  const branchMessage = useCallback(
    (text: string, role: "user" | "assistant") => {
      void (async () => {
        try {
          const branch = await createBranchRef.current([runtimeAgentId]);
          queryClient.setQueryData(channelKeys.detail(branch.id), branch);
          const quoted = text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
          stashFirstMessage(
            branch.id,
            `Continue from this ${role === "assistant" ? "coworker response" : "message"}:\n\n${quoted}`,
          );
          await navigate({
            params: { channelId: branch.id },
            to: "/channel/$channelId",
          });
        } catch (error) {
          setRunError(
            error instanceof Error
              ? error.message
              : "A new conversation could not be started.",
          );
        }
      })();
    },
    [navigate, queryClient, runtimeAgentId],
  );

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
      const routedMessage = routedRef.current;
      routedRef.current = null;
      await sayRef.current(
        pending.text,
        routedMessage?.skillInstructions ?? [],
        undefined,
        existingRunId,
        pending.attachments,
      );
    })();

    // Keep `seed` in state; transcriptMessages hides it as soon as agent messages exist.
  }, [joinGatePromise]);

  return (
    <ConversationProvider ask={askFromComponent}>
      <ConversationView
        activity={<TaskRunStatus channelId={channel.id} onRetry={retryRun} />}
        agents={toAgentOptions(agentProfiles, channel.agentIds)}
        assistantName={
          agentProfiles?.find((profile) => profile.id === runtimeAgentId)
            ?.name ?? "Coworker"
        }
        busy={agent.isRunning}
        // The `/` menu exposes only skills granted to this Bot.
        commands={skillCommands}
        channelId={channel.id}
        // Readiness is handled by `say`; deletion is the only disabled-chat state.
        disabled={!channel.active}
        messages={transcriptMessages(agent.messages, seed)}
        onBranchMessage={branchMessage}
        onRetryLatest={retryLatest}
        notice={
          channel.active ? null : (
            <p className="pb-2 text-sm text-muted-foreground" role="status">
              This coworker has been deleted. The conversation stays readable,
              but it can no longer reply.
            </p>
          )
        }
        onSubmit={async (draft) => {
          // `draft.agentId` carries the @mentioned coworker. A different permitted coworker is
          // routed below through an intentional remount so the runtime binding and visible sender
          // always agree.
          //
          // `commandIds` are the `/` chips that survived into the send, in the order they were
          // typed. Resolved against the same list the menu was built from, so a chip left over from
          // a skill that has since been revoked resolves to nothing rather than to a stale
          // instruction — the menu is refetched, and this reads from it.
          const skillInstructions = [
            ...draft.commandIds
              .map(
                (id) =>
                  skillCommands.find((command) => command.id === id)?.prompt,
              )
              .filter((instruction): instruction is string =>
                Boolean(instruction),
              ),
            ...(draft.knowledgeRequested
              ? [
                  "Search indexed company knowledge with openbot_search_knowledge before answering. Ground factual claims in the returned evidence and cite the source titles and links. Say clearly when the available sources do not support a claim.",
                ]
              : []),
          ];

          if (
            draft.agentId &&
            draft.agentId !== runtimeAgentId &&
            channel.agentIds.includes(draft.agentId) &&
            onSelectAgent
          ) {
            stashRoutedMessage(
              channel.id,
              draft.agentId,
              draft,
              skillInstructions,
            );
            onSelectAgent(draft.agentId);
            return;
          }

          await say(
            draft.text,
            skillInstructions,
            undefined,
            undefined,
            draft.attachments,
          );
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
        /*
         * The turn, not the run. A browser action ends one run and starts another, and telling the
         * conversation it is idle in between is what would drain a parked correction into the
         * middle of an answer: a second turn racing the first on one thread, with a fabricated
         * result stitched over a tool call that is still executing.
         */
        pending={agent.isRunning || turnsInFlight > 0}
        /*
         * A channel outlives its turns, so it is the screen where waiting is worth offering. A
         * correction typed mid-answer is held here, in this tab, and runs as one follow-up turn the
         * moment this one is over — including when it is over because somebody pressed the button
         * above.
         */
        queueWhileBusy
        draftKey={`channel:${channel.id}`}
        searchOpen={searchOpen}
        onCloseSearch={onCloseSearch}
        /*
         * The run, not the turn. Stop reaches a run through the core's abort controller, and that
         * controller does not exist until `say` has finished waiting for the runtime agent — so
         * this is the one place the narrower fact is the honest one to draw a button from.
         */
        stoppable={agent.isRunning || runsInFlight > 0}
        /*
         * At the END OF THE TRANSCRIPT rather than above the composer, which is where this used to
         * be. A turn that ends without an answer leaves a gap exactly where the reply was going to
         * appear, and the person is already looking at it; an explanation in the composer area is a
         * different part of the screen from the thing it explains.
         *
         * `runError` carries whatever ended the turn, in that thing's own words. A Bot that stopped
         * streaming says so, because the deployment's stall watchdog writes that sentence into the
         * run before closing it; see server/src/channels/stall-guard.ts.
         */
        stopped={runError ?? undefined}
      />
    </ConversationProvider>
  );
}
