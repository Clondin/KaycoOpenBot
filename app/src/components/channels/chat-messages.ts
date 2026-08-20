import type { Message, ToolCall } from "@ag-ui/core";

/**
 * Transcript projection that pairs assistant tool calls with later tool-result messages.
 */

export type VisibleChatItem =
  | {
      kind: "text";
      id: string;
      role: "user" | "assistant";
      text: string;
      attachments?: VisibleAttachment[];
    }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
    };

export type VisibleAttachment = {
  id: string;
  kind: "image" | "audio" | "video" | "document" | "binary";
  name: string;
  mimeType: string;
  /** Present only for an inline data image. Never used for document text. */
  data?: string;
};

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    isRecord(part) && part.type === "text" && typeof part.text === "string"
  );
}

function isMediaKind(
  value: unknown,
): value is Exclude<VisibleAttachment["kind"], "binary"> {
  return (
    value === "image" ||
    value === "audio" ||
    value === "video" ||
    value === "document"
  );
}

export function toVisibleChatItems(
  messages: ReadonlyArray<Readonly<Message>>,
): VisibleChatItem[] {
  // Gather results first so calls render with their current completion state in the same pass.
  const results = new Map<string, string | undefined>();
  for (const message of messages) {
    if (isToolResult(message)) results.set(message.toolCallId, message.content);
  }

  return messages.flatMap((message): VisibleChatItem[] => {
    if (message.role === "assistant") {
      const items: VisibleChatItem[] = [];
      if (message.content) {
        items.push({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        items.push({
          kind: "tool",
          // One assistant message can carry multiple tool calls.
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
        });
      }
      return items;
    }

    if (message.role !== "user") return [];

    const parts = Array.isArray(message.content) ? message.content : [];
    const text =
      typeof message.content === "string"
        ? message.content
        : parts
            .filter(isTextPart)
            .map((part) => part.text)
            .filter(Boolean)
            .join("\n");
    const attachments = parts.flatMap((part, index): VisibleAttachment[] => {
      if (!isRecord(part) || part.type === "text") return [];
      if (part.type === "binary") {
        if (typeof part.mimeType !== "string") return [];
        return [
          {
            id: `${message.id}:attachment:${index}`,
            kind: "binary",
            name:
              typeof part.filename === "string" ? part.filename : "Attachment",
            mimeType: part.mimeType,
          },
        ];
      }
      if (!isMediaKind(part.type) || !isRecord(part.source)) return [];
      const metadata = isRecord(part.metadata) ? part.metadata : null;
      return [
        {
          id: `${message.id}:attachment:${index}`,
          kind: part.type,
          name:
            typeof metadata?.filename === "string"
              ? metadata.filename
              : `${part.type} attachment`,
          mimeType:
            typeof part.source.mimeType === "string"
              ? part.source.mimeType
              : `${part.type}/*`,
          ...(part.type === "image" &&
          part.source.type === "data" &&
          typeof part.source.value === "string"
            ? { data: part.source.value }
            : {}),
        },
      ];
    });

    return text || attachments.length > 0
      ? [
          {
            kind: "text",
            id: message.id,
            role: "user",
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
          },
        ]
      : [];
  });
}

/**
 * Whether the transcript needs its own progress line at the end.
 *
 * A pending tool call already shimmers, and streamed assistant text is visible progress in its own
 * right. The gaps that need an explicit status are before the first output and after a tool result,
 * while the Bot is deciding what to do next.
 */
export function shouldShowThinking(
  busy: boolean,
  items: readonly VisibleChatItem[],
): boolean {
  if (!busy) return false;

  const lastItem = items.at(-1);
  if (!lastItem) return true;
  if (lastItem.kind === "tool") return "result" in lastItem;
  return lastItem.role === "user";
}

export function searchableMessageIds(
  messages: ReadonlyArray<Readonly<Message>>,
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return toVisibleChatItems(messages).flatMap((item) =>
    item.kind === "text" && item.text.toLocaleLowerCase().includes(needle)
      ? [item.id]
      : [],
  );
}
