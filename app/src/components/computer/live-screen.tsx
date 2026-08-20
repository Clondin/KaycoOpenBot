import { useCallback, useEffect, useRef, useState } from "react";
import { pageCoordinates } from "./take-the-wheel";
import {
  type ComputerStreamMessage,
  sendComputerStreamInput,
  setComputerStreamMode,
  subscribeToComputerStream,
} from "./computer-stream";
import {
  reportComputerActivity,
  updateComputerActivity,
} from "@/lib/copilot/computer-activity";

function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

type ControlState = {
  holder: "bot" | "human";
  since: string;
  reason?: string;
  requested: boolean;
  secretWanted?: string;
};

type Props = {
  computerId: string;
  driving: boolean;
  onProblem?: (problem: string | null) => void;
  onControl?: (state: ControlState) => void;
  onPage?: (page: { url: string; title?: string }) => void;
  onFrame?: () => void;
  mode?: "compact" | "full";
};

type ActionMarker = Extract<ComputerStreamMessage, { type: "action" }>;

/**
 * A view onto the shared low-latency computer stream.
 *
 * Rendering another view no longer opens another socket. Frames are decoded off the main thread,
 * older decodes are discarded, and the canvas itself holds focus while a person is driving so the
 * rest of the app does not unexpectedly capture their keyboard.
 */
