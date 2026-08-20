import {
  IconArrowUp,
  IconPaperclip,
  IconPlayerStopFilled,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { PromptArea, type PromptAreaHandle } from "prompt-area";
import { plainTextToSegments, type Segment } from "prompt-area/helpers";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "../../ui/button";
import {
  attachmentFromFile,
  type ComposerAttachment,
  canAddAttachments,
} from "./attachments";
import {
  applyCommandChips,
  type CommandOption,
  type ComposerDraft,
  enforceSingleAgent,
  toDraft,
} from "./draft";
import {
  clearStoredDraft,
  readStoredDraft,
  writeStoredDraft,
} from "./persistence";
import { PLACEHOLDER_COMMANDS } from "./sources";
import { type AgentOption, buildTriggers } from "./triggers";

const MAX_HEIGHT_PX = 220;
/**
 * Tracks the compact `text-sm` line box so PromptArea stays vertically centered in one row.
 */
const COMPACT_MIN_HEIGHT_PX = 19;
const COMPACT_MAX_HEIGHT_PX = 96;

/**
 * Text a transcript action wants placed into the composer: Quote appends, Edit replaces.
 *
 * Carried as a value with an id rather than a callback, so the screen that owns the transcript can
 * hand it down through props and the composer can tell a new request from a re-render of the last
 * one. The id is what makes quoting the same message twice work.
 */
export type ComposerInsertion = {
  id: string;
  mode: "append" | "replace";
  text: string;
};

export type ComposerProps = {
  className?: string;
  compact?: boolean;
  /** Agents that `@` can address. Empty means the mention menu reports an empty channel. */
  agents?: readonly AgentOption[];
  commands?: readonly CommandOption[];
  /**
   * Browser-local key under which unsent text survives a reload. Attachments are never persisted:
   * they are megabytes of base64 with a meaning that expires with the moment, and quietly
   * re-attaching an old file to a new thought is worse than asking for it again.
   */
  draftKey?: string;
  /** Text loaded in from a transcript action such as Quote or Edit and resend. */
  insertion?: ComposerInsertion;
  /**
   * Receives the whole draft rather than a string, so a mention or a command reaches the caller as
   * structured data instead of something it would have to re-parse out of the text.
   */
  onSubmit?: (draft: ComposerDraft) => void | Promise<void>;
  /**
   * Park this message until the turn in flight is over, instead of refusing the keystroke.
   *
   * Its presence is what lets a person type at a Bot that is already working. Without it the
   * composer goes on refusing mid-turn sends, which is still the right answer for a screen that has
   * nowhere to put a parked message — the compose screen creates the channel on send and then
   * navigates away, so anything parked there would be dropped on unmount, and a message that
   * silently disappears is worse than a send button that visibly will not go.
   *
   * Called instead of `onSubmit`, not as well as it, and it does not return a promise: parking is
   * a state change, and awaiting one would hold the composer's send lock for the length of somebody
   * else's turn and block the next correction.
   */
  onQueue?: (draft: ComposerDraft) => void;
  /** Stop the Bot mid-answer; while pending, the send button becomes a stop button. */
  onStop?: () => void;
  /**
   * The conversation cannot take another message at all, which is a property of the conversation
   * rather than of the moment: a channel whose coworker was deleted. This is the only thing that
   * stops a person typing.
   */
  disabled?: boolean;
  /**
   * A turn is in flight. It gates sending, not writing: a channel is `pending` while it is still
   * connecting and restoring its history, and the composer is on screen throughout.
   */
  pending?: boolean;
  /**
   * There is a run on the wire for Stop to reach.
   *
   * Not the same question as `pending`, and telling them apart is the whole reason this exists. A
   * turn is in flight from the moment somebody presses send; the run it becomes does not exist
   * until the caller has waited for whatever it has to wait for, which on a channel that is still
   * joining is up to a second and a half. A Stop button drawn in that window aborts a controller
   * nobody has made yet: the press is swallowed, the message goes anyway, and the one control the
   * whole affordance leans on has quietly lied.
   *
   * Defaults to `pending`, which is the right answer for a caller with no gap between the two.
   */
  stoppable?: boolean;
};

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul
      aria-label="Files attached to this message"
      className="flex min-w-0 flex-wrap gap-1.5 px-3 pt-2.5"
    >
      {attachments.map((attachment) => (
        <li
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
          key={attachment.id}
        >
          <IconPaperclip className="size-3 shrink-0" />
          <span className="max-w-48 truncate">{attachment.name}</span>
          <button
            aria-label={`Remove ${attachment.name}`}
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onRemove(attachment.id)}
            type="button"
          >
            <IconX className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Composer({
  className,
  compact = false,
  agents = [],
  commands = PLACEHOLDER_COMMANDS,
  draftKey,
  insertion,
  onSubmit,
  onQueue,
  onStop,
  disabled = false,
  pending = false,
  stoppable,
}: ComposerProps) {
  /*
   * The stored draft is read synchronously on first render, which only works because `draftKey`
   * arrives with the first render — it is the route's channel id, not something fetched. An earlier
   * version scoped this key by the signed-in user, whose id resolves asynchronously; the key was
   * undefined on mount, so the draft was never restored, and the effect below then saw an empty
   * editor under the newly-arrived key and deleted the stored text. Single key, known at mount, is
   * what makes both halves honest.
   */
  const [value, setValue] = useState<Segment[]>(() =>
    readStoredDraft(draftKey),
  );
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentProblem, setAttachmentProblem] = useState<string | null>(
    null,
  );
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastInsertionRef = useRef<string | null>(null);
  /** A send has completed and the caret is owed back, as soon as the editor will take it. */
  const wantsFocus = useRef(false);

  const isBusy = pending || isSubmitting;
  const triggers = useMemo(
    () => buildTriggers({ agents, commands }),
    [agents, commands],
  );
  const draft = useMemo(
    () => toDraft(value, attachments),
    [value, attachments],
  );

  useEffect(() => {
    if (!insertion || insertion.id === lastInsertionRef.current) return;
    lastInsertionRef.current = insertion.id;
    const current =
      promptAreaRef.current?.getPlainText() ?? toDraft(value).text;
    const next =
      insertion.mode === "replace" || !current.trim()
        ? insertion.text
        : `${current.trimEnd()}\n\n${insertion.text}`;
    setValue(plainTextToSegments(next));
    window.requestAnimationFrame(() => {
      promptAreaRef.current?.focus();
      promptAreaRef.current?.setCursorToEnd();
    });
  }, [insertion, value]);

  useEffect(() => {
    writeStoredDraft(draftKey, toDraft(value).text);
  }, [draftKey, value]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentProblem(null);
  }, []);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      const problem = canAddAttachments(attachments, files);
      if (problem) {
        setAttachmentProblem(problem);
        return;
      }
      try {
        const added = await Promise.all(files.map(attachmentFromFile));
        setAttachments((current) => [...current, ...added]);
        setAttachmentProblem(null);
      } catch (error) {
        setAttachmentProblem(
          error instanceof Error
            ? error.message
            : "That file could not be attached.",
        );
      }
    },
    [attachments],
  );

  const handleRawPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files);
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      event.preventDefault();
      setDraggingFiles(false);
      void addFiles(Array.from(event.dataTransfer.files ?? []));
    },
    [addFiles],
  );

  const dragProps = {
    onDragEnter: (event: DragEvent<HTMLFormElement>) => {
      if (event.dataTransfer.types.includes("Files")) setDraggingFiles(true);
    },
    onDragLeave: (event: DragEvent<HTMLFormElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDraggingFiles(false);
      }
    },
    onDragOver: (event: DragEvent<HTMLFormElement>) => event.preventDefault(),
    onDrop: handleDrop,
  };

  const handleChange = useCallback(
    (next: Segment[]) => {
      const { segments, actions } = applyCommandChips(
        enforceSingleAgent(next),
        commands,
      );
      setValue(segments);
      // Run after the commit so an action that navigates or opens a panel is not fighting the
      // editor's own state update for the same tick.
      for (const action of actions) {
        action();
      }
    },
    [commands],
  );

  /**
   * The single submit path for Enter, the send button, and the form.
   *
   * `submitInFlight` is a ref rather than `isSubmitting` because a second Enter can land before
   * React has re-rendered with the new state, which would send the message twice.
   */
  const submitDraft = useCallback(
    async (segments: Segment[]) => {
      const submitted = toDraft(segments, attachments);
      if (submitted.isEmpty || disabled) {
        return;
      }

      /*
       * A TURN IS IN FLIGHT, AND THIS IS THE FORK THE WHOLE AFFORDANCE HANGS ON.
       *
       * With somewhere to park it the message goes there and the box empties, so the person sees
       * their words land. Without, we are back to refusing, which is what every caller that does
       * not queue still gets.
       *
       * It returns before `submitInFlight` and `isSubmitting` are touched on purpose. Those guard
       * one send from starting twice; a send here is held open for the length of the whole run, so
       * borrowing them for a parked message would let the first turn lock out every correction
       * typed while it worked — the exact thing this exists to allow.
       */
      if (isBusy) {
        if (!onQueue) {
          return;
        }
        setValue([]);
        setAttachments([]);
        clearStoredDraft(draftKey);
        onQueue(submitted);
        return;
      }

      if (submitInFlight.current || !onSubmit) {
        return;
      }

      submitInFlight.current = true;
      setIsSubmitting(true);
      // Clear optimistically; restore if the send fails before becoming a message.
      setValue([]);
      setAttachments([]);
      clearStoredDraft(draftKey);
      try {
        await onSubmit(submitted);
      } catch (error) {
        setValue(segments);
        setAttachments([...(submitted.attachments ?? [])]);
        throw error;
      } finally {
        submitInFlight.current = false;
        setIsSubmitting(false);
        // Asked for here, performed in the effect below, which runs after the commit that clears
        // `isSubmitting` and so after the render the caret would otherwise be placed against.
        wantsFocus.current = true;
      }
    },
    [attachments, disabled, draftKey, isBusy, onQueue, onSubmit],
  );

  /**
   * Put the caret back the moment the composer can accept it again.
   *
   * Keyed off the editor becoming interactive rather than off the send resolving, so it survives
   * whatever the parent does with `pending` in between — and it runs after the commit, which is the
   * only point at which the element is enabled and focusable.
   */
  useEffect(() => {
    if (!wantsFocus.current || disabled || isBusy) {
      return;
    }
    wantsFocus.current = false;
    promptAreaRef.current?.focus();
  }, [disabled, isBusy]);

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDraft(value);
  };

  /**
   * There is a turn in flight and somewhere to park what is being typed.
   *
   * Not the same question as "is anything typed" — an empty composer mid-turn can queue nothing,
   * and the button it wants is Stop.
   */
  const canQueue = Boolean(onQueue) && isBusy && !disabled;
  /** Something is typed, mid-turn, with a queue to put it in. */
  const parking = canQueue && !draft.isEmpty;
  const canSend = !disabled && !draft.isEmpty && (!isBusy || canQueue);
  /**
   * Stop is available only once there is a run for it to reach, and it gives way to Send the moment
   * there is something typed to park.
   *
   * `stoppable` rather than `pending`, because a turn is in flight before its run is, and a button
   * that cannot do the thing it names is worse than no button at all.
   *
   * One button, so one of the two has to yield. Send wins because the correction is the thing that
   * cannot wait: park it and the box empties, which brings Stop straight back — so stopping is
   * never more than one press away, and the press before it is the one that saves the sentence.
   * Showing both would be honest and would also put two round buttons in a row on a compact
   * composer that has room for one.
   */
  const canStop = Boolean(onStop) && (stoppable ?? pending) && !parking;
  /**
   * The same arrow either way, because it is the same gesture, but a screen reader is told which of
   * the two it is about to do. "Send" on a button that will not send for another minute is a small
   * lie told to exactly the people who cannot see the queue it lands in.
   */
  const sendLabel = parking ? "Queue message" : "Send message";

  const fileInput = (
    <input
      className="sr-only"
      multiple
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        void addFiles(files);
      }}
      ref={fileInputRef}
      type="file"
    />
  );

  const dropOverlay = draggingFiles ? (
    <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-xl border border-dashed border-primary bg-card/95 text-sm font-medium text-primary">
      Drop files to attach
    </div>
  ) : null;

  const problemLine = attachmentProblem ? (
    <p className="px-3 pb-2 text-xs text-destructive" role="alert">
      {attachmentProblem}
    </p>
  ) : null;

  if (compact) {
    return (
      <form
        aria-busy={isBusy}
        className={cn(
          /*
           * `py-3` on the inner row IS LOAD-BEARING ONCE THE TEXT WRAPS. On one line `min-h-14` and
           * `items-center` fake the vertical padding, so it read as correct for as long as nobody
           * typed a paragraph. Past that the row grows to fit its content exactly and the glyphs
           * sit against the border.
           *
           * It goes outside the editor because the editor scrolls internally at
           * COMPACT_MAX_HEIGHT_PX: padding inside that box would scroll away with the text, so the
           * first visible line would still touch the top edge on a long message.
           */
          "relative flex min-h-14 flex-col rounded-2xl border border-border bg-card transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          draggingFiles && "border-primary bg-primary/5 ring-3 ring-primary/15",
          className,
        )}
        onSubmit={handleFormSubmit}
        {...dragProps}
      >
        {fileInput}
        <AttachmentChips
          attachments={attachments}
          onRemove={removeAttachment}
        />
        <div className="flex w-full items-center gap-3 px-3 py-3">
          <Button
            aria-label="Attach files"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            size="icon"
            title="Attach files"
            type="button"
            variant="ghost"
          >
            <IconPlus className="size-5" />
          </Button>
          <PromptArea
            aria-label="Message"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none"
            disabled={disabled}
            maxHeight={COMPACT_MAX_HEIGHT_PX}
            minHeight={COMPACT_MIN_HEIGHT_PX}
            onChange={handleChange}
            onRawPaste={handleRawPaste}
            onSubmit={submitDraft}
            placeholder="Ask anything"
            ref={promptAreaRef}
            triggers={triggers}
            value={value}
          />
          {canStop ? (
            <Button
              aria-label="Stop the Bot"
              className="size-8 rounded-full p-0"
              data-testid="composer-stop"
              onClick={onStop}
              size="icon"
              type="button"
            >
              <IconPlayerStopFilled className="size-3" />
            </Button>
          ) : (
            <Button
              aria-label={sendLabel}
              className="size-8 rounded-full p-0"
              disabled={!canSend}
              size="icon"
              type="submit"
            >
              <IconArrowUp className="size-3.5" />
            </Button>
          )}
        </div>
        {problemLine}
        {dropOverlay}
      </form>
    );
  }

  return (
    <div className={cn("w-xl", className)}>
      <form
        aria-busy={isBusy}
        className={cn(
          "relative overflow-hidden rounded-2xl border border-border bg-card transition-colors",
          draggingFiles && "border-primary bg-primary/5 ring-3 ring-primary/15",
        )}
        onSubmit={handleFormSubmit}
        {...dragProps}
      >
        {fileInput}
        <AttachmentChips
          attachments={attachments}
          onRemove={removeAttachment}
        />

        <div className="grow px-3 pt-3 pb-2">
          <PromptArea
            aria-label="Message"
            autoGrow
            className="w-full border-0 bg-transparent p-0 text-sm shadow-none"
            disabled={disabled}
            maxHeight={MAX_HEIGHT_PX}
            onChange={handleChange}
            onRawPaste={handleRawPaste}
            onSubmit={submitDraft}
            placeholder="Ask anything"
            ref={promptAreaRef}
            triggers={triggers}
            value={value}
          />
        </div>

        <div className="mb-2 flex items-center justify-between px-2">
          <Button
            aria-label="Attach files"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            size="icon-sm"
            title="Attach files"
            type="button"
            variant="ghost"
          >
            <IconPaperclip />
          </Button>

          <div>
            {canStop ? (
              <Button
                aria-label="Stop the Bot"
                className="size-7 rounded-full bg-primary p-0"
                data-testid="composer-stop"
                onClick={onStop}
                type="button"
              >
                <IconPlayerStopFilled className="size-3" />
              </Button>
            ) : (
              <Button
                aria-label={sendLabel}
                className="size-7 rounded-full bg-primary p-0 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSend}
                type="submit"
              >
                <IconArrowUp className="size-3.5 fill-primary" />
              </Button>
            )}
          </div>
        </div>
        {problemLine}
        {dropOverlay}
      </form>
    </div>
  );
}
