import type { Message } from "@ag-ui/core";
import {
  IconBox,
  IconBook2,
  IconCheck,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconFile,
  IconGitBranch,
  IconPhoto,
  IconQuote,
  IconRefresh,
} from "@tabler/icons-react";
import { useRenderToolCall } from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { markdownComponents } from "@/lib/markdown";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, forDisplay, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import {
  MESSAGE_REACTION_EMOJIS,
  type MessageReaction,
  type MessageReactionEmoji,
  messageReactionsQueryOptions,
  setMessageReactionMutationOptions,
} from "@/lib/channels/reactions";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageFooter,
  MessageHeader,
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
import { toVisibleChatItems, type VisibleAttachment } from "./chat-messages";
import { parseKnowledgeCitations } from "./knowledge-citations";
import type { QueuedMessage } from "./composer";
import { ToolLine } from "./tool-line";
import { ToolRenderBoundary } from "./tool-boundary";

type ChatTranscriptProps = {
  /** Live task progress belongs in the turn, beside the messages that caused it. */
  activity?: ReactNode;
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
  /** Enables durable reactions for messages in an existing channel. */
  channelId?: string;
  searchQuery?: string;
  activeSearchMessageId?: string;
  onQuoteMessage?: (text: string, role: "user" | "assistant") => void;
  onEditMessage?: (text: string) => void;
  onRetryMessage?: () => void;
  onBranchMessage?: (text: string, role: "user" | "assistant") => void;
  assistantName?: string;
};

/** One shared empty array, so a screen without a queue does not hand down a new one per render. */
const EMPTY_QUEUE: readonly QueuedMessage[] = [];

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

/**
 * The Bot has the turn and has produced nothing yet.
 *
 * THE GAP THIS FILLS IS THE WORST ONE IN THE CONVERSATION. Between pressing send and the first token
 * there was `aria-busy` and nothing else: announced to a screen reader, invisible to everybody else.
 * A person who has just asked something watches their own message sit there, and a Bot that is
 * thinking is indistinguishable from a Bot that failed silently — which this app has shipped before.
 *
 * It borrows the shimmer a running tool line uses, so "working on it" reads the same whether the
 * work is a tool call or a model that has not spoken yet.
 */
