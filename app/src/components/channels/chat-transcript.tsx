import type { Message } from "@ag-ui/core";
import {
  CopilotChatReasoningMessage,
  useRenderToolCall,
} from "@copilotkit/react-core/v2";
import {
  IconBox,
  IconCheck,
  IconCopy,
  IconFile,
  IconPencil,
  IconQuote,
  IconRefresh,
} from "@tabler/icons-react";
import Avatar from "boring-avatars";
import { motion, useReducedMotion } from "motion/react";
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageFooter,
  Message as MessageRow,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import {
  markdownComponents,
  markdownControls,
  markdownLineNumbers,
} from "@/lib/markdown";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, forDisplay, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import {
  shouldShowThinking,
  toVisibleChatItems,
  type VisibleAttachment,
  type VisibleChatItem,
} from "./chat-messages";
import type { QueuedMessage } from "./composer";
import { ToolRenderBoundary } from "./tool-boundary";
import { ToolLine } from "./tool-line";

type ChatTranscriptProps = {
  busy?: boolean;
  /** Comma-separated `/` command names, used to tell a skill chip from a leading slash. */
  commandNames?: string;
  messages: ReadonlyArray<Readonly<Message>>;
  /**
   * Typed while the Bot had the turn, and waiting for it to finish. Empty on a screen that does not
   * offer queueing at all.
   */
  queued?: readonly QueuedMessage[];
  /** Take one back before it runs. Without it a queued line is shown but cannot be undone. */
  onRemoveQueued?: (id: string) => void;
  /**
   * Why the last turn ended without an answer, if it did.
   *
   * A sentence rather than a flag, because the reasons are not interchangeable: a Bot that refused,
   * a Bot whose endpoint is down and a Bot that simply stopped talking are three different things to
   * be told, and only the thing that ended the turn knows which one happened.
   */
  stopped?: string;
  /** Identity the coworker's turns are drawn under: avatar seed and displayed name. */
  agentId?: string;
  assistantName?: string;
  /**
   * When each message was first seen by this browser, keyed by message id. Sparse on purpose:
   * a message with no entry renders no time rather than a guessed one.
   */
  messageTimes?: Readonly<Record<string, number>>;
  /** Drawn instead of an empty transcript once it is known to really be empty. */
  emptyState?: ReactNode;
  /** History is still being restored; the transcript shows placeholders rather than nothing. */
  restoring?: boolean;
  /** Earlier messages could not be loaded — said at the top, where they would have been. */
  historyNotice?: string;
  /** Load a message into the composer as a quote. */
  onQuote?: (text: string, role: "user" | "assistant") => void;
  /** Load a user message back into the composer to fix and resend. */
  onEdit?: (text: string) => void;
  /** Re-run the latest exchange. Offered on the newest answer and on a stopped turn. */
  onRetryLatest?: () => void;
  /** Message ids matching the open conversation search, comma-joined for memo-friendliness. */
  searchMatchIds?: string;
  activeSearchMessageId?: string;
};

/** One shared empty array, so a screen without a queue does not hand down a new one per render. */
const EMPTY_QUEUE: readonly QueuedMessage[] = [];
const EMPTY_TIMES: Readonly<Record<string, number>> = {};

/**
 * Split a person's message into the skill they invoked and the rest of what they typed.
 *
 * ONLY A KNOWN COMMAND COUNTS. "/etc/hosts is broken" is a sentence, not a skill, and drawing a chip
 * around it would invent a thing that never happened. The names come from the same list the `/` menu
 * was built from, so this stays true as skills are granted and revoked.
 *
 * The trigger only opens at the start of a line, so the chip is the first token or there is none.
 */
function splitSkillChip(
  text: string,
  commandNames: string,
): { chip: string; rest: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(\s|$)/.exec(text);
  if (!match) {
    return null;
  }
  const known = commandNames.split(",").filter(Boolean);
  if (!known.includes(match[1])) {
    return null;
  }
  return { chip: match[1], rest: text.slice(match[0].length) };
}

function formatTime(epoch: number): string {
  return new Date(epoch).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function dayLabel(epoch: number): string {
  const now = Date.now();
  if (sameDay(epoch, now)) return "Today";
  if (sameDay(epoch, now - 24 * 60 * 60 * 1000)) return "Yesterday";
  return new Date(epoch).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Clipboard with a fallback for the contexts the async API refuses: a plain-HTTP deployment, an
 * older WebView. The fallback writes through a throwaway textarea, which is ugly and works.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/**
 * The Bot has the turn and has produced nothing yet.
 *
 * THE GAP THIS FILLS IS THE WORST ONE IN THE CONVERSATION. Between pressing send and the first token
 * there was `aria-busy` and nothing else: announced to a screen reader, invisible to everybody else.
 * A person who has just asked something watches their own message sit there, and a Bot that is
 * thinking is indistinguishable from a Bot that failed silently — which this app has shipped before.
 *
 * It borrows the shimmer a running tool line uses, so "working on it" reads the same whether the
 * work is a tool call or a model that has not spoken yet. After a few seconds it starts counting,
 * which is the difference between "still working" and "you should wonder".
 */
function Thinking() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <p
      className="flex items-center gap-2 text-muted-foreground text-sm"
      // `status` rather than `alert`: this is progress, not something that interrupts what somebody
      // is doing. The text says it, so a screen reader is told the same thing the orb implies.
      data-testid="transcript-thinking"
      role="status"
    >
      {/*
       * The shimmer lives on the TEXT SPAN, not the paragraph: `background-clip: text` makes the
       * paragraph's own colour transparent, and the orb sitting inside a transparent-text element
       * is fine (it paints backgrounds, not glyphs) — but keeping them separate means neither
       * effect has to know the other exists.
       */}
      <span aria-hidden className="thinking-orb-halo">
        <span className="thinking-orb" />
      </span>
      <span className="tool-line-running">
        Thinking{seconds >= 5 ? ` · ${seconds}s` : ""}
      </span>
    </p>
  );
}

