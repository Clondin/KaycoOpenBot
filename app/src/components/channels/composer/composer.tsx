import {
  IconArrowUp,
  IconBook2,
  IconCamera,
  IconMicrophone,
  IconMicrophoneOff,
  IconPaperclip,
  IconPlayerStopFilled,
  IconX,
} from "@tabler/icons-react";
import { PromptArea, type PromptAreaHandle } from "prompt-area";
import { plainTextToSegments, type Segment } from "prompt-area/helpers";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { cn } from "@/lib/utils";
import { Button } from "../../ui/button";
import {
  attachmentFromFile,
  canAddAttachments,
  type ComposerAttachment,
} from "./attachments";
import {
  applyCommandChips,
  type CommandOption,
  type ComposerDraft,
  enforceSingleAgent,
  toDraft,
} from "./draft";
import { PLACEHOLDER_COMMANDS } from "./sources";
import { type AgentOption, buildTriggers } from "./triggers";
import {
  clearStoredDraft,
  readStoredDraft,
  writeStoredDraft,
} from "./persistence";

const MAX_HEIGHT_PX = 220;
/**
 * Tracks the compact `text-sm` line box so PromptArea stays vertically centered in one row.
 */
const COMPACT_MIN_HEIGHT_PX = 19;
const COMPACT_MAX_HEIGHT_PX = 96;

export type ComposerInsertion = {
  id: string;
  mode: "append" | "replace";
  text: string;
};

