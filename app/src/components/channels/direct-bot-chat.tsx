import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachmentInputPart,
  type ComposerAttachment,
} from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { channelKeys } from "@/lib/channels/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

const READY_BACKSTOP_MS = 1_500;

/** The same conversation surface used by channels, bound directly to one runtime Bot. */
export function DirectBotChat({
  agentId,
  stopped,
  threadId,
}: {
  agentId: string;
  stopped?: string | null;
  threadId: string;
}) {
  const { copilotkit } = useCopilotKit();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createBranch = useMutation(createChannelMutationOptions(queryClient));
  const createBranchRef = useRef(createBranch.mutateAsync);
  createBranchRef.current = createBranch.mutateAsync;
  const { agent, isReady } = useAgent({
    agentId: `direct:${agentId}`,
    runtimeAgentId: agentId,
    threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });
  const skillCommands = useSkillCommands(agentId);
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;
  const readyResolve = useRef<() => void>(() => undefined);
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      readyResolve.current = resolve;
    });
  }

  useActiveBot(agentId);

  useEffect(() => {
    if (isReady) readyResolve.current();
  }, [isReady]);

  useEffect(() => {
    if (!isReady) return;
    let current = true;
    void (async () => {
      try {
        await copilotkit.connectAgent({ agent });
      } catch {
        // A direct run can still succeed when the eager socket connection is unavailable.
      }
      try {
        const response = await fetch(
          `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
          { credentials: "include" },
        );
        if (!response.ok || !current) return;
        const stored = (await response.json()) as { messages?: unknown };
        if (
          Array.isArray(stored.messages) &&
          stored.messages.length > 0 &&
          agent.messages.length === 0
        ) {
          agent.setMessages(stored.messages);
        }
      } catch {
        // History restoration is supporting UX and must not lock the composer.
      }
    })();
    return () => {
      current = false;
    };
  }, [agent, agentId, copilotkit, isReady, threadId]);

  const say = async (
    text: string,
    instructions: readonly string[] = [],
    attachments: readonly ComposerAttachment[] = [],
  ) => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    setTurnsInFlight((count) => count + 1);
    setRunError(null);
    try {
      if (!isReadyRef.current && readyGate.current) {
        await Promise.race([
          readyGate.current,
          new Promise((resolve) =>
            window.setTimeout(resolve, READY_BACKSTOP_MS),
          ),
        ]);
      }
      for (const instruction of instructions) {
        agent.addMessage({
          content: instruction,
          id: crypto.randomUUID(),
          role: "system",
        });
      }
      agent.addMessage({
        content:
          attachments.length === 0
            ? trimmed
            : [
                ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
                ...attachments.map(attachmentInputPart),
              ],
        id: crypto.randomUUID(),
        role: "user",
      });
      const repaired = repairUnansweredToolCalls(agent.messages);
      if (repaired !== agent.messages) {
        agent.setMessages(repaired as typeof agent.messages);
      }
      await copilotkit.runAgent({ agent });
    } catch (error) {
      setRunError(
        error instanceof Error
          ? error.message
          : "The Bot stopped without saying why.",
      );
      throw error;
    } finally {
      setTurnsInFlight((count) => count - 1);
    }
  };
  const sayRef = useRef(say);
  sayRef.current = say;
  const retryLatest = useCallback(() => {
    void sayRef
      .current(
        "Please retry the previous response. Re-check the request and produce a fresh answer.",
      )
      .catch(() => undefined);
  }, []);
  const branchMessage = useCallback(
    (text: string, role: "user" | "assistant") => {
      void (async () => {
        try {
          const branch = await createBranchRef.current([agentId]);
          queryClient.setQueryData(channelKeys.detail(branch.id), branch);
          const quoted = text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
          stashFirstMessage(
            branch.id,
            `Continue from this ${role === "assistant" ? "coworker response" : "message"}:\n\n${quoted}`,
          );
          await navigate({
            params: { channelId: branch.id },
            to: "/channel/$channelId",
          });
        } catch (error) {
          setRunError(
            error instanceof Error
              ? error.message
              : "A new conversation could not be started.",
          );
        }
      })();
    },
    [agentId, navigate, queryClient],
  );

  return (
    <ConversationView
      assistantName="Browser Bot"
      busy={agent.isRunning}
      commands={skillCommands}
      draftKey={`bot:${agentId}:${threadId}`}
      messages={agent.messages}
      onBranchMessage={branchMessage}
      onRetryLatest={retryLatest}
      onStop={() => copilotkit.stopAgent({ agent })}
      onSubmit={async (draft) => {
        const instructions = [
          ...draft.commandIds
            .map(
              (id) =>
                skillCommands.find((command) => command.id === id)?.prompt,
            )
            .filter((instruction): instruction is string =>
              Boolean(instruction),
            ),
          ...(draft.knowledgeRequested
            ? [
                "Search indexed company knowledge with openbot_search_knowledge before answering. Ground factual claims in the returned evidence and cite the source titles and links. Say clearly when the available sources do not support a claim.",
              ]
            : []),
        ];
        await say(draft.text, instructions, draft.attachments);
      }}
      pending={agent.isRunning || turnsInFlight > 0}
      queueWhileBusy
      stoppable={agent.isRunning}
      stopped={runError ?? stopped ?? undefined}
    />
  );
}