/**
 * The turn ended and no answer came.
 *
 * In the same slot as `Thinking`, and for the same reason it is there: the person is looking at the
 * bottom of the transcript, immediately under their own message, because that is where the answer
 * was going to appear. Saying so above the composer put the explanation in a different part of the
 * screen from the gap it explains, and left the last thing in the conversation looking unfinished.
 *
 * NOT A MESSAGE, deliberately. It has no id, is never anchored, and is gone the moment the next turn
 * starts. Making it a transcript row would put a sentence into the conversation that nobody said,
 * and the conversation is sent back to the model on the next turn, so the Bot would then read its
 * own obituary as something it had written.
 *
 * Retry sits beside the reason because this is the moment somebody wants it: the answer is missing,
 * the explanation is in front of them, and the alternative is retyping the question.
 */
function Stopped({
  reason,
  onRetry,
}: {
  reason: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <p
      className="flex items-center gap-3 text-destructive text-sm"
      data-testid="transcript-stopped"
      role="alert"
    >
      <span>{reason}</span>
      {onRetry ? (
        <button
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-foreground text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onRetry}
          type="button"
        >
          <IconRefresh className="size-3" />
          Retry
        </button>
      ) : null}
    </p>
  );
}

/**
 * Something the person said while the Bot was working, waiting its turn.
 *
 * IT IS DRAWN AS THEIR MESSAGE, NOT AS A NOTICE ABOUT ONE. The whole point of letting somebody type
 * mid-turn is that they can see their words landed, and a status line saying "1 message queued"
 * does not do that — they would still be wondering whether the sentence they typed is the sentence
 * that will run. So it is the same bubble, in the same column, with the same wrapping, and only two
 * things say it has not run yet: it is faded, and it says so underneath.
 *
 * The footer carries the taking-back too, because that is where the reader's eye already is once
 * they have decided this was a mistake, and because a control on the bubble itself would have to
 * hover over the words it is offering to delete.
 */