function Thinking() {
  return (
    <p
      className="tool-line-running text-muted-foreground text-sm"
      // `status` rather than `alert`: this is progress, not something that interrupts what somebody
      // is doing. The text says it, so a screen reader is told the same thing the shimmer implies.
      role="status"
    >
      Thinking
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
 */
function Stopped({ reason }: { reason: string }) {
  return (
    <p
      className="text-destructive text-sm"
      data-testid="transcript-stopped"
      role="alert"
    >
      {reason}
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
  attachments,
  onRemove,
}: {
  text: string;
  attachments?: readonly { name: string }[];
  onRemove?: (() => void) | undefined;
}) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <Bubble align="end" className="opacity-60" variant="muted">
          <BubbleContent>
            {/* Shown exactly as typed, for the same reason a sent message is. */}
            <span className="whitespace-pre-wrap">{text}</span>
            {attachments?.length ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                {attachments.map((attachment) => attachment.name).join(", ")}
              </span>
            ) : null}
          </BubbleContent>
        </Bubble>
        <MessageFooter>
          {/*
           * `status` rather than `alert`, matching the thinking line: a person who has just chosen
           * to queue something is not being interrupted by the news that it is queued.
           */}
          <span role="status">Queued</span>
          {onRemove ? (
            <button
              /*
               * The sentence it deletes, in the name. Three parked corrections put three buttons
               * called "Remove" in a row, and somebody reading by name alone is told what they can
               * do and nothing about which one it would happen to. The visible word stays short
               * because the bubble it sits under is the answer for everybody who can see it.
               */
              aria-label={`Remove queued message: ${text}`}
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
 * Measured at the point somebody would actually use this: eighty-odd pixels under the fold, with
 * the composer emptying at the same moment. They would have watched their correction vanish.
 *
 * Keyed on the newest queued id rather than on the list, so it does not fire again for every chunk
 * of the answer still streaming above it. It does fire when the bottom-most queued line is taken
 * back, which is a scroll nobody asked for and which lands on the end of the conversation anyway,
 * and it stays quiet on a drain, when the id goes to null.
 *
 * IT COSTS THE ANCHOR, AND THAT IS THE PRICE OF THE SCROLL RATHER THAN A SIDE EFFECT OF IT.
 * `scrollToEnd` drops whatever turn the scroller was holding its position against and starts
 * following the bottom instead, so the rest of that answer streams past under the reader rather
 * than staying put beneath the question. Somebody who has just typed at the bottom of the
 * conversation has asked to be at the bottom of the conversation, so following it is the reading
 * they chose; but they chose it for the whole turn and not only for the moment, and the button
 * back to the anchored view is the scroller's own, not ours to restore.
 *
 * Rendering nothing and living inside the provider is what buys access to the scroller at all; the
 * alternative is threading a ref out through three components with no other reason to know a
 * scroller exists.
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
 * One drawn message, and it is memoised on PRIMITIVES ON PURPOSE.
 *
 * A streamed answer changes `messages` on every chunk, and `toVisibleChatItems` builds fresh objects
 * from it each time — so a memo comparing item objects would miss on every single one and buy
 * nothing. Passing role and text means an untouched message compares equal and is skipped.
 *
 * MEASURED, BEFORE AND AFTER. One reply into a 25-message thread cost 76 transcript renders and
 * 1,890 message renders, because every message in the history re-parsed its markdown on every
 * chunk. That is the jank: the scroll was following a list that rebuilt itself 76 times.
 *
 * It is also what keeps the entrance honest — no remount means no replay of the fade.
 */
const TranscriptMessage = memo(function TranscriptMessage({
  activeSearch = false,
  attachments = [],
  assistantName = "Coworker",
  commandNames = "",
  delay,
  id,
  matchedSearch = false,
  onBranch,
  onEdit,
  onQuote,
  onReact,
  onRetry,
  reactions = [],
  role,
  text,
}: {
  activeSearch?: boolean;
  attachments?: readonly VisibleAttachment[];
  assistantName?: string;
  commandNames?: string;
  delay: number;
  id: string;
  matchedSearch?: boolean;
  onBranch?: (text: string, role: "user" | "assistant") => void;
  onEdit?: (text: string) => void;
  onQuote?: (text: string, role: "user" | "assistant") => void;
  onReact?: (
    messageId: string,
    emoji: MessageReactionEmoji,
    active: boolean,
  ) => void;
  reactions?: readonly MessageReaction[];
  onRetry?: () => void;
  role: "user" | "assistant";
  text: string;
}) {
  const isUser = role === "user";
  const align = isUser ? "end" : "start";
  const invoked = isUser ? splitSkillChip(text, commandNames) : null;

  return (
    <MessageRow align={align} data-transcript-message-id={id}>
      <MessageContent>
        <Arriving delay={delay}>
          {!isUser ? <MessageHeader>{assistantName}</MessageHeader> : null}
          <Bubble
            align={align}
            className={
              activeSearch
                ? "rounded-xl ring-3 ring-primary/40"
                : matchedSearch
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
                <Streamdown components={markdownComponents}>{text}</Streamdown>
              )}
              <MessageAttachments attachments={attachments} />
            </BubbleContent>
          </Bubble>
        </Arriving>
        <div className="flex flex-wrap items-center gap-1">
          <MessageActionBar
            onBranch={onBranch}
            onEdit={isUser ? onEdit : undefined}
            onQuote={onQuote}
            onRetry={!isUser ? onRetry : undefined}
            role={role}
            text={text}
          />
          {onReact ? (
            <ReactionBar
              messageId={id}
              onReact={onReact}
              reactions={reactions}
            />
          ) : null}
        </div>
      </MessageContent>
    </MessageRow>
  );
});

function MessageActionBar({
  onBranch,
  onEdit,
  onQuote,
  onRetry,
  role,
  text,
}: {
  onBranch?: (text: string, role: "user" | "assistant") => void;
  onEdit?: (text: string) => void;
  onQuote?: (text: string, role: "user" | "assistant") => void;
  onRetry?: () => void;
  role: "user" | "assistant";
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const actionClass =
    "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <MessageFooter className="gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
      <button
        aria-label={copied ? "Copied message" : "Copy message"}
        className={actionClass}
        onClick={() => {
          void copyText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          });
        }}
        title={copied ? "Copied" : "Copy"}
        type="button"
      >
        {copied ? (
          <IconCheck className="size-3.5" />
        ) : (
          <IconCopy className="size-3.5" />
        )}
      </button>
      {onQuote ? (
        <button
          aria-label="Quote message in reply"
          className={actionClass}
          onClick={() => onQuote(text, role)}
          title="Quote in reply"
          type="button"
        >
          <IconQuote className="size-3.5" />
        </button>
      ) : null}
      {onEdit ? (
        <button
          aria-label="Edit and resend message"
          className={actionClass}
          onClick={() => onEdit(text)}
          title="Edit and resend"
          type="button"
        >
          <IconEdit className="size-3.5" />
        </button>
      ) : null}
      {onRetry ? (
        <button
          aria-label="Retry the latest response"
          className={actionClass}
          onClick={onRetry}
          title="Retry response"
          type="button"
        >
          <IconRefresh className="size-3.5" />
        </button>
      ) : null}
      {onBranch ? (
        <button
          aria-label="Continue from this message in a new conversation"
          className={actionClass}
          onClick={() => onBranch(text, role)}
          title="Continue in new conversation"
          type="button"
        >
          <IconGitBranch className="size-3.5" />
        </button>
      ) : null}
    </MessageFooter>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Sandboxed contexts can expose the API and still deny it; use the selection fallback.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function MessageAttachments({
  attachments,
}: {
  attachments: readonly VisibleAttachment[];
}) {
  if (attachments.length === 0) return null;
  return (
    <fieldset
      aria-label="Message attachments"
      className="mt-2 grid min-w-0 gap-2 border-0 p-0"
    >
      {attachments.map((attachment) =>
        attachment.kind === "image" && attachment.data ? (
          <figure
            className="overflow-hidden rounded-lg border bg-background"
            key={attachment.id}
          >
            <img
              alt={attachment.name}
              className="max-h-64 w-full object-contain"
              src={`data:${attachment.mimeType};base64,${attachment.data}`}
            />
            <figcaption className="flex items-center gap-1 border-t px-2 py-1 text-xs text-muted-foreground">
              <IconPhoto className="size-3" /> {attachment.name}
            </figcaption>
          </figure>
        ) : (
          <span
            className="inline-flex w-fit max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs"
            key={attachment.id}
          >
            <IconFile className="size-3 shrink-0" />
            <span className="truncate">{attachment.name}</span>
          </span>
        ),
      )}
    </fieldset>
  );
}

function ReactionBar({
  messageId,
  onReact,
  reactions,
}: {
  messageId: string;
  onReact: (
    messageId: string,
    emoji: MessageReactionEmoji,
    active: boolean,
  ) => void;
  reactions: readonly MessageReaction[];
}) {
  const byEmoji = new Map(
    reactions.map((reaction) => [reaction.emoji, reaction]),
  );
  const visible = reactions.length > 0;
  return (
    <MessageFooter
      className={`gap-1 transition-opacity ${visible ? "opacity-100" : "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100"}`}
    >
      {MESSAGE_REACTION_EMOJIS.map((emoji) => {
        const reaction = byEmoji.get(emoji);
        return (
          <button
            aria-label={`${reaction?.mine ? "Remove" : "Add"} ${emoji} reaction`}
            aria-pressed={reaction?.mine ?? false}
            className="rounded-full border border-transparent px-1.5 py-0.5 hover:bg-muted aria-pressed:border-border aria-pressed:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            key={emoji}
            onClick={() =>
              onReact(messageId, emoji, !(reaction?.mine ?? false))
            }
            type="button"
          >
            {emoji}
            {reaction?.count ? (
              <span className="ml-1">{reaction.count}</span>
            ) : null}
          </button>
        );
      })}
    </MessageFooter>
  );
}

/**
 * One drawn tool call, memoised on the same terms.
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

  if (name === "openbot_search_knowledge") {
    return (
      <Arriving delay={delay}>
        <KnowledgeSources result={result} />
      </Arriving>
    );
  }

  return (
    <Arriving delay={delay}>
      <ToolRenderBoundary name={name}>
        {/*
         * A TOOL WITH NO REGISTERED RENDERER STILL HAPPENED. `renderToolCall` draws whatever was
         * registered for the name and nothing at all for anything else, which left a Bot that called
         * something the app does not know about looking like a Bot that did nothing — the same
         * failure `ToolRenderBoundary` exists to prevent, arriving by a different route.
         *
         * The fallback is a plain tool line: what was called, shimmering until its result lands. It
         * is the same line the computer and MCP tools draw, so an unrecognised call reads as an
         * ordinary event rather than as damage.
         */}
        {drawn ?? <ServerToolLine name={name} result={result} />}
      </ToolRenderBoundary>
    </Arriving>
  );
});

