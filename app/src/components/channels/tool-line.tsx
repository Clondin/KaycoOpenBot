import {
  IconAlertTriangle,
  IconBan,
  IconChevronRight,
  IconCircleCheck,
} from "@tabler/icons-react";
import type { ReactNode } from "react";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * THE GLYPH CARRIES THE STATE, NOT JUST THE WORDS. A status ring while the step runs, a check when
 * it lands, an alert when it failed and a bar when it was refused — colour alone asked too much of
 * small muted text, and a scanner should be able to find the one failed step in twenty by shape
 * without reading any of them.
 */
export function ToolLine({
  label,
  detail,
  running,
  refused,
  failed,
  children,
}: {
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
}) {
  const tone = refused
    ? "text-destructive"
    : failed
      ? "text-amber-600 dark:text-amber-500"
      : "text-muted-foreground";

  const glyph = (
    <span aria-hidden className={`inline-flex shrink-0 self-center ${tone}`}>
      {running ? (
        // Inherits the line's colour through currentColor; reduced motion leaves a static ring.
        <span className="step-spinner" />
      ) : refused ? (
        <IconBan className="size-3.5" />
      ) : failed ? (
        <IconAlertTriangle className="size-3.5" />
      ) : (
        <IconCircleCheck className="size-3.5 opacity-70" />
      )}
    </span>
  );

  const text = (
    <span
      className={`inline-flex min-w-0 max-w-full flex-1 items-baseline gap-1.5 text-sm ${tone} ${
        running ? "tool-line-running" : ""
      }`}
    >
      <span className="shrink-0">
        {refused ? "Blocked" : failed ? `${label}, didn't work` : label}
      </span>
      {detail ? <span className="truncate opacity-70">{detail}</span> : null}
    </span>
  );

  if (!children) {
    return (
      <div className="-mx-1 my-1 flex items-start gap-1.5 rounded-md px-1 py-0.5">
        {glyph}
        {text}
      </div>
    );
  }

  return (
    <details className="tool-line my-1 min-w-0">
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state.
       */}
      <summary className="-mx-1 flex cursor-pointer list-none items-start gap-1.5 rounded-md px-1 py-0.5 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="tool-line-chevron mt-[5px] shrink-0 text-muted-foreground/70 transition-transform"
        >
          <IconChevronRight className="size-3" />
        </span>
        {glyph}
        {text}
      </summary>
      {/*
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       *
       * The result opens into a quiet inset surface rather than a bare left rule: it is output,
       * not conversation, and the recessed panel keeps that hierarchy legible.
       */}
      <div className="mt-1.5 mb-1 ml-[13px] max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/25 p-3 text-xs [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
        {children}
      </div>
    </details>
  );
}
