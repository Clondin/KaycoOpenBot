import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  searchableMessageIds,
  shouldShowThinking,
  toVisibleChatItems,
} from "./chat-messages";

const messages: Message[] = [
  {
    id: "user-1",
    role: "user",
    content: [
      { type: "text", text: "Please review this invoice" },
      {
        type: "image",
        source: {
          type: "data",
          value: "cG5n",
          mimeType: "image/png",
        },
        metadata: { filename: "invoice.png" },
      },
    ],
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: "The invoice total is $42.",
  },
];

describe("visible chat messages", () => {
  test("keeps safe attachment metadata and inline image data", () => {
    expect(toVisibleChatItems(messages)[0]).toEqual({
      kind: "text",
      id: "user-1",
      role: "user",
      text: "Please review this invoice",
      attachments: [
        {
          id: "user-1:attachment:1",
          kind: "image",
          name: "invoice.png",
          mimeType: "image/png",
          data: "cG5n",
        },
      ],
    });
  });

  test("shows thinking only when a busy turn has no visible progress", () => {
    const userOnly = toVisibleChatItems([messages[0]]);
    const assistantText = toVisibleChatItems(messages);
    const reasoning = toVisibleChatItems([
      messages[0],
      {
        id: "reasoning-1",
        role: "reasoning",
        content: "Checking the constraints.",
      },
    ]);
    const pendingTool = toVisibleChatItems([
      messages[0],
      {
        id: "assistant-tool",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "browser_open", arguments: "{}" },
          },
        ],
      },
    ]);
    const settledTool = toVisibleChatItems([
      messages[0],
      {
        id: "assistant-tool",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "browser_open", arguments: "{}" },
          },
        ],
      },
      {
        id: "tool-result",
        role: "tool",
        toolCallId: "tool-1",
        content: "Opened",
      },
    ]);

    expect(shouldShowThinking(true, [])).toBe(true);
    expect(shouldShowThinking(true, userOnly)).toBe(true);
    expect(shouldShowThinking(true, pendingTool)).toBe(false);
    expect(shouldShowThinking(true, settledTool)).toBe(true);
    expect(shouldShowThinking(true, assistantText)).toBe(false);
    expect(shouldShowThinking(true, reasoning)).toBe(false);
    expect(shouldShowThinking(false, userOnly)).toBe(false);
  });

  test("keeps streamed reasoning in the visible transcript", () => {
    expect(
      toVisibleChatItems([
        {
          id: "reasoning-1",
          role: "reasoning",
          content: "Checking the request.\n\nChoosing the safest path.",
        },
      ]),
    ).toEqual([
      {
        kind: "reasoning",
        id: "reasoning-1",
        text: "Checking the request.\n\nChoosing the safest path.",
      },
    ]);
  });

  test("finds matching user and assistant messages without case sensitivity", () => {
    expect(searchableMessageIds(messages, "INVOICE")).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(searchableMessageIds(messages, "missing")).toEqual([]);
  });

  test("ignores missing, malformed, and non-text content without throwing", () => {
    const malformed = [
      { id: "missing", role: "user", content: undefined },
      { id: "null", role: "user", content: null },
      {
        id: "mixed",
        role: "user",
        content: [
          null,
          123,
          { type: "text" },
          { type: "text", text: "Valid text" },
          { type: "binary" },
        ],
      },
    ] as unknown as Message[];

    expect(toVisibleChatItems(malformed)).toEqual([
      {
        kind: "text",
        id: "mixed",
        role: "user",
        text: "Valid text",
      },
    ]);
  });
});