type SpeechRecognitionResultLike = {
  readonly 0?: { readonly transcript?: string };
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: { results: ArrayLike<SpeechRecognitionResultLike> }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechRecognitionConstructor():
  | (new () => SpeechRecognitionLike)
  | undefined {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function rememberSubmitted(history: string[], text: string) {
  const trimmed = text.trim();
  if (!trimmed || history.at(-1) === trimmed) return;
  history.push(trimmed);
  if (history.length > 50) history.splice(0, history.length - 50);
}

export type ComposerProps = {
  className?: string;
  compact?: boolean;
  /** Agents that `@` can address. Empty means the mention menu reports an empty channel. */
  agents?: readonly AgentOption[];
  commands?: readonly CommandOption[];
  /** Browser-local key for restoring unsent text after a reload. Attachments are never persisted. */
  draftKey?: string;
  /** Loads text from a transcript action such as Quote or Edit and resend. */
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

function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <fieldset
      aria-label="Attachments"
      className="flex min-w-0 flex-wrap gap-1.5 border-0 px-3 pt-2"
    >
      {attachments.map((attachment) => (
        <span
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
        </span>
      ))}
    </fieldset>
  );
}

function ComposerTools({
  disabled,
  isCapturing,
  isListening,
  knowledgeRequested,
  onAttach,
  onCapture,
  onDictate,
  onToggleKnowledge,
}: {
  disabled: boolean;
  isCapturing: boolean;
  isListening: boolean;
  knowledgeRequested: boolean;
  onAttach: () => void;
  onCapture: () => void;
  onDictate: () => void;
  onToggleKnowledge: () => void;
}) {
  return (
    <div
      aria-label="Message tools"
      className="flex min-w-0 items-center gap-0.5"
      role="toolbar"
    >
      <Button
        aria-label="Attach files"
        disabled={disabled}
        onClick={onAttach}
        size="icon-sm"
        title="Attach files"
        type="button"
        variant="ghost"
      >
        <IconPaperclip />
      </Button>
      <Button
        aria-label={
          isCapturing ? "Capturing screen" : "Attach a screen capture"
        }
        disabled={disabled || isCapturing}
        onClick={onCapture}
        size="icon-sm"
        title="Attach a screen capture"
        type="button"
        variant="ghost"
      >
        <IconCamera className={isCapturing ? "animate-pulse" : undefined} />
      </Button>
      <Button
        aria-label={
          isListening ? "Stop voice dictation" : "Start voice dictation"
        }
        aria-pressed={isListening}
        className={
          isListening ? "bg-destructive/10 text-destructive" : undefined
        }
        disabled={disabled}
        onClick={onDictate}
        size="icon-sm"
        title={isListening ? "Stop dictation" : "Dictate message"}
        type="button"
        variant="ghost"
      >
        {isListening ? <IconMicrophoneOff /> : <IconMicrophone />}
      </Button>
      <Button
        aria-label="Ground this answer in company knowledge"
        aria-pressed={knowledgeRequested}
        className={
          knowledgeRequested
            ? "bg-primary/10 text-primary hover:bg-primary/15"
            : undefined
        }
        disabled={disabled}
        onClick={onToggleKnowledge}
        size={knowledgeRequested ? "sm" : "icon-sm"}
        title="Search company knowledge for this answer"
        type="button"
        variant="ghost"
      >
        <IconBook2 />
        {knowledgeRequested ? "Company knowledge" : null}
      </Button>
    </div>
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
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const storageKey =
    currentUser && draftKey ? `${currentUser.id}:${draftKey}` : undefined;
  const [value, setValue] = useState<Segment[]>(() =>
    readStoredDraft(storageKey),
  );
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [knowledgeRequested, setKnowledgeRequested] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [attachmentProblem, setAttachmentProblem] = useState<string | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyScratchRef = useRef("");
  const lastInsertionRef = useRef<string | null>(null);
  /** A send has completed and the caret is owed back, as soon as the editor will take it. */
  const wantsFocus = useRef(false);

  const isBusy = pending || isSubmitting;
  const triggers = useMemo(
    () => buildTriggers({ agents, commands }),
    [agents, commands],
  );
  const draft = useMemo(
    () => toDraft(value, attachments, knowledgeRequested),
    [value, attachments, knowledgeRequested],
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
    historyIndexRef.current = null;
    window.requestAnimationFrame(() => {
      promptAreaRef.current?.focus();
      promptAreaRef.current?.setCursorToEnd();
    });
  }, [insertion, value]);

  useEffect(() => {
    writeStoredDraft(storageKey, toDraft(value).text);
  }, [storageKey, value]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentProblem(null);
  }, []);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
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
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) void addFiles(files);
    },
    [addFiles],
  );

  const captureScreen = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setAttachmentProblem("Screen capture is not available in this browser.");
      return;
    }
    setIsCapturing(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("The screen capture could not be encoded.");
      await addFiles([
        new File(
          [blob],
          `screen-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.png`,
          {
            type: "image/png",
          },
        ),
      ]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setAttachmentProblem(null);
      } else {
        setAttachmentProblem(
          error instanceof Error
            ? error.message
            : "The screen capture could not be attached.",
        );
      }
    } finally {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      setIsCapturing(false);
    }
  }, [addFiles]);

  const toggleDictation = useCallback(() => {
    if (speechRef.current) {
      speechRef.current.stop();
      speechRef.current = null;
      setIsListening(false);
      return;
    }
    const SpeechRecognition = speechRecognitionConstructor();
    if (!SpeechRecognition) {
      setAttachmentProblem("Voice dictation is not available in this browser.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) {
        const prefix = promptAreaRef.current?.getPlainText().trim() ? " " : "";
        promptAreaRef.current?.appendText(`${prefix}${transcript}`);
      }
    };
    recognition.onerror = () => {
      speechRef.current = null;
      setIsListening(false);
      setAttachmentProblem("Voice dictation stopped unexpectedly.");
    };
    recognition.onend = () => {
      speechRef.current = null;
      setIsListening(false);
    };
    speechRef.current = recognition;
    setAttachmentProblem(null);
    setIsListening(true);
    try {
      recognition.start();
    } catch (error) {
      speechRef.current = null;
      setIsListening(false);
      setAttachmentProblem(
        error instanceof Error
          ? error.message
          : "Voice dictation could not start.",
      );
    }
  }, []);

  useEffect(
    () => () => {
      speechRef.current?.stop();
    },
    [],
  );

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const history = historyRef.current;
    if (history.length === 0) return;
    const current = promptAreaRef.current?.getPlainText() ?? "";
    if (historyIndexRef.current === null) {
      if (event.key === "ArrowDown" || current.trim()) return;
      historyScratchRef.current = current;
      historyIndexRef.current = history.length - 1;
    } else if (event.key === "ArrowUp") {
      historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
    } else if (historyIndexRef.current >= history.length - 1) {
      historyIndexRef.current = null;
    } else {
      historyIndexRef.current += 1;
    }
    event.preventDefault();
    const next =
      historyIndexRef.current === null
        ? historyScratchRef.current
        : history[historyIndexRef.current];
    setValue(plainTextToSegments(next ?? ""));
    window.requestAnimationFrame(() => promptAreaRef.current?.setCursorToEnd());
  }, []);

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
      const submitted = toDraft(segments, attachments, knowledgeRequested);
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
        setKnowledgeRequested(false);
        rememberSubmitted(historyRef.current, submitted.text);
        historyIndexRef.current = null;
        clearStoredDraft(storageKey);
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
      setKnowledgeRequested(false);
      rememberSubmitted(historyRef.current, submitted.text);
      historyIndexRef.current = null;
      clearStoredDraft(storageKey);
      try {
        await onSubmit(submitted);
      } catch (error) {
        setValue(segments);
        setAttachments(submitted.attachments);
        setKnowledgeRequested(submitted.knowledgeRequested);
        throw error;
      } finally {
        submitInFlight.current = false;
        setIsSubmitting(false);
        // Asked for here, performed in the effect below, which runs after the commit that clears
        // `isSubmitting` and so after the render the caret would otherwise be placed against.
        wantsFocus.current = true;
      }
    },
    [
      attachments,
      disabled,
      isBusy,
      knowledgeRequested,
      onQueue,
      onSubmit,
      storageKey,
    ],
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

  if (compact) {
    return (
      <form
        aria-busy={isBusy}
        className={cn(
          /*
           * `py-3` IS LOAD-BEARING ONCE THE TEXT WRAPS. On one line `min-h-14` and `items-center`
           * fake the vertical padding, so it read as correct for as long as nobody typed a
           * paragraph. Past that the row grows to fit its content exactly and the glyphs sit
           * against the border.
           *
           * It goes on the form rather than on the editor because the editor scrolls internally at
           * COMPACT_MAX_HEIGHT_PX: padding inside that box would scroll away with the text, so the
           * first visible line would still touch the top edge on a long message.
           */
          "relative flex min-h-14 flex-col rounded-2xl border border-border bg-card transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          draggingFiles && "border-primary bg-primary/5 ring-3 ring-primary/15",
          className,
        )}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            setDraggingFiles(true);
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDraggingFiles(false);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onSubmit={handleFormSubmit}
      >
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
        <AttachmentList attachments={attachments} onRemove={removeAttachment} />
        <div className="flex w-full items-center gap-3 px-3 py-3">
          <PromptArea
            aria-label="Message"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none"
            disabled={disabled}
            maxHeight={COMPACT_MAX_HEIGHT_PX}
            minHeight={COMPACT_MIN_HEIGHT_PX}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
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
        <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/60 px-2 py-1.5">
          <ComposerTools
            disabled={disabled}
            isCapturing={isCapturing}
            isListening={isListening}
            knowledgeRequested={knowledgeRequested}
            onAttach={() => fileInputRef.current?.click()}
            onCapture={() => void captureScreen()}
            onDictate={toggleDictation}
            onToggleKnowledge={() =>
              setKnowledgeRequested((current) => !current)
            }
          />
          <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
            {parking
              ? "Sends after current task"
              : "Enter to send · Shift+Enter for a new line"}
          </span>
        </div>
        {draggingFiles ? (
          <div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-xl border border-dashed border-primary bg-card/95 text-sm font-medium text-primary">
            Drop files to attach
          </div>
        ) : null}
        {attachmentProblem ? (
          <p className="px-3 pb-2 text-xs text-destructive" role="alert">
            {attachmentProblem}
          </p>
        ) : null}
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
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            setDraggingFiles(true);
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDraggingFiles(false);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onSubmit={handleFormSubmit}
      >
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

        <AttachmentList attachments={attachments} onRemove={removeAttachment} />

        <div className="grow px-3 pt-3 pb-2">
          <PromptArea
            aria-label="Message"
            autoGrow
            className="w-full border-0 bg-transparent p-0 text-sm shadow-none"
            disabled={disabled}
            maxHeight={MAX_HEIGHT_PX}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onRawPaste={handleRawPaste}
            onSubmit={submitDraft}
            placeholder="Ask anything"
            ref={promptAreaRef}
            triggers={triggers}
            value={value}
          />
        </div>

        <div className="mb-2 flex items-center justify-between px-2">
          <ComposerTools
            disabled={disabled}
            isCapturing={isCapturing}
            isListening={isListening}
            knowledgeRequested={knowledgeRequested}
            onAttach={() => fileInputRef.current?.click()}
            onCapture={() => void captureScreen()}
            onDictate={toggleDictation}
            onToggleKnowledge={() =>
              setKnowledgeRequested((current) => !current)
            }
          />

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
        {attachmentProblem ? (
          <p className="px-3 pb-2 text-xs text-destructive" role="alert">
            {attachmentProblem}
          </p>
        ) : null}
        {draggingFiles ? (
          <div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-xl border border-dashed border-primary bg-card/95 text-sm font-medium text-primary">
            Drop files to attach
          </div>
        ) : null}
      </form>
    </div>
  );
}