export function LiveScreen({
  computerId,
  driving,
  onProblem,
  onControl,
  onPage,
  onFrame,
  mode = "compact",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  const callbacks = useRef({ onProblem, onControl, onPage, onFrame });
  callbacks.current = { onProblem, onControl, onPage, onFrame };
  const newestFrame = useRef(0);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  const [marker, setMarker] = useState<ActionMarker | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    let live = true;
    let markerTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeToComputerStream(
      computerId,
      async (message) => {
        if (!live) return;
        if (message.type === "connection") {
          setConnection(message.state);
          callbacks.current.onProblem?.(
            message.state === "reconnecting"
              ? "The live screen disconnected. Reconnecting…"
              : null,
          );
          return;
        }
        if (message.type === "error") {
          callbacks.current.onProblem?.(
            message.error ?? "The live screen could not be shown.",
          );
          return;
        }
        if (message.type === "control") {
          callbacks.current.onControl?.(message.state as ControlState);
          return;
        }
        if (message.type === "page") {
          callbacks.current.onPage?.({
            url: message.url,
            title: message.title,
          });
          return;
        }
        if (message.type === "action") {
          setMarker(message);
          setAnnouncement(
            `Assistant ${message.action === "type" ? "filled a field" : message.action === "key" ? "pressed a key" : message.action === "scroll" ? "scrolled the page" : "clicked a control"}.`,
          );
          clearTimeout(markerTimer);
          markerTimer = setTimeout(() => setMarker(null), 900);
          return;
        }
        if (message.type === "download") {
          const activity = reportComputerActivity(computerId, {
            stage: "reading",
            label: message.path
              ? `Saving ${message.path}`
              : "Saving a download",
          });
          updateComputerActivity(activity, {
            stage: message.error ? "error" : "complete",
            label:
              message.error ??
              (message.path ? `Downloaded ${message.path}` : "Download saved"),
          });
          setAnnouncement(
            message.error ??
              (message.path
                ? `Downloaded ${message.path}.`
                : "Download saved."),
          );
          return;
        }

        const version = ++newestFrame.current;
        const canvas = canvasRef.current;
        if (!canvas) return;
        frameSize.current = {
          width: message.width ?? 1280,
          height: message.height ?? 800,
        };
        try {
          const binary =
            typeof message.data === "string"
              ? Uint8Array.from(atob(message.data), (character) =>
                  character.charCodeAt(0),
                )
              : new Uint8Array(message.data);
          const bitmap = await createImageBitmap(
            new Blob([binary], { type: "image/jpeg" }),
          );
          if (!live || version !== newestFrame.current) {
            bitmap.close();
            return;
          }
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
          callbacks.current.onFrame?.();
        } catch {
          // A single corrupt frame is harmless; the next page change sends another.
        }
      },
    );
    setComputerStreamMode(computerId, mode);
    return () => {
      live = false;
      clearTimeout(markerTimer);
      unsubscribe();
    };
  }, [computerId, mode]);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      if (driving) sendComputerStreamInput(computerId, message);
    },
    [computerId, driving],
  );

  const at = useCallback((event: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const size = frameSize.current;
    if (!canvas || !size) return null;
    return pageCoordinates(
      { naturalWidth: size.width, naturalHeight: size.height },
      canvas.getBoundingClientRect(),
      event,
    );
  }, []);

  const onMouse = useCallback(
    (kind: "pressed" | "released" | "moved") =>
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (kind === "pressed") event.currentTarget.focus();
        const point = at(event);
        if (!point) return;
        send({
          type: "mouse",
          event: kind,
          ...point,
          button:
            event.button === 2
              ? "right"
              : event.button === 1
                ? "middle"
                : "left",
          clickCount: kind === "moved" ? 0 : 1,
          modifiers: modifierBits(event),
        });
      },
    [at, send],
  );

  const markerStyle = marker?.box
    ? {
        left: `${(marker.box.x / (frameSize.current?.width ?? 1280)) * 100}%`,
        top: `${(marker.box.y / (frameSize.current?.height ?? 800)) * 100}%`,
        width: `${(marker.box.width / (frameSize.current?.width ?? 1280)) * 100}%`,
        height: `${(marker.box.height / (frameSize.current?.height ?? 800)) * 100}%`,
      }
    : undefined;

  return (
    <div className="relative overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className={`block h-auto w-full outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${driving ? "cursor-crosshair" : ""}`}
        tabIndex={driving ? 0 : -1}
        {...(driving
          ? {
              onMouseDown: onMouse("pressed"),
              onMouseUp: onMouse("released"),
              onMouseMove: onMouse("moved"),
              onContextMenu: (event: React.MouseEvent) =>
                event.preventDefault(),
              onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => {
                const point = at(event);
                if (!point) return;
                send({
                  type: "wheel",
                  ...point,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                  modifiers: modifierBits(event),
                });
              },
              onKeyDown: (event: React.KeyboardEvent<HTMLCanvasElement>) => {
                if (event.key === "Escape") return;
                event.preventDefault();
                send({
                  type: "key",
                  event: "down",
                  key: event.key,
                  code: event.code,
                  ...(event.key.length === 1 ? { text: event.key } : {}),
                  modifiers: modifierBits(event),
                });
              },
              onKeyUp: (event: React.KeyboardEvent<HTMLCanvasElement>) => {
                if (event.key === "Escape") return;
                event.preventDefault();
                send({
                  type: "key",
                  event: "up",
                  key: event.key,
                  code: event.code,
                  modifiers: modifierBits(event),
                });
              },
              onPaste: (event: React.ClipboardEvent<HTMLCanvasElement>) => {
                const text = event.clipboardData.getData("text");
                if (!text) return;
                event.preventDefault();
                send({ type: "text", text });
              },
            }
          : {})}
        aria-label={
          driving
            ? "The assistant's live screen. You have control. Focus here to click, type, or paste."
            : "The assistant's live screen"
        }
        aria-describedby={driving ? `computer-help-${computerId}` : undefined}
        data-connected={connection === "connected"}
      />
      {markerStyle ? (
        <span
          aria-hidden="true"
          className="absolute pointer-events-none rounded border-2 border-sky-400 bg-sky-400/15 animate-pulse"
          style={markerStyle}
        />
      ) : null}
      <span className="sr-only" aria-live="polite" role="status">
        {announcement}
      </span>
      {connection !== "connected" ? (
        <span className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-1 text-xs text-white">
          {connection === "reconnecting" ? "Reconnecting…" : "Connecting…"}
        </span>
      ) : null}
      {driving ? (
        <span id={`computer-help-${computerId}`} className="sr-only">
          Click the screen to focus it. Paste sends text directly to the remote
          page. Press Escape to leave full screen.
        </span>
      ) : null}
    </div>
  );
}