function KnowledgeSources({ result }: { result?: string }) {
  const citations =
    result === undefined ? null : parseKnowledgeCitations(result);
  if (citations === null) {
    return (
      <ToolLine
        label="Searching company knowledge"
        running={result === undefined}
      >
        {result === undefined
          ? null
          : "The knowledge search returned an unreadable result."}
      </ToolLine>
    );
  }
  if (citations.length === 0) {
    return (
      <ToolLine label="Searched company knowledge">
        No matching sources were found.
      </ToolLine>
    );
  }
  return (
    <details className="group/sources overflow-hidden rounded-xl border bg-card shadow-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50">
        <IconBook2 className="size-4 shrink-0 text-primary" />
        <span className="font-medium text-sm">Sources</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {citations.length}
        </span>
        <span className="ml-auto text-xs text-muted-foreground group-open/sources:hidden">
          View evidence
        </span>
      </summary>
      <ol className="grid gap-1 border-t p-2">
        {citations.map((citation) => {
          const href = safeHttpUrl(citation.url);
          return (
            <li
              className="rounded-lg px-2 py-2 hover:bg-muted/40"
              key={`${citation.citation}:${citation.url}`}
            >
              <div className="flex items-start gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-[11px] text-primary">
                  {citation.citation}
                </span>
                <div className="min-w-0 flex-1">
                  {href ? (
                    <a
                      className="inline-flex max-w-full items-center gap-1 font-medium text-sm underline-offset-4 hover:underline"
                      href={href}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span className="truncate">{citation.title}</span>
                      <IconExternalLink className="size-3 shrink-0" />
                    </a>
                  ) : (
                    <p className="font-medium text-sm">{citation.title}</p>
                  )}
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                    {citation.excerpt}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function ServerToolLine({ name, result }: { name: string; result?: string }) {
  const { label, detail } = readToolName(name);
  const answer = result === undefined ? undefined : asText(result);
  const refused = answer?.startsWith(REFUSAL_MARKER) ?? false;
  const body = refused ? answer?.slice(REFUSAL_MARKER.length).trim() : answer;

  return (
    <ToolLine
      {...(detail ? { detail } : {})}
      label={label}
      refused={refused}
      running={result === undefined}
    >
      {body ? (
        <Streamdown components={markdownComponents}>
          {forDisplay(body)}
        </Streamdown>
      ) : null}
    </ToolLine>
  );
}

export function ChatTranscript({
  activity,
  assistantName,
  busy = false,
  channelId,
  commandNames = "",
  messages,
  onBranchMessage,
  onEditMessage,
  onQuoteMessage,
  onRemoveQueued,
  onRetryMessage,
  queued = EMPTY_QUEUE,
  searchQuery = "",
  activeSearchMessageId,
  stopped,
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
  const latestAssistantId = [...items]
    .reverse()
    .find((item) => item.kind === "text" && item.role === "assistant")?.id;
  const queryClient = useQueryClient();
  const messageIds = items.flatMap((item) =>
    item.kind === "text" ? [item.id] : [],
  );
  const reactionQuery = useQuery(
    messageReactionsQueryOptions(channelId, messageIds),
  );
  const reactionMutation = useMutation(
    setMessageReactionMutationOptions(queryClient, channelId ?? "none"),
  );
  const mutateReaction = reactionMutation.mutate;
  const reactionsByMessage = useMemo(() => {
    const grouped = new Map<string, MessageReaction[]>();
    for (const reaction of reactionQuery.data ?? []) {
      const group = grouped.get(reaction.messageId) ?? [];
      group.push(reaction);
      grouped.set(reaction.messageId, group);
    }
    return grouped;
  }, [reactionQuery.data]);
  const react = useCallback(
    (messageId: string, emoji: MessageReactionEmoji, active: boolean) => {
      if (!channelId) return;
      mutateReaction({ messageId, emoji, active });
    },
    [channelId, mutateReaction],
  );
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeSearchMessageId) return;
    const target = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>(
        "[data-transcript-message-id]",
      ) ?? []),
    ].find(
      (element) =>
        element.dataset.transcriptMessageId === activeSearchMessageId,
    );
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeSearchMessageId]);

  /*
   * ONLY WHILE THERE IS NOTHING ELSE TO LOOK AT. Once a reply starts streaming, or a tool line
   * appears, the transcript is already saying the Bot is working — a second indicator under a
   * half-written answer would claim it had stopped and started again.
   *
   * So: the turn is in flight AND the last thing in the conversation is still the person's own
   * message. A tool call that is running shimmers on its own line and needs nothing from here.
   */
  const lastItem = items.at(-1);
  const waitingOnFirstToken =
    busy && lastItem?.kind === "text" && lastItem.role === "user";

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

  return (
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={48}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={busy}
            className="mx-auto w-full max-w-2xl px-4 py-6"
            ref={contentRef}
          >
            {/*
             * The memo boundary is INSIDE the scroller item, not around it. `MessageScrollerItem`
             * reads the scroller's context, so it re-renders whenever the scroll state moves and
             * memoising it would achieve nothing. Its child is what costs — markdown parsing and
             * chart SVGs — and that is what is skipped.
             */}
            {items.map((item, index) =>
              item.kind === "tool" ? (
                <MessageScrollerItem key={item.id} messageId={item.id}>
                  <TranscriptToolCall
                    args={item.toolCall.function.arguments}
                    delay={delays.delayFor(item.id, index, items.length)}
                    name={item.toolCall.function.name}
                    result={item.result}
                    toolCallId={item.toolCall.id}
                  />
                </MessageScrollerItem>
              ) : (
                <MessageScrollerItem
                  className={
                    item.role === "user" && index > 0
                      ? "mt-4 border-t border-border/60 pt-6"
                      : undefined
                  }
                  key={item.id}
                  messageId={item.id}
                  scrollAnchor={item.role === "user"}
                >
                  <TranscriptMessage
                    activeSearch={item.id === activeSearchMessageId}
                    attachments={item.attachments}
                    assistantName={assistantName}
                    commandNames={commandNames}
                    delay={delays.delayFor(item.id, index, items.length)}
                    id={item.id}
                    matchedSearch={
                      normalizedSearch.length > 0 &&
                      item.text.toLocaleLowerCase().includes(normalizedSearch)
                    }
                    onBranch={onBranchMessage}
                    onEdit={onEditMessage}
                    onQuote={onQuoteMessage}
                    onReact={channelId ? react : undefined}
                    onRetry={
                      item.id === latestAssistantId ? onRetryMessage : undefined
                    }
                    reactions={reactionsByMessage.get(item.id)}
                    role={item.role}
                    text={item.text}
                  />
                </MessageScrollerItem>
              ),
            )}
            {/*
             * Outside the item list, so neither of these is a message. Each has no id, is never
             * anchored, and is gone by the next turn — giving one a `MessageScrollerItem` would ask
             * the scroller to measure and anchor something that exists for a second and a half.
             *
             * One or the other, never both: a turn that ended has stopped being in flight, and a
             * shimmering "Thinking" under a line saying the Bot stopped would contradict it.
             */}
            {stopped ? (
              <Stopped reason={stopped} />
            ) : waitingOnFirstToken ? (
              <Thinking />
            ) : null}
            {activity ? <div className="min-w-0">{activity}</div> : null}
            {/*
             * Below the thinking line, and outside the item list for the same reason it is: these
             * are not yet turns. They have ids of their own, but they are this tab's ids and not the
             * thread's, so handing them to the scroller would ask it to anchor on something that is
             * about to be replaced by a message with a different id — and the replacement is the
             * one worth scrolling to.
             */}
            {queued.map((message) => (
              <Queued
                key={message.id}
                onRemove={
                  onRemoveQueued ? () => onRemoveQueued(message.id) : undefined
                }
                attachments={message.attachments}
                text={message.text}
              />
            ))}
            {reactionMutation.isError ? (
              <p
                className="mt-2 text-center text-xs text-destructive"
                role="alert"
              >
                That reaction could not be saved. Try again.
              </p>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
        <ScrollNewestQueuedIntoView newest={queued.at(-1)?.id ?? null} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
