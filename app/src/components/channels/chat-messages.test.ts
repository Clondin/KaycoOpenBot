import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { searchableMessageIds, toVisibleChatItems } from "./chat-messages";

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