function Queued({
  text,
  attachmentCount,
  onRemove,
}: {
  text: string;
  attachmentCount: number;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <Bubble align="end" className="opacity-60" variant="muted">
          <BubbleContent>
            {/* Shown exactly as typed, for the same reason a sent message is. */}
            <span className="whitespace-pre-wrap">
              {text ||
                `${attachmentCount} file${attachmentCount === 1 ? "" : "s"}`}
            </span>
          </BubbleContent>
        </Bubble>
        <MessageFooter>
          {/*
           * `status` rather than `alert`, matching the thinking line: a person who has just chosen
           * to queue something is not being interrupted by the news that it is queued.
           */}
          <span role="status">
            Queued
            {attachmentCount > 0 && text
              ? ` · ${attachmentCount} file${attachmentCount === 1 ? "" : "s"}`
              : ""}
          </span>
          {onRemove ? (
            <button
              /*
               * The sentence it deletes, in the name. Three parked corrections put three buttons
               * called "Remove" in a row, and somebody reading by name alone is told what they can
               * do and nothing about which one it would happen to. The visible word stays short
               * because the bubble it sits under is the answer for everybody who can see it.
               */
              aria-label={`Remove queued message: ${text || "attachment"}`}
              className="ml-2 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={onRemove}
              type="button"
            >
              Remove
            </button>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </MessageRow>
  );
}

/**
 * Put the newest queued message where the person who just typed it can see it.
 *
 * WITHOUT THIS THE AFFORDANCE IS INVISIBLE EXACTLY WHEN IT MATTERS. The scroller holds its anchor on
 * the turn being answered rather than following the bottom, so during a long streamed answer the
 * transcript sits a screen or so above the end — and a line appended below it lands off screen.
 *
 * Keyed on the newest queued id rather than on the list, so it does not fire again for every chunk
 * of the answer still streaming above it.
 */
function ScrollNewestQueuedIntoView({ newest }: { newest: string | null }) {
  const { scrollToEnd } = useMessageScroller();

  useEffect(() => {
    if (newest === null) {
      return;
    }
    scrollToEnd();
  }, [newest, scrollToEnd]);

  return null;
}

/**
 * Bring the active search match on screen, through the scroller's own scroll machinery.
 *
 * `scrollToMessage` rather than a DOM query and `scrollIntoView`: the scroller owns this viewport's
 * position, and two systems scrolling one element at once is where search jumps used to fight the
 * autoscroll.
 */
function ScrollSearchMatchIntoView({ id }: { id: string | undefined }) {
  const { scrollToMessage } = useMessageScroller();

  useEffect(() => {
    if (!id) return;
    scrollToMessage(id, { align: "center", behavior: "smooth" });
  }, [id, scrollToMessage]);

  return null;
}

/**
 * How many of the newest turns cascade when a channel is opened, and how far apart.
 *
 * The tail rather than the head: opening a channel lands you at the bottom, so these are the ones
 * actually on screen. Staggering from the top of a long history would spend the whole budget on
 * messages nobody can see and leave the visible ones arriving last.
 *
 * Twelve at 40ms is 440ms of cascade before the last one starts. Past roughly half a second this
 * stops reading as settling and starts reading as waiting.
 */
const FIRST_PAINT_STAGGER_COUNT = 12;
const FIRST_PAINT_STAGGER_SECONDS = 0.04;

/**
 * Decide, once per message, whether it waits its turn.
 *
 * FROZEN PER ID ON PURPOSE. `delay` is a prop on a memoised component, so a value that changed
 * between renders would break the memo that makes the streaming path cheap — and worse, a message
 * whose delay changed could replay its entrance mid-stream. Each id is decided the first time it is
 * seen and never revisited.
 *
 * `settled` flips after the first render that has any items, which is NOT the first render: history
 * is restored asynchronously, so a channel's transcript is empty for a beat. Anything appearing
 * after that is a live turn and is given no delay at all.
 */
function createFirstPaintDelays() {
  const decided = new Map<string, number>();
  let settled = false;

  return {
    settle() {
      settled = true;
    },
    delayFor(id: string, index: number, total: number): number {
      const known = decided.get(id);
      if (known !== undefined) {
        return known;
      }
      const offset = total - FIRST_PAINT_STAGGER_COUNT;
      const place = index - Math.max(0, offset);
      const delay =
        settled || place < 0 ? 0 : place * FIRST_PAINT_STAGGER_SECONDS;
      decided.set(id, delay);
      return delay;
    },
  };
}

/**
 * A turn arriving in the transcript.
 *
 * WHY IT ANIMATES AT ALL: a message currently pops into existence at full opacity, and the eye has
 * nothing to follow from the composer to the transcript. This bridges that, and nothing more — it
 * is not decoration on something the reader is trying to read.
 *
 * IT RUNS ONCE, ON MOUNT. `initial`/`animate` fire when the element mounts, and the memoised parents
 * mean a streaming answer re-renders without remounting — so the fade plays when the message first
 * appears and never again while its text is still arriving. Animating per chunk would strobe.
 *
 * TRANSFORM AND OPACITY ONLY, so the scroller can still measure. `MessageScroller` sizes items and
 * places its anchor and spacer from layout; a transform is composited and changes no layout box, so
 * a message can fade in without moving the thing the scroller just measured.
 *
 * The full transform string rather than motion's `y` shorthand: the shorthand is not hardware
 * accelerated and drops frames exactly when the main thread is busy, which here is while a reply is
 * streaming.
 *
 * STAGGERED ONLY ON THE FIRST PAINT OF A CHANNEL. A turn sent mid-conversation arrives alone and
 * must not wait behind anything, so `delay` is zero for it. Opening a channel is the one moment the
 * whole history mounts at once, and cascading the last few reads as the conversation settling
 * rather than as a page appearing all at once. `createFirstPaintDelays` decides which is which.
 */
function Arriving({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      /*
       * `data-slot` IS LOAD-BEARING, NOT DECORATION. `MessageContent` right-aligns a person's own
       * message with `group-data-[align=end]/message:*:data-slot:self-end` — a selector that reaches
       * DIRECT CHILDREN CARRYING A data-slot. Wrapping the bubble in a plain div made this the direct
       * child, the selector matched nothing, and every message a person sent quietly moved to the
       * left column and read as though the Bot had said it.
       */
      data-slot="message-arriving"
      /*
       * FULL WIDTH, AND A FLEX COLUMN, because that is what it displaced. `Bubble` is
       * `w-fit max-w-[80%]` and aligns itself with `group-data-[align=end]/message:self-end`. Both
       * need the parent this wrapper replaced: against a shrink-to-fit box the 80% resolves against
       * the bubble's own width and short messages wrap for no reason, and `self-end` does nothing at
       * all outside a flex container.
       */
      className="flex w-full flex-col"
      initial={{
        opacity: 0,
        // Reduced motion keeps the fade and drops the movement: gentler, not absent.
        transform: shouldReduceMotion ? "none" : "translateY(8px)",
      }}
      transition={{
        // Reduced motion gets the fade with no queue: a cascade is movement too, just spread over
        // time, and somebody who asked for less of it should not wait for their history to arrive.
        delay: shouldReduceMotion ? 0 : delay,
        duration: ENTRANCE_SECONDS,
        ease: EASE_OUT,
      }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The coworker's name, face, and — when this browser saw the turn arrive — the time, drawn once at
 * the top of each of its turns rather than repeated on every bubble.
 */
function TurnHeader({
  agentId,
  name,
  time,
}: {
  agentId?: string | undefined;
  name: string;
  time?: number | undefined;
}) {
  return (
    <div className="flex items-center gap-2 pt-1 pb-1.5">
      <span
        aria-hidden
        className="size-5 shrink-0 overflow-hidden rounded-full"
      >
        <Avatar className="size-full" name={agentId ?? name} size={20} />
      </span>
      <span className="font-medium text-foreground text-xs">{name}</span>
      {time !== undefined ? (
        <span className="text-[11px] text-muted-foreground">
          {formatTime(time)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A boundary between days, drawn only where both sides carry a real arrival stamp.
 *
 * Messages this browser never saw arrive have no honest date, and a separator computed from a
 * guess would file a week of history under today. Missing stamps mean no line, not a wrong one.
 */
function DaySeparator({ label }: { label: string }) {
  // A styled line with a visible label; the label itself is what a screen reader needs, so the
  // rules are decoration and the row claims no ARIA role it cannot fully honour.
  return (
    <div className="flex items-center gap-3 py-1">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Copy, quote, edit, retry — under the bubble, visible on hover and to keyboard focus.
 *
 * Every button names its message in the accessible name where the action is ambiguous by itself;
 * visually the bubble above is the context.
 */
function MessageActions({
  align,
  onCopy,
  copied,
  onQuote,
  onEdit,
  onRetry,
  time,
}: {
  align: "start" | "end";
  onCopy: () => void;
  copied: boolean;
  onQuote?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  time?: number | undefined;
}) {
  const button =
    "inline-flex items-center gap-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <span
      className={`flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100 ${
        align === "end" ? "justify-end" : ""
      }`}
    >
      {time !== undefined ? (
        <span className="mr-1 text-[11px]">{formatTime(time)}</span>
      ) : null}
      <button
        aria-label={copied ? "Copied" : "Copy message"}
        className={button}
        onClick={onCopy}
        title="Copy"
        type="button"
      >
        {copied ? (
          <IconCheck className="size-3.5 text-primary" />
        ) : (
          <IconCopy className="size-3.5" />
        )}
      </button>
      {onQuote ? (
        <button
          aria-label="Quote in reply"
          className={button}
          onClick={onQuote}
          title="Quote in reply"
          type="button"
        >
          <IconQuote className="size-3.5" />
        </button>
      ) : null}
      {onEdit ? (
        <button
          aria-label="Edit and resend"
          className={button}
          onClick={onEdit}
          title="Edit and resend"
          type="button"
        >
          <IconPencil className="size-3.5" />
        </button>
      ) : null}
      {onRetry ? (
        <button
          aria-label="Retry this answer"
          className={button}
          onClick={onRetry}
          title="Retry"
          type="button"
        >
          <IconRefresh className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}

/** Files a message carried: images inline, everything else a named chip. */
function MessageAttachments({
  attachments,
}: {
  attachments: readonly VisibleAttachment[];
}) {
  if (attachments.length === 0) return null;
  return (
    <ul
      aria-label="Message attachments"
      className="mt-1.5 flex max-w-full flex-wrap gap-1.5 group-data-[align=end]/message:justify-end"
      data-slot="message-attachments"
    >
      {attachments.map((attachment) =>
        attachment.kind === "image" && attachment.data ? (
          <li key={attachment.id}>
            <figure className="max-w-full">
              <img
                alt={attachment.name}
                className="max-h-64 max-w-full rounded-lg border object-contain"
                src={`data:${attachment.mimeType};base64,${attachment.data}`}
              />
              <figcaption className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {attachment.name}
              </figcaption>
            </figure>
          </li>
        ) : (
          <li
            className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs"
            key={attachment.id}
          >
            <IconFile className="size-3 shrink-0" />
            <span className="max-w-56 truncate">{attachment.name}</span>
          </li>
        ),
      )}
    </ul>
  );
}

function attachmentsKey(
  attachments: readonly VisibleAttachment[] | undefined,
): string {
  return attachments ? attachments.map((item) => item.id).join(",") : "";
}

type TranscriptMessageProps = {
  commandNames?: string;
  delay: number;
  role: "user" | "assistant";
  text: string;
  attachments?: readonly VisibleAttachment[] | undefined;
  /** First seen by this browser; undefined renders no time at all. */
  time?: number | undefined;
  searchTint?: "match" | "active" | undefined;
  onQuote?: ((text: string, role: "user" | "assistant") => void) | undefined;
  onEdit?: ((text: string) => void) | undefined;
  /** Present only on the newest answer: retrying anything older would rewrite history. */
  onRetry?: (() => void) | undefined;
};

/**
 * One drawn message, and it is memoised on cheap comparisons ON PURPOSE.
 *
 * A streamed answer changes `messages` on every chunk, and `toVisibleChatItems` builds fresh objects
 * from it each time — so a memo comparing item objects would miss on every single one and buy
 * nothing. The comparator below checks the primitives and reduces attachments to their id list,
 * which is stable per message, so an untouched message compares equal and is skipped.
 *
 * MEASURED, BEFORE AND AFTER. One reply into a 25-message thread cost 76 transcript renders and
 * 1,890 message renders, because every message in the history re-parsed its markdown on every
 * chunk. That is the jank: the scroll was following a list that rebuilt itself 76 times.
 *
 * It is also what keeps the entrance honest — no remount means no replay of the fade.
 *
 * The callbacks are part of the comparison, which makes their stability the CALLER'S obligation:
 * an inline closure from the screen above would re-render every message on every keystroke.
 */
const TranscriptMessage = memo(
  function TranscriptMessage({
    commandNames = "",
    delay,
    role,
    text,
    attachments,
    time,
    searchTint,
    onQuote,
    onEdit,
    onRetry,
  }: TranscriptMessageProps) {
    const isUser = role === "user";
    const align = isUser ? "end" : "start";
    const invoked = isUser ? splitSkillChip(text, commandNames) : null;
    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
      () => () => {
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
      },
      [],
    );

    const handleCopy = () => {
      void copyText(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      });
    };

    return (
      <MessageRow align={align}>
        <MessageContent>
          <Arriving delay={delay}>
            <Bubble
              align={align}
              className={
                searchTint === "active"
                  ? "rounded-xl ring-3 ring-primary/40"
                  : searchTint === "match"
                    ? "rounded-xl bg-primary/5 ring-1 ring-primary/20"
                    : undefined
              }
              variant={isUser ? "muted" : "ghost"}
            >
              <BubbleContent>
                {isUser ? (
                  // A person's own message is shown exactly as they typed it. Rendering it as markdown
                  // would silently reformat what they said, and an asterisk in a sentence is not
                  // emphasis. The chip is the one exception, and it is not reformatting: it is drawing
                  // the thing that was already a chip in the composer as a chip here too, so the
                  // transcript shows a skill was used rather than a slash that was typed.
                  <span className="whitespace-pre-wrap">
                    {invoked ? (
                      <>
                        {/*
                         * The same icon the sidebar uses for Skills, so the badge says WHAT KIND of
                         * thing was invoked before it says which one. `inline-flex` with
                         * `align-middle` rather than a block: this sits mid-sentence, and a badge that
                         * breaks the line it is in reads as a separate message.
                         */}
                        <span className="mr-1 inline-flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 align-middle font-mono text-foreground/80 text-xs">
                          <IconBox className="size-3 shrink-0" />/{invoked.chip}
                        </span>
                        {invoked.rest}
                      </>
                    ) : (
                      text
                    )}
                  </span>
                ) : (
                  /*
                   * A Bot's prose is markdown, and it arrives in pieces.
                   *
                   * Rendered with a streaming-aware renderer rather than an ordinary one: half a fenced
                   * code block or an unclosed bold marker is the NORMAL state for most of a run, and a
                   * plain markdown parser draws that as literal asterisks and backticks until the
                   * closing token arrives, so the answer visibly rewrites itself as it lands. This
                   * closes them for the duration.
                   */
                  <Streamdown
                    components={markdownComponents}
                    controls={markdownControls}
                    lineNumbers={markdownLineNumbers}
                  >
                    {text}
                  </Streamdown>
                )}
              </BubbleContent>
            </Bubble>
            {attachments && attachments.length > 0 ? (
              <MessageAttachments attachments={attachments} />
            ) : null}
          </Arriving>
          <MessageFooter>
            <MessageActions
              align={align}
              copied={copied}
              onCopy={handleCopy}
              onEdit={isUser && onEdit ? () => onEdit(text) : undefined}
              onQuote={onQuote ? () => onQuote(text, role) : undefined}
              onRetry={!isUser && onRetry ? onRetry : undefined}
              // Only user rows carry their time here; a coworker's turn shows it in the header.
              time={isUser ? time : undefined}
            />
          </MessageFooter>
        </MessageContent>
      </MessageRow>
    );
  },
  (prev, next) =>
    prev.role === next.role &&
    prev.text === next.text &&
    prev.delay === next.delay &&
    prev.commandNames === next.commandNames &&
    prev.time === next.time &&
    prev.searchTint === next.searchTint &&
    prev.onQuote === next.onQuote &&
    prev.onEdit === next.onEdit &&
    prev.onRetry === next.onRetry &&
    attachmentsKey(prev.attachments) === attachmentsKey(next.attachments),
);

/**
 * The readable summary Codex exposes while it works.
 *
 * This deliberately uses CopilotKit's own reasoning disclosure instead of inventing a second chat
 * language for channels. It opens while the latest thought is streaming, collapses when the answer
 * begins, and remains available as a "Thought for …" row afterward — the same behaviour as the
 * original packaged OpenBot chat on `/bot`.
 */
const TranscriptReasoning = memo(function TranscriptReasoning({
  delay,
  id,
  streaming,
  text,
}: {
  delay: number;
  id: string;
  streaming: boolean;
  text: string;
}) {
  const message = useMemo(
    () => ({ id, role: "reasoning" as const, content: text }),
    [id, text],
  );

  return (
    <Arriving delay={delay}>
      <CopilotChatReasoningMessage
        isRunning={streaming}
        message={message}
        messages={[message]}
      />
    </Arriving>
  );
});

/**
 * A refusal is marked; a failure has to be recognised.
 *
 * Servers do not agree on how to say something went wrong. The two shapes worth trusting are a
 * result that opens by saying so, and a JSON envelope carrying an error field — MCP's own
 * `isError` included. Anything subtler is left alone: a false "didn't work" on a good result
 * teaches people to ignore the tone that matters.
 */
function looksFailed(answer: string): boolean {
  if (/^\s*(error|failed)\b/i.test(answer)) return true;
  const trimmed = answer.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return false;
    const envelope = parsed as { error?: unknown; isError?: unknown };
    return envelope.isError === true || envelope.error !== undefined;
  } catch {
    return false;
  }
}

/**
 * A tool call nothing registered a renderer for still happened, and is still an event with an
 * outcome.
 *
 * The name is humanised the way the reader would say it, a refusal shows as Blocked, a failure in
 * amber — BEFORE this, a failing MCP call rendered as a calm finished line, indistinguishable from
 * success. The result opens under a disclosure, the same shape every other tool line has.
 */
function ServerToolLine({ name, result }: { name: string; result?: string }) {
  const { label, detail } = readToolName(name);
  const answer = result === undefined ? undefined : asText(result);
  const refused = answer?.startsWith(REFUSAL_MARKER) ?? false;
  const failed = !refused && answer !== undefined && looksFailed(answer);
  const body = refused ? answer?.slice(REFUSAL_MARKER.length).trim() : answer;

  return (
    <ToolLine
      {...(detail ? { detail } : {})}
      failed={failed}
      label={label}
      refused={refused}
      running={result === undefined}
    >
      {body ? (
        <Streamdown
          components={markdownComponents}
          controls={markdownControls}
          lineNumbers={markdownLineNumbers}
        >
          {forDisplay(body)}
        </Streamdown>
      ) : null}
    </ToolLine>
  );
}

/**
 * One drawn tool call, memoised on the same terms as messages.
 *
 * The `toolCall` object is rebuilt here from its parts rather than passed down, because the one on
 * the message is a new object on every chunk and would defeat the memo exactly as the text items
 * did. A finished chart re-rendering on every token of the sentence after it is not free.
 *
 * `useRenderToolCall` is called HERE rather than passed in as a prop: a function whose identity the
 * parent cannot guarantee is the classic way to make a memo boundary useless.
 */
const TranscriptToolCall = memo(function TranscriptToolCall({
  delay,
  toolCallId,
  name,
  args,
  result,
}: {
  delay: number;
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
}) {
  const renderToolCall = useRenderToolCall();
  const toolCall = useMemo(
    () => ({
      id: toolCallId,
      type: "function" as const,
      function: { name, arguments: args },
    }),
    [toolCallId, name, args],
  );

  const drawn = renderToolCall({
    toolCall,
    ...(result === undefined
      ? {}
      : {
          toolMessage: {
            id: `${toolCallId}-result`,
            role: "tool",
            toolCallId,
            content: result,
          },
        }),
  });

  return (
    <Arriving delay={delay}>
      <ToolRenderBoundary name={name}>
        {/*
         * A TOOL WITH NO REGISTERED RENDERER STILL HAPPENED. `renderToolCall` draws whatever was
         * registered for the name and nothing at all for anything else, which left a Bot that called
         * something the app does not know about looking like a Bot that did nothing — the same
         * failure `ToolRenderBoundary` exists to prevent, arriving by a different route.
         */}
        {drawn ?? <ServerToolLine name={name} result={result} />}
      </ToolRenderBoundary>
    </Arriving>
  );
});

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/**
 * The actions safe to fold into one collapsed row once they have all finished.
 *
 * A whitelist, because the cost of the two mistakes is not symmetric. Folding a compact line early
 * hides nothing: it is one line either way. Folding a rendered CARD — a chart from the gallery, a
 * pinned screenshot, a take-the-wheel prompt with buttons on it — buries the exact thing the Bot
 * chose to answer with. Names not on this list therefore always render full size, including every
 * name this code has never heard of.
 */
const GROUPABLE_TOOLS = new Set([
  "computer_navigate",
  "computer_read",
  "computer_extract_table",
  "computer_observe",
  "computer_snapshot",
  "computer_fill_form",
  "computer_type",
  "computer_click",
  "computer_key",
  "computer_scroll",
  "computer_list_files",
  "computer_read_file",
  "computer_write_file",
]);

function isGroupableTool(name: string): boolean {
  return GROUPABLE_TOOLS.has(name) || name.startsWith("mcp__");
}

function parsedObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toolGroupSummary(tools: readonly ToolItem[]): string {
  let fields = 0;
  let checks = 0;
  let files = 0;
  let totalMs = 0;
  let actionCount = 0;
  let clicked = "";
  let opened = "";
  let pressed = "";

  for (const tool of tools) {
    const name = tool.toolCall.function.name;
    const result = parsedObject(tool.result);
    const args = parsedObject(tool.toolCall.function.arguments);
    const elapsed = result.clientElapsedMs ?? result.elapsedMs;
    if (typeof elapsed === "number") totalMs += elapsed;
    if (name === "computer_fill_form") {
      const filled =
        typeof result.filled === "number"
          ? result.filled
          : Array.isArray(args.fields)
            ? args.fields.length
            : 1;
      fields += filled;
      actionCount += filled;
    } else {
      actionCount += 1;
    }
    if (name === "computer_type") fields += 1;
    else if (name === "computer_click") {
      const element = result.element as { name?: unknown } | undefined;
      if (typeof element?.name === "string") clicked = element.name;
    } else if (name === "computer_navigate") {
      if (typeof result.title === "string") opened = result.title;
    } else if (name === "computer_key") {
      if (typeof result.key === "string") pressed = result.key;
      else if (typeof args.key === "string") pressed = args.key;
    } else if (
      name === "computer_read" ||
      name === "computer_observe" ||
      name === "computer_snapshot" ||
      name === "computer_extract_table"
    ) {
      checks += 1;
    } else if (name.includes("_file") || name === "computer_list_files") {
      files += 1;
    }
  }

  const parts: string[] = [];
  if (opened) parts.push(`Opened ${opened}`);
  if (fields) parts.push(`filled ${fields} field${fields === 1 ? "" : "s"}`);
  if (clicked) parts.push(`clicked “${clicked}”`);
  if (pressed) parts.push(`pressed ${pressed}`);
  if (checks)
    parts.push(
      `checked the page ${checks > 1 ? `${checks} times` : ""}`.trim(),
    );
  if (files)
    parts.push(`worked with ${files} file step${files === 1 ? "" : "s"}`);
  const summary =
    parts.slice(0, 3).join(", ") || `Completed ${tools.length} steps`;
  return `${summary} · ${actionCount} actions${totalMs ? ` · ${Math.max(1, Math.round(totalMs / 1000))}s` : ""}`;
}

/**
 * A run of routine actions, one row when it is over.
 *
 * A browser turn is a dozen clicks and reads, and each one drawn at message rhythm buried the
 * answer below a page of lines. While the run is LIVE every line shows, because watching the Bot
 * work is the point of a visible computer; the moment the last result lands the run folds to
 * "Did N things", still there to open, no longer in the way.
 */
function TranscriptToolGroup({
  tools,
  delay,
}: {
  tools: readonly ToolItem[];
  delay: number;
}) {
  const running = tools.some((tool) => tool.result === undefined);
  const failed = tools.some((tool) => {
    const result = parsedObject(tool.result);
    return (
      result.ok === false || (tool.result ? looksFailed(tool.result) : false)
    );
  });
  const lines = tools.map((tool) => (
    <TranscriptToolCall
      args={tool.toolCall.function.arguments}
      delay={0}
      key={tool.id}
      name={tool.toolCall.function.name}
      result={tool.result}
      toolCallId={tool.id}
    />
  ));

  if (tools.length === 1 || running || failed) {
    return (
      <Arriving delay={delay}>
        <div className="flex w-full min-w-0 flex-col">{lines}</div>
      </Arriving>
    );
  }

  return (
    <Arriving delay={delay}>
      <details className="tool-line my-1.5 min-w-0">
        <summary className="flex cursor-pointer list-none items-baseline gap-1.5">
          <span
            aria-hidden
            className="tool-line-chevron shrink-0 text-muted-foreground text-xs transition-transform"
          >
            ▸
          </span>
          <span className="text-muted-foreground text-sm">
            {toolGroupSummary(tools)}
          </span>
        </summary>
        <div className="mt-1 min-w-0 border-l pl-3">{lines}</div>
      </details>
    </Arriving>
  );
}

/** Placeholder rows while a channel's history is still on its way, distinct from a real void. */
function TranscriptSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-6 pt-4">
      <Skeleton className="h-9 w-3/5 self-end rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-4/5 rounded" />
        <Skeleton className="h-4 w-3/5 rounded" />
        <Skeleton className="h-4 w-2/5 rounded" />
      </div>
      <Skeleton className="h-9 w-2/5 self-end rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4 rounded" />
        <Skeleton className="h-4 w-1/2 rounded" />
      </div>
    </div>
  );
}

/**
 * The transcript's rendering plan: text and reasoning stay one item each, and consecutive
 * routine tool calls merge into a group that can fold once it is over.
 */
type TranscriptBlock =
  | {
      key: string;
      kind: "text";
      item: Extract<VisibleChatItem, { kind: "text" }>;
      index: number;
    }
  | {
      key: string;
      kind: "reasoning";
      item: Extract<VisibleChatItem, { kind: "reasoning" }>;
      index: number;
    }
  | {
      key: string;
      kind: "tools";
      groupable: boolean;
      tools: ToolItem[];
      index: number;
    };

function toBlocks(items: readonly VisibleChatItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  items.forEach((item, index) => {
    if (item.kind === "tool") {
      const groupable = isGroupableTool(item.toolCall.function.name);
      const last = blocks.at(-1);
      if (groupable && last?.kind === "tools" && last.groupable) {
        last.tools.push(item);
        return;
      }
      blocks.push({
        key: item.id,
        kind: "tools",
        groupable,
        tools: [item],
        index,
      });
      return;
    }
    if (item.kind === "reasoning") {
      blocks.push({ key: item.id, kind: "reasoning", item, index });
      return;
    }
    blocks.push({ key: item.id, kind: "text", item, index });
  });
  return blocks;
}

/** Whether this block belongs to the coworker's side of the conversation. */
function isAssistantSide(block: TranscriptBlock): boolean {
  if (block.kind === "text") return block.item.role === "assistant";
  return true;
}

/** The message id whose arrival stamp stands for this block, for headers and day breaks. */
function blockMessageId(block: TranscriptBlock): string {
  if (block.kind === "tools") return block.tools[0]?.messageId ?? block.key;
  return block.item.id;
}

export function ChatTranscript({
  busy = false,
  commandNames = "",
  messages,
  onRemoveQueued,
  queued = EMPTY_QUEUE,
  stopped,
  agentId,
  assistantName,
  messageTimes = EMPTY_TIMES,
  emptyState,
  restoring = false,
  historyNotice,
  onQuote,
  onEdit,
  onRetryLatest,
  searchMatchIds = "",
  activeSearchMessageId,
}: ChatTranscriptProps) {
  /*
   * NOT MEMOISED, AND THAT IS DELIBERATE. `useMemo` keyed on `messages` looks obviously right and
   * silently broke the transcript: the agent hands back the SAME array and mutates it, so the
   * dependency never changed, the cached items were kept forever and a reply never appeared. A Bot
   * that answered looked like a Bot that had not.
   *
   * It was never the expensive part either. Rebuilding this list is a flatMap over messages; the
   * cost was markdown parsing and chart SVGs, and those are skipped by the memoised children below,
   * which is where the 25x came from. This runs per render and is not worth guarding.
   */
  const items = toVisibleChatItems(messages);
  const blocks = toBlocks(items);

  /*
   * ONLY WHILE THERE IS NOTHING ELSE TO LOOK AT. Streamed text and a running tool already show
   * progress. Before the first output, and after a tool has returned while the Bot decides what
   * comes next, this is the only visible evidence that the turn is still alive.
   */
  const waitingForBot = shouldShowThinking(busy, items);

  /** The newest answer, the only one Retry may attach to. */
  const latestAssistantId = [...items]
    .reverse()
    .find((item) => item.kind === "text" && item.role === "assistant")?.id;

  const searchMatches = searchMatchIds
    ? new Set(searchMatchIds.split(","))
    : null;

  /*
   * One decider per mounted transcript, so opening a different channel starts the cascade over and
   * a message never inherits a delay from a conversation it was not in.
   */
  const delaysRef = useRef<ReturnType<typeof createFirstPaintDelays> | null>(
    null,
  );
  if (delaysRef.current === null) {
    delaysRef.current = createFirstPaintDelays();
  }
  const delays = delaysRef.current;

  /*
   * Settled AFTER the render that first had items, not on mount: history arrives asynchronously, so
   * on mount there is nothing to stagger yet and marking it settled then would mean the history
   * cascade never happens.
   */
  const hasItems = items.length > 0;
  useEffect(() => {
    if (hasItems) {
      delays.settle();
    }
  }, [hasItems, delays]);

  const displayName = assistantName ?? "Assistant";
  let previousBlock: TranscriptBlock | null = null;

  return (
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={48}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={busy}
            className="mx-auto w-full max-w-2xl px-4 py-6"
          >
            {historyNotice ? (
              <p
                className="text-center text-muted-foreground text-xs"
                role="status"
              >
                {historyNotice}
              </p>
            ) : null}
            {restoring && items.length === 0 ? <TranscriptSkeleton /> : null}
            {!restoring && items.length === 0 && !busy && queued.length === 0
              ? emptyState
              : null}
            {/*
             * The memo boundary is INSIDE the scroller item, not around it. `MessageScrollerItem`
             * reads the scroller's context, so it re-renders whenever the scroll state moves and
             * memoising it would achieve nothing. Its child is what costs — markdown parsing and
             * chart SVGs — and that is what is skipped.
             */}
            {blocks.map((block) => {
              const before = previousBlock;
              previousBlock = block;

              const stampId = blockMessageId(block);
              const time = messageTimes[stampId];
              const beforeTime =
                before === null
                  ? undefined
                  : messageTimes[blockMessageId(before)];
              const separator =
                time !== undefined &&
                (before === null ||
                  (beforeTime !== undefined && !sameDay(beforeTime, time)))
                  ? dayLabel(time)
                  : null;

              /*
               * A turn header sits above the coworker's first block after a person spoke — name,
               * face, and when this browser saw it. Repeating it per bubble would say nothing new
               * eleven times.
               */
              const header =
                isAssistantSide(block) &&
                (before === null || !isAssistantSide(before)) ? (
                  <TurnHeader
                    agentId={agentId}
                    name={displayName}
                    time={time}
                  />
                ) : null;

              const delay = delays.delayFor(
                block.key,
                block.index,
                items.length,
              );

              if (block.kind === "reasoning") {
                return (
                  <MessageScrollerItem key={block.key} messageId={block.key}>
                    {separator ? <DaySeparator label={separator} /> : null}
                    {header}
                    <TranscriptReasoning
                      delay={delay}
                      id={block.item.id}
                      streaming={busy && block.index === items.length - 1}
                      text={block.item.text}
                    />
                  </MessageScrollerItem>
                );
              }

              if (block.kind === "tools") {
                return (
                  <MessageScrollerItem key={block.key} messageId={block.key}>
                    {separator ? <DaySeparator label={separator} /> : null}
                    {header}
                    <TranscriptToolGroup delay={delay} tools={block.tools} />
                  </MessageScrollerItem>
                );
              }

              const { item } = block;
              return (
                <MessageScrollerItem
                  key={block.key}
                  messageId={block.key}
                  scrollAnchor={item.role === "user"}
                >
                  {separator ? <DaySeparator label={separator} /> : null}
                  {header}
                  <TranscriptMessage
                    attachments={item.attachments}
                    commandNames={commandNames}
                    delay={delay}
                    onEdit={onEdit}
                    onQuote={onQuote}
                    onRetry={
                      item.id === latestAssistantId ? onRetryLatest : undefined
                    }
                    role={item.role}
                    searchTint={
                      item.id === activeSearchMessageId
                        ? "active"
                        : searchMatches?.has(item.id)
                          ? "match"
                          : undefined
                    }
                    text={item.text}
                    time={time}
                  />
                </MessageScrollerItem>
              );
            })}
            {/*
             * Outside the item list, so neither of these is a message. Each has no id, is never
             * anchored, and is gone by the next turn — giving one a `MessageScrollerItem` would ask
             * the scroller to measure and anchor something that exists for a second and a half.
             *
             * One or the other, never both: a turn that ended has stopped being in flight, and a
             * shimmering "Thinking" under a line saying the Bot stopped would contradict it.
             */}
            {stopped ? (
              <Stopped onRetry={onRetryLatest} reason={stopped} />
            ) : waitingForBot ? (
              <Thinking />
            ) : null}
            {/*
             * Below the thinking line, and outside the item list for the same reason it is: these
             * are not yet turns. They have ids of their own, but they are this tab's ids and not the
             * thread's, so handing them to the scroller would ask it to anchor on something that is
             * about to be replaced by a message with a different id — and the replacement is the
             * one worth scrolling to.
             */}
            {queued.map((message) => (
              <Queued
                attachmentCount={message.attachments.length}
                key={message.id}
                onRemove={
                  onRemoveQueued ? () => onRemoveQueued(message.id) : undefined
                }
                text={message.text}
              />
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
        <ScrollNewestQueuedIntoView newest={queued.at(-1)?.id ?? null} />
        <ScrollSearchMatchIntoView id={activeSearchMessageId} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
