import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { EASE_OUT } from "@/lib/motion";

/**
 * A slim, persistent account of the turn in flight, pinned above the composer.
 *
 * WHY IT EXISTS ALONGSIDE THE TRANSCRIPT'S OWN THINKING LINE: the thinking line lives at the bottom
 * of the conversation, where the answer will land — exactly right while the person is watching the
 * end of the thread, and invisible the moment they scroll up to re-read something. This bar does not
 * scroll. Whatever part of the transcript is on screen, the fact that the Bot is still working, what
 * it was last seen doing, and for how long stay in one fixed place.
 *
 * The action label is the latest tool call's humanised name ("Reading the page"), or plain thinking
 * before the first tool runs. Both shimmer through the same `.tool-line-running` treatment a running
 * tool line uses, so "working" reads identically everywhere it appears.
 */
export function AgentActivityBar({
  active,
  actionLabel,
}: {
  /** A turn is in flight. False collapses the bar entirely. */
  active: boolean;
  /** What the Bot was last seen doing; undefined falls back to "Thinking". */
  actionLabel?: string | undefined;
}) {
  const shouldReduceMotion = useReducedMotion();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    setSeconds(Math.floor((Date.now() - started) / 1000));
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [active]);

  return (
    <AnimatePresence initial={false}>
      {active ? (
        <motion.div
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          aria-label="The assistant is working"
          className="mb-2 flex items-center gap-2.5 rounded-2xl border border-border/70 bg-card/90 py-2 pr-3 pl-3.5 shadow-xs backdrop-blur-sm"
          exit={{
            opacity: 0,
            ...(shouldReduceMotion ? {} : { transform: "translateY(4px)" }),
          }}
          initial={{
            opacity: 0,
            ...(shouldReduceMotion ? {} : { transform: "translateY(4px)" }),
          }}
          role="status"
          transition={{
            duration: 0.18,
            ease: EASE_OUT,
          }}
        >
          <span aria-hidden className="thinking-orb-halo">
            <span className="thinking-orb scale-75" />
          </span>
          <span className="tool-line-running min-w-0 truncate text-muted-foreground text-sm">
            {actionLabel ?? "Thinking"}
          </span>
          {/* Tabular figures so the count ticks without the digits shifting under themselves. */}
          <span
            aria-hidden
            className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/80 tabular-nums"
          >
            {seconds >= 5 ? `${seconds}s` : ""}
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
