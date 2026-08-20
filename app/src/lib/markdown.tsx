import type { ComponentProps } from "react";

/**
 * Shared markdown rendering for Bot prose and tool results.
 *
 * Links open in a new tab with `noreferrer` because content can come from a model or remote MCP
 * server.
 */
export const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentProps<"a">) => (
    <a
      {...rest}
      className="underline underline-offset-2 hover:no-underline"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  ),
};

/**
 * Streamdown's built-in block controls, shared so prose and tool results agree.
 *
 * Copy is the one people reach for constantly and it costs nothing; download stays off because a
 * file named by a heuristic is a worse answer than select-and-paste. Mermaid renders with copy and
 * fullscreen so a Bot can answer with a diagram and the reader can actually look at it.
 */
export const markdownControls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
} as const;

/** Code blocks in chat are read as sentences, not reviewed as files; gutters are noise here. */
export const markdownLineNumbers = false;
