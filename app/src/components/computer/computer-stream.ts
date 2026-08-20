import { apiWebSocketUrl } from "@/lib/api-origin";

export type ComputerStreamMessage =
  | {
      type: "frame";
      data: string | ArrayBuffer;
      width?: number;
      height?: number;
    }
  | { type: "page"; url: string; title?: string }
  | { type: "control"; state: Record<string, unknown> }
  | {
      type: "action";
      action: string;
      ref?: string;
      box?: { x: number; y: number; width: number; height: number } | null;
      at?: string;
    }
  | { type: "error"; error?: string }
  | { type: "download"; path?: string; bytes?: number; error?: string }
  | { type: "connection"; state: "connecting" | "connected" | "reconnecting" };

type Listener = (message: ComputerStreamMessage) => void;

/** One socket per computer, even when the screen is rendered in more than one place. */
class SharedComputerStream {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private latestFrame: ComputerStreamMessage | null = null;
  private latestPage: ComputerStreamMessage | null = null;
  private latestControl: ComputerStreamMessage | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private intentionallyClosed = false;
  private viewerMode: "compact" | "full" = "compact";

  constructor(private readonly computerId: string) {}

  subscribe(listener: Listener): () => void {
    clearTimeout(this.closeTimer);
    this.listeners.add(listener);
    for (const message of [
      this.latestFrame,
      this.latestPage,
      this.latestControl,
    ]) {
      if (message) listener(message);
    }
    this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        // A short grace keeps the same socket while React moves between inline and expanded layouts.
        this.closeTimer = setTimeout(() => this.close(), 2_000);
      }
    };
  }

  send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  setViewerMode(mode: "compact" | "full"): void {
    this.viewerMode = mode;
    this.send({ type: "viewer", mode });
  }

  private emit(message: ComputerStreamMessage): void {
    if (message.type === "frame") this.latestFrame = message;
    if (message.type === "page") this.latestPage = message;
    if (message.type === "control") this.latestControl = message;
    for (const listener of this.listeners) listener(message);
  }

  private ensureConnected(): void {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.intentionallyClosed = false;
    this.emit({
      type: "connection",
      state: this.reconnectAttempt ? "reconnecting" : "connecting",
    });
    const socket = new WebSocket(
      apiWebSocketUrl(
        `/api/computers/${encodeURIComponent(this.computerId)}/stream`,
      ),
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.emit({ type: "connection", state: "connected" });
      this.send({ type: "viewer", mode: this.viewerMode });
    };
    socket.onmessage = (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength <= 8) return;
          const view = new DataView(event.data);
          this.emit({
            type: "frame",
            data: event.data.slice(8),
            width: view.getUint32(0),
            height: view.getUint32(4),
          });
        } else {
          this.emit(JSON.parse(String(event.data)) as ComputerStreamMessage);
        }
      } catch {
        // A malformed frame is isolated; the next valid frame replaces it.
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.intentionallyClosed || this.listeners.size === 0) return;
      this.reconnectAttempt += 1;
      this.emit({ type: "connection", state: "reconnecting" });
      const delay = Math.min(5_000, 250 * 2 ** (this.reconnectAttempt - 1));
      this.reconnectTimer = setTimeout(() => this.ensureConnected(), delay);
    };
  }

  private close(): void {
    if (this.listeners.size > 0) return;
    this.intentionallyClosed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }
}

const streams = new Map<string, SharedComputerStream>();

function streamFor(computerId: string): SharedComputerStream {
  const existing = streams.get(computerId);
  if (existing) return existing;
  const created = new SharedComputerStream(computerId);
  streams.set(computerId, created);
  return created;
}

export function subscribeToComputerStream(
  computerId: string,
  listener: Listener,
): () => void {
  return streamFor(computerId).subscribe(listener);
}

export function sendComputerStreamInput(
  computerId: string,
  message: Record<string, unknown>,
): void {
  streamFor(computerId).send(message);
}

export function setComputerStreamMode(
  computerId: string,
  mode: "compact" | "full",
): void {
  streamFor(computerId).setViewerMode(mode);
}
