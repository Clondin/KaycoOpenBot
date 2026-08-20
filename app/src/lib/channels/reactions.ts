import {
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";

export const MESSAGE_REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "✅"] as const;
export type MessageReactionEmoji = (typeof MESSAGE_REACTION_EMOJIS)[number];

export type MessageReaction = {
  messageId: string;
  emoji: MessageReactionEmoji;
  count: number;
  mine: boolean;
};

const reactionKeys = {
  channel: (channelId: string) => ["channels", channelId, "reactions"] as const,
  messages: (channelId: string, messageIds: readonly string[]) =>
    [...reactionKeys.channel(channelId), [...messageIds]] as const,
};

export function messageReactionsQueryOptions(
  channelId: string | undefined,
  messageIds: readonly string[],
) {
  return queryOptions({
    queryKey: reactionKeys.messages(channelId ?? "none", messageIds),
    enabled: Boolean(channelId) && messageIds.length > 0,
    queryFn: async (): Promise<MessageReaction[]> => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId ?? "")}/reactions/query`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageIds }),
        },
      );
      if (!response.ok) throw new Error("Could not load message reactions.");
      return ((await response.json()) as { reactions: MessageReaction[] })
        .reactions;
    },
    staleTime: 15_000,
  });
}

export function setMessageReactionMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (input: {
      messageId: string;
      emoji: MessageReactionEmoji;
      active: boolean;
    }) => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/reactions`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new Error("Could not update that reaction.");
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: reactionKeys.channel(channelId),
      }),
  });
}
