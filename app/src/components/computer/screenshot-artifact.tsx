import { IconCamera } from "@tabler/icons-react";
import { ToolLine } from "@/components/channels/tool-line";

type ScreenshotOutcome = {
  ok?: boolean;
  base64?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
  url?: string;
  reason?: string;
};

function outcomeOf(result: string | undefined): ScreenshotOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ScreenshotOutcome)
      : {};
  } catch {
    return { ok: false, reason: "The screenshot result could not be read." };
  }
}

/** A stable point-in-time screen capture, kept in the transcript with the tool result. */
export function ScreenshotArtifact({
  result,
  running,
}: {
  result?: string;
  running: boolean;
}) {
  if (running) return <ToolLine label="Capturing the screen" running />;
  const outcome = outcomeOf(result);
  if (outcome.ok === false || !outcome.base64) {
    return (
      <ToolLine
        detail={outcome.reason}
        failed
        label="Could not capture the screen"
      />
    );
  }

  return (
    <figure className="my-2 overflow-hidden rounded-xl border bg-card">
      <img
        alt="Screen captured by the Bot"
        className="max-h-96 w-full bg-muted object-contain"
        height={outcome.height}
        src={`data:image/png;base64,${outcome.base64}`}
        width={outcome.width}
      />
      <figcaption className="flex min-w-0 items-center gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
        <IconCamera className="size-3.5 shrink-0" />
        <span className="truncate">{outcome.url ?? "Bot screen"}</span>
        {outcome.capturedAt ? (
          <time className="ml-auto shrink-0" dateTime={outcome.capturedAt}>
            {new Date(outcome.capturedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        ) : null}
      </figcaption>
    </figure>
  );
}
