import type { Message } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachmentInputPart,
  type ComposerAttachment,
  toAgentOptions,
} from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  firstMessageContent,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useMessageTimes } from "@/lib/channels/message-times";
import {
  indexContinuityMessageMutationOptions,
  recordChannelActivityMutationOptions,
} from "@/lib/channels/mutations";
import type { AgentChannel } from "@/lib/channels/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import {
  beginComputerTask,
  COMPUTER_RETRY_EVENT,
  finishComputerTask,
} from "@/lib/copilot/computer-activity";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { stoppedReason } from "@/lib/copilot/stopped-turn";
import { resolveContextReferences } from "@/lib/continuity/context-references";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

/**
 * Backstop for the first message of a new channel; a stalled join must not lose the message.
 */
const SEND_WITHOUT_JOIN_AFTER_MS = 1500;

/**
 * What an empty channel says instead of nothing.
 *
 * A blank scroll area reads as something failing to load, and it looks identical to a history that
 * DID fail to load. This is the third state: really empty, on purpose, with the coworker's own
 * name and role saying who is listening — the same answer their profile pane would give, in the
 * place the person is actually looking.
 */
function EmptyConversation({
  agentId,
  name,
  title,
}: {
  agentId: string;
  name: string;
  title?: string | undefined;
}) {
  return (
    <div className="relative flex flex-col items-center gap-4 py-16 text-center">
      {/*
       * A faint pool of light behind the face. Foreground-derived rather than a fixed hue, so it
       * stays monochrome in both themes and reads as depth rather than decoration.
       */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-6 size-44 rounded-full bg-[radial-gradient(closest-side,var(--foreground),transparent)] opacity-[0.07] blur-2xl"
      />
      <span
        aria-hidden
        className="relative size-14 overflow-hidden rounded-full shadow-sm ring-1 ring-foreground/10"
      >
        <Avatar className="size-full" name={agentId} size={56} />
      </span>
      <div className="relative flex flex-col items-center gap-0.5">
        <p className="font-medium text-base tracking-tight">{name}</p>
        {title ? (
          <p className="text-muted-foreground text-xs">{title}</p>
        ) : null}
        <p className="max-w-sm pt-2 text-balance text-muted-foreground text-sm">
          Ask anything below. Attach files, invoke a skill, and stop a running
          answer at any time.
        </p>
      </div>
      {/* The composer's grammar, where the person is looking before they have learned it. */}
      <ul className="relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
        <li className="inline-flex items-center gap-1.5">
          <kbd className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground/70">
            /
          </kbd>
          skills
        </li>
        <li className="inline-flex items-center gap-1.5">
          <kbd className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground/70">
            @
          </kbd>
          mention
        </li>
        <li className="inline-flex items-center gap-1.5">
          <kbd className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground/70">
            +
          </kbd>
          attach files
        </li>
      </ul>
    </div>
  );
}

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
}: {
  channel: AgentChannel;
  runtimeAgentId: string;
  /** The `?find` search bar, owned by the route so the flag survives a reload. */
  searchOpen?: boolean;
  onCloseSearch?: () => void;
}) {
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

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   *
   * Two pieces on purpose: `first` keeps the words and files as the send effect needs them, `seed`
   * is the same thing shaped as a message so the transcript can draw it — attachments included —
   * before the real send exists.
   */
  const [first] = useState(() => takeFirstMessage(channel.id));
  const [seed] = useState<Message | null>(() =>
    first
      ? {
          content: firstMessageContent(first),
          id: crypto.randomUUID(),
          role: "user",
        }
      : null,
  );

  /** Cleared by the send-on-mount effect without restarting it. */
  const firstRef = useRef(first);

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

  /**
   * The history restore, as a fact the screen can draw: placeholders while it is on its way, a
   * quiet notice when it could not be read. "failed" exists because an unreadable history rendered
   * as an empty transcript is a lie with no way to notice it.
   */
  const [history, setHistory] = useState<"loading" | "ready" | "failed">(
    "loading",
  );

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

      let restored: "ready" | "failed" = "ready";
      try {
        const response = await fetch(
          `/api/copilotkit/threads/${encodeURIComponent(channel.threadId)}/messages?agentId=${encodeURIComponent(runtimeAgentId)}`,
          { credentials: "include" },
        );
        if (!response.ok) {
          restored = "failed";
        } else if (current) {
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
        // An unreadable history is not a reason to block the composer; it is a reason to say so.
        restored = "failed";
      } finally {
        // Release even on join/restore failure; the gate orders messages, not withholds them.
        openJoinGate.current();
        /*
         * A TICK LATER ON PURPOSE. Arrival times must see the restored messages while the
         * conversation still counts as not-live, so a week of history is never stamped with
         * today; the timeout puts this state change in a later commit than the setMessages above.
         */
        if (current) {
          setTimeout(() => {
            if (current) setHistory(restored);
          }, 0);
        }
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
   * When each message first reached this browser. Live only once history has settled, so restored
   * messages are never stamped with the day somebody happened to reopen the channel.
   */
  const messageTimes = useMessageTimes(
    channel.threadId,
    agent.messages.map((message) => message.id),
    history !== "loading",
  );

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const indexMessage = useMutation(indexContinuityMessageMutationOptions());
  const report = (
    text: string,
    agentId: string | null,
    messageId: string,
    role: "user" | "assistant",
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const occurredAt = new Date().toISOString();
    recordActivity.mutate({
      agentId,
      at: occurredAt,
      channelId: channel.id,
      text: trimmed,
    });
    indexMessage.mutate({
      channelId: channel.id,
      threadId: channel.threadId,
      messageId,
      agentId,
      role,
      content: trimmed,
      occurredAt,
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
    skillInstructions: string[],
    attachments: readonly ComposerAttachment[],
    skillIds: readonly string[] = [],
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

    const resolvedContext = await resolveContextReferences(
      trimmed,
      runtimeAgentId,
    );
    if (resolvedContext.context) {
      agent.addMessage({
        content: resolvedContext.context,
        id: crypto.randomUUID(),
        role: "system",
      });
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

    const userMessageId = crypto.randomUUID();
    agent.addMessage({
      /*
       * A string when it is only words, parts when files ride along — the projection on the other
       * side reads both, and a plain string is the shape every agent already expects.
       */
      content:
        attachments.length === 0
          ? trimmed
          : [
              ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
              ...attachments.map(attachmentInputPart),
            ],
      id: userMessageId,
      role: "user",
    });
    report(
      trimmed ||
        `Shared ${attachments.length} file${attachments.length === 1 ? "" : "s"}.`,
      null,
      userMessageId,
      "user",
    );
    for (const skillId of skillIds) {
      void fetch(
        `/api/continuity/skills/${encodeURIComponent(skillId)}/usage`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: runtimeAgentId,
            channelId: channel.id,
            outcome: "invoked",
          }),
        },
      ).catch(() => undefined);
    }

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(agent.messages);
    if (repaired !== agent.messages) {
      agent.setMessages(repaired as typeof agent.messages);
    }

    setRunsInFlight((count) => count + 1);
    beginComputerTask(
      runtimeAgentId,
      trimmed ||
        `Work with ${attachments.length} attached file${attachments.length === 1 ? "" : "s"}`,
    );
    try {
      await copilotkit.runAgent({ agent });
    } finally {
      finishComputerTask(runtimeAgentId);
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
    attachments: readonly ComposerAttachment[] = [],
    skillIds: readonly string[] = [],
  ) => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    setTurnsInFlight((count) => count + 1);
    try {
      await deliver(trimmed, skillInstructions, attachments, skillIds);
    } finally {
      setTurnsInFlight((count) => count - 1);
    }
  };

  useEffect(() => {
    const fail = (message: string) => {
      if (!awaitingReply.current) return;
      awaitingReply.current = false;
      setRunError(message);
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
        if (content && reply?.id) {
          reportRef.current(content, runtimeAgentId, reply.id, "assistant");
        }
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, runtimeAgentId]);

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
   * Run the newest exchange again, AS ITSELF.
   *
   * The transcript is cut back to the last thing the person said and the turn re-runs from there,
   * so the retry IS a retry rather than a new message. The alternative this replaces sent a
   * synthetic "please retry" user turn: it showed up in the transcript as something the person had
   * said, it stayed in the context forever, and each press made the history longer and stranger.
   *
   * The discarded answer is genuinely discarded — from this thread's point of view it never
   * happened, which is exactly what somebody pressing Retry has asked for.
   */
  const retryLatest = useCallback(() => {
    const messages = agent.messages;
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        lastUser = index;
        break;
      }
    }
    if (lastUser < 0) return;

    agent.setMessages(messages.slice(0, lastUser + 1) as typeof agent.messages);
    const lastUserContent = messages[lastUser]?.content;
    const retryGoal =
      typeof lastUserContent === "string"
        ? lastUserContent
        : "Retry the latest request";

    void (async () => {
      setRunError(null);
      awaitingReply.current = true;
      setTurnsInFlight((count) => count + 1);
      setRunsInFlight((count) => count + 1);
      beginComputerTask(runtimeAgentId, retryGoal);
      try {
        // Truncation ends on a user message, but anything older stays repaired the same way a
        // normal send would leave it.
        const repaired = repairUnansweredToolCalls(agent.messages);
        if (repaired !== agent.messages) {
          agent.setMessages(repaired as typeof agent.messages);
        }
        await copilotkit.runAgent({ agent });
      } catch {
        // The run-failure subscriber reports this the same way it reports any turn.
      } finally {
        finishComputerTask(runtimeAgentId);
        setRunsInFlight((count) => count - 1);
        setTurnsInFlight((count) => count - 1);
      }
    })();
  }, [agent, copilotkit, runtimeAgentId]);

  useEffect(() => {
    const retryComputerTask = (event: Event) => {
      const detail = (event as CustomEvent<{ botId?: string }>).detail;
      if (detail?.botId === runtimeAgentId) retryLatest();
    };
    window.addEventListener(COMPUTER_RETRY_EVENT, retryComputerTask);
    return () =>
      window.removeEventListener(COMPUTER_RETRY_EVENT, retryComputerTask);
  }, [retryLatest, runtimeAgentId]);

  /**
   * Send the create-channel seed once, after the join gate opens or the backstop expires.
   */
  useEffect(() => {
    const pending = firstRef.current;
    if (!pending) return;
    firstRef.current = null;

    void (async () => {
      await Promise.race([
        joinGatePromise,
        new Promise((resolve) =>
          setTimeout(resolve, SEND_WITHOUT_JOIN_AFTER_MS),
        ),
      ]);
      await sayRef.current(pending.text, [], pending.attachments);
    })();

    // Keep `seed` in state; transcriptMessages hides it as soon as agent messages exist.
  }, [joinGatePromise]);

  const profile = agentProfiles?.find(
    (candidate) => candidate.id === runtimeAgentId,
  );
  const assistantName = profile?.name ?? channel.name;

  return (
    <ConversationProvider ask={askFromComponent}>
      <ConversationView
        agentId={runtimeAgentId}
        agents={toAgentOptions(agentProfiles, channel.agentIds)}
        assistantName={assistantName}
        // Follow the whole turn, including the pre-run wait and the idle gaps between frontend
        // tool runs. The wire-level flag alone makes the progress line blink out while work remains.
        busy={agent.isRunning || turnsInFlight > 0}
        // The `/` menu exposes only skills granted to this Bot.
        commands={skillCommands}
        // Readiness is handled by `say`; deletion is the only disabled-chat state.
        disabled={!channel.active}
        draftKey={channel.id}
        emptyState={
          <EmptyConversation
            agentId={runtimeAgentId}
            name={assistantName}
            title={profile?.title}
          />
        }
        historyNotice={
          history === "failed"
            ? "Earlier messages could not be loaded. New messages still work."
            : undefined
        }
        messages={transcriptMessages(agent.messages, seed)}
        messageTimes={messageTimes}
        notice={
          channel.active ? null : (
            <p className="pb-2 text-sm text-muted-foreground" role="status">
              This coworker has been deleted. The conversation stays readable,
              but it can no longer reply.
            </p>
          )
        }
        onCloseSearch={onCloseSearch}
        onRetryLatest={retryLatest}
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

          const skillIds = draft.commandIds
            .map(
              (id) =>
                skillCommands.find((command) => command.id === id)?.sourceId,
            )
            .filter((id): id is string => Boolean(id));

          await say(
            draft.text,
            skillInstructions,
            draft.attachments ?? [],
            skillIds,
          );
        }}
        /**
         * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
         * unanswered tool call before the next turn.
         */
        onStop={() => {
          awaitingReply.current = false;
          copilotkit.stopAgent({ agent });
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
        restoring={history === "loading"}
        searchOpen={searchOpen}
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
