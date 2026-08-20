import { describe, expect, test } from "bun:test";
import type { ComposerDraft } from "./composer";
import { stashRoutedMessage, takeRoutedMessage } from "./transcript-messages";

describe("coworker message routing", () => {
  test("carries the complete draft across a coworker remount exactly once", () => {
    const draft: ComposerDraft = {
      text: "@Research check the launch plan",
      agentId: "research",
      commandIds: ["search"],
      attachments: [
        {
          id: "plan",
          name: "plan.txt",
          mimeType: "text/plain",
          bytes: 4,
          data: "cGxhbg==",
          kind: "document",
        },
      ],
      knowledgeRequested: true,
      isEmpty: false,
    };

    stashRoutedMessage("channel-1", "research", draft, ["Search first."]);
    draft.commandIds.push("mutated-after-stash");
    draft.attachments.length = 0;

    expect(takeRoutedMessage("channel-1", "research")).toEqual({
      draft: {
        ...draft,
        commandIds: ["search"],
        attachments: [
          {
            id: "plan",
            name: "plan.txt",
            mimeType: "text/plain",
            bytes: 4,
            data: "cGxhbg==",
            kind: "document",
          },
        ],
      },
      skillInstructions: ["Search first."],
    });
    expect(takeRoutedMessage("channel-1", "research")).toBeNull();
  });

  test("does not leak a message to a different coworker", () => {
    const draft: ComposerDraft = {
      text: "private request",
      agentId: "research",
      commandIds: [],
      attachments: [],
      knowledgeRequested: false,
      isEmpty: false,
    };
    stashRoutedMessage("channel-2", "research", draft, []);

    expect(takeRoutedMessage("channel-2", "sales")).toBeNull();
    expect(takeRoutedMessage("channel-2", "research")?.draft.text).toBe(
      "private request",
    );
  });
});
