import type { Message } from "@ag-ui/core";
import {
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconPaperclip,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { searchableMessageIds } from "@/components/channels/chat-messages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AgentOption,
  type CommandOption,
  Composer,
  type ComposerDraft,
  type ComposerInsertion,
  type QueueAction,
  type QueuedMessage,
  reduceQueue,
} from "@/components/channels/composer";

function QueuedTray({
  onRemove,
  queued,
}: {
  onRemove: (id: string) => void;
  queued: readonly QueuedMessage[];
}) {
  return (
    <section
      aria-label="Messages waiting to send"
      className="mb-2 overflow-hidden rounded-xl border bg-muted/30"
    >
      <header className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-medium">
        <IconClock className="size-3.5 text-primary" />
        Up next
        <span className="font-normal text-muted-foreground">
          · sends when the current task finishes
        </span>
      </header>
      <ol className="divide-y">
        {queued.map((message) => (
          <li
            className="flex min-w-0 items-center gap-2 px-3 py-2"
            key={message.id}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{message.text || "Attachment"}</p>
              {message.attachments.length > 0 ? (
                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <IconPaperclip className="size-3" />
                  {message.attachments.length} attachment
                  {message.attachments.length === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
            <Button
              aria-label={`Remove queued message: ${message.text || "attachment"}`}
              onClick={() => onRemove(message.id)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <IconX />
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ConversationView({
  messages,
  activity,
  assistantName,
  busy = false,
  notice,
  agents = [],
  commands,
  disabled = false,
  pending = false,
  stopped,
  stoppable,
  queueWhileBusy = false,
  onSubmit,
  onStop,
  channelId,
  draftKey,
  searchOpen = false,
  onCloseSearch,
  onRetryLatest,
  onBranchMessage,
}: {
  messages: readonly Message[];
  /** Task progress, approvals, and other live work shown in the active turn. */
  activity?: ReactNode;
  assistantName?: string;
  busy?: boolean;
  /** Shown above the composer. An error, or why this conversation is read-only. */
  notice?: ReactNode;
  agents?: readonly AgentOption[];
  /**
   * The `/` menu for this Bot's granted skills, supplied by the route that owns grant loading.
   */
  commands?: readonly CommandOption[];
  disabled?: boolean;
  /**
   * A turn is in flight: the Bot has been asked something and has not come back yet.
   *
   * It has to mean the TURN and not the run underneath it. A turn that uses the browser is several
   * runs in a row with the agent reporting itself idle between them, and a caller that passes its
   * agent's run status straight through will tell this component the conversation is free in the
   * middle of an answer. `queueWhileBusy` is the part that cannot survive that, because the queue
   * drains on this falling.
   */
  pending?: boolean;
  /** Why the last turn ended without an answer. Drawn at the end of the transcript, not here. */
  stopped?: string;
  /**
   * There is a run for Stop to abort, which is a narrower fact than `pending` and is the honest one
   * to draw a Stop button from. Defaults to `pending` for a caller with no gap between the two.
   */
  stoppable?: boolean;
  /**
   * Let somebody type at a Bot that is already working, and run what they typed when it finishes.
   *
   * Off by default, and asked for rather than assumed, because it is only true of a conversation
   * that will still be here when the turn ends. The compose screen creates the channel on send and
   * navigates away; a message parked there would go down with the unmount, and a message that
   * silently disappears is a worse answer than a send button that will not go.
   *
   * The other place somebody talks to a Bot, the direct `/bot` chat, does not get this either, and
   * not by a decision made here: that screen draws CopilotKit's own chat rather than this composer,
   * so there is nothing on it for this flag to reach. Giving it the same affordance means either
   * moving it onto this composer or asking for it upstream, and neither is a queue.
   */
  queueWhileBusy?: boolean;
  onSubmit: (draft: ComposerDraft) => void | Promise<void>;
  /** Stop the Bot mid-answer; forwarded to turn the send button into a stop button. */
  onStop?: () => void;
  channelId?: string;
  draftKey?: string;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  onRetryLatest?: () => void;
  onBranchMessage?: (text: string, role: "user" | "assistant") => void;
}) {
  /*
   * THE QUEUE LIVES HERE BECAUSE BOTH HALVES OF IT DO.
   *
   * The composer is what knows a turn is in flight and is where a message is typed; the transcript
   * is where the person has to be able to see that it landed. This is the nearest thing that owns
   * them both, and putting the list in either one would mean handing it straight back out again.
   *
   * See `composer/queue.ts` for what this state is worth: it is memory in one tab, it does not
   * survive a reload, and it is not an outbox.
   */
  const [queued, setQueued] = useState<readonly QueuedMessage[]>([]);
  const queuedRef = useRef<readonly QueuedMessage[]>(queued);

  /**
   * A turn this screen started and has not seen finish.
   *
   * It is a backstop under `pending` rather than the thing that makes `pending` usable. A caller
   * that reports the turn honestly already covers the gap between `onSubmit` being called and the
   * turn showing up in its own state; one that does not leaves a gap in which a person typing
   * quickly would have their second message read as the start of a second turn, two runs at once on
   * one thread racing each other's history.
   *
   * It cannot be the whole answer, and it was a mistake to let it look like one. This only knows
   * about turns that came in through the composer. A channel starts turns by other routes — the
   * first message of a new channel, a button inside a rendered component — and for those the only
   * thing standing between a parked correction and a mid-answer drain is what the caller passes as
   * `pending`.
   *
   * The composer tracks the same await for its own send button. Two trackers of one promise, which
   * is duplication, and they cannot drift: they rise in the same tick and fall on the same resolve.
   * The alternative is a callback out of the composer announcing an edge, which is a larger surface
   * for the same fact.
   */
  const [running, setRunning] = useState(false);
  const inFlight = pending || running;
  const [searchQuery, setSearchQuery] = useState("");
  const [insertion, setInsertion] = useState<ComposerInsertion | undefined>();
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchMatches = searchableMessageIds(messages, searchQuery);
  const boundedSearchIndex =
    searchMatches.length === 0
      ? 0
      : Math.min(activeSearchIndex, searchMatches.length - 1);
  const activeSearchMessageId = searchMatches[boundedSearchIndex];
  const editMessage = useCallback((text: string) => {
    setInsertion({ id: crypto.randomUUID(), mode: "replace", text });
  }, []);
  const quoteMessage = useCallback(
    (text: string, role: "user" | "assistant") => {
      const label = role === "assistant" ? "Coworker" : "You";
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      setInsertion({
        id: crypto.randomUUID(),
        mode: "append",
        text: `_${label} wrote:_\n${quoted}\n\n`,
      });
    },
    [],
  );

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const moveSearch = (direction: -1 | 1) => {
    if (searchMatches.length === 0) return;
    setActiveSearchIndex(
      (current) =>
        (current + direction + searchMatches.length) % searchMatches.length,
    );
  };

  /**
   * Every change to the queue goes through here, so the ref and the state can never disagree.
   *
   * The ref is what the decisions read. React state is a render behind, and both callers below have
   * to know what is actually queued at the moment they are called rather than at the moment they
   * were last rendered — one of them is an effect firing on the same commit that emptied the list.
   */
  const apply = useCallback((action: QueueAction) => {
    const next = reduceQueue(queuedRef.current, action);
    queuedRef.current = next.queue;
    setQueued(next.queue);
    return next.run;
  }, []);

  const start = async (draft: ComposerDraft) => {
    setRunning(true);
    try {
      await onSubmit(draft);
    } finally {
      setRunning(false);
    }
  };
  /** Read through a ref so an inline `onSubmit` from the route does not re-run the drain effect. */
  const startRef = useRef(start);
  startRef.current = start;

  /**
   * Send now, or park it. Which one is the composer's call: it holds the only accurate view of
   * whether a turn is in flight, and `reduceQueue` holds what follows from the answer.
   */
  const submit = useCallback(
    (draft: ComposerDraft, whileBusy: boolean) => {
      const run = apply({
        busy: whileBusy,
        draft,
        id: crypto.randomUUID(),
        type: "submit",
      });
      return run ? startRef.current(run) : undefined;
    },
    [apply],
  );

  /**
   * The turn ended. Whatever was waiting for it goes now, as one message.
   *
   * KEYED ON THE TURN BEING OVER AND NOT ON HOW IT ENDED, which is what makes Stop useful rather
   * than final: a person who parks a correction and then presses Stop has said "not that, this",
   * and this is the line that hears the second half of it. A finished run, a failed one and a
   * stopped one all arrive here the same way, so there is no stop path to forget.
   *
   * The one edge it watches is `inFlight` falling, and it does not watch the queue. Nothing can be
   * parked while the conversation is idle: the composer only parks when it believes a turn is in
   * flight, and it believes that from the same value this effect reads. A queue that grew here
   * without a turn to wait for would be a queue that never drains, so if that ever becomes possible
   * this dependency list is where it will show up.
   *
   * IT REFUSES WHILE THE CONVERSATION IS DISABLED, which is the one thing "however it ended" must
   * not be read to cover. A coworker deleted mid-turn takes the channel with it: the composer stops
   * accepting messages and the notice under it says the conversation can no longer reply, and a
   * queue that drained anyway would post one more user turn into a channel the screen has already
   * said is finished. The cost is that anything parked when that happens stays on screen unrun,
   * under a notice that explains why, which is the honest half of the trade.
   */
  useEffect(() => {
    if (disabled || inFlight || queuedRef.current.length === 0) {
      return;
    }
    const run = apply({ type: "settle" });
    if (!run) {
      return;
    }
    void startRef.current(run).catch(() => {
      // Swallowed on purpose, and only here. A failed send from the composer throws so the composer
      // can put the words back in the box; there is no box to put these back into, and the screen
      // already reports a failed turn through its own notice.
    });
  }, [apply, disabled, inFlight]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-1 min-h-0">
        {/*
         * The command NAMES, joined, rather than the option objects.
         *
         * The transcript needs them only to tell a real skill chip from a message that happens to
         * begin with a slash, and its message rows are memoised on primitives — handing them an
         * array would give every message a new prop identity on each refetch and re-render the whole
         * conversation to change nothing.
         */}
        <ChatTranscript
          activity={activity}
          assistantName={assistantName}
          busy={busy}
          channelId={channelId}
          commandNames={(commands ?? [])
            .map((command) => command.name)
            .join(",")}
          messages={messages}
          onBranchMessage={onBranchMessage}
          onEditMessage={editMessage}
          onQuoteMessage={quoteMessage}
          onRetryMessage={onRetryLatest}
          searchQuery={searchOpen ? searchQuery : ""}
          activeSearchMessageId={searchOpen ? activeSearchMessageId : undefined}
          {...(stopped ? { stopped } : {})}
        />
      </div>
      <div className="max-w-2xl mx-auto w-full px-0 pb-4 shrink-0">
        {searchOpen ? (
          <div className="mb-2 flex items-center gap-1 rounded-xl border bg-card p-1.5 shadow-sm">
            <IconSearch className="ml-1 size-4 shrink-0 text-muted-foreground" />
            <Input
              aria-label="Search this conversation"
              className="h-8 border-0 shadow-none focus-visible:ring-0"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setActiveSearchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchQuery("");
                  onCloseSearch?.();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  moveSearch(event.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Search messages"
              ref={searchInputRef}
              value={searchQuery}
            />
            <span
              className="min-w-14 text-center text-xs text-muted-foreground"
              role="status"
            >
              {searchQuery.trim()
                ? searchMatches.length
                  ? `${boundedSearchIndex + 1} of ${searchMatches.length}`
                  : "No matches"
                : ""}
            </span>
            <Button
              aria-label="Previous match"
              disabled={searchMatches.length === 0}
              onClick={() => moveSearch(-1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <IconChevronUp />
            </Button>
            <Button
              aria-label="Next match"
              disabled={searchMatches.length === 0}
              onClick={() => moveSearch(1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <IconChevronDown />
            </Button>
            <Button
              aria-label="Close conversation search"
              onClick={() => {
                setSearchQuery("");
                onCloseSearch?.();
              }}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <IconX />
            </Button>
          </div>
        ) : null}
        {queued.length > 0 ? (
          <QueuedTray
            onRemove={(id) => apply({ id, type: "remove" })}
            queued={queued}
          />
        ) : null}
        {notice}
        <Composer
          agents={agents}
          {...(commands ? { commands } : {})}
          className="w-full mt-auto"
          compact
          disabled={disabled}
          draftKey={draftKey}
          insertion={insertion}
          onQueue={
            queueWhileBusy
              ? (draft) => {
                  submit(draft, true);
                }
              : undefined
          }
          onStop={onStop}
          onSubmit={(draft) => submit(draft, false)}
          /*
           * `inFlight` rather than the `pending` this was given. A drained turn is started from the
           * effect above rather than from the composer, so the composer's own send tracking knows
           * nothing about it — told only `pending`, it would believe the conversation was idle for
           * as long as the drained run took to start, and the next thing typed would open a third
           * turn instead of joining the queue.
           */
          pending={inFlight}
          /*
           * The caller's answer, not `inFlight`. `running` is true from the instant `start` is
           * entered, which is before `onSubmit` has done anything at all, so a Stop drawn from
           * `inFlight` appears while there is still nothing to stop — the press is swallowed and the
           * message goes anyway.
           */
          stoppable={stoppable ?? pending}
        />
      </div>
    </div>
  );
}
