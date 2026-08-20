import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { DirectBotChat } from "@/components/channels/direct-bot-chat";
import { agentQueryOptions } from "@/lib/agents/queries";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const agentId = agent ?? "risk-analyst";

  const profile = useQuery(agentQueryOptions(agentId));
  // Minted by this deployment rather than by the chat, and the same one on the next visit.
  const threadId = useBotThread(agentId);
  const stopped = useStoppedTurn(agentId);

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
          <AbstractAvatar
            name={profile.data?.name ?? "Browser Bot"}
            seed={profile.data?.avatarSeed ?? agentId}
            size={34}
          />
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-sm">
              {profile.data?.name ?? "Browser Bot"}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {profile.data?.title ??
                "Can browse, use tools, and create project work"}
            </p>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {threadId ? (
          <DirectBotChat
            agentId={agentId}
            key={agentId}
            stopped={stopped}
            threadId={threadId}
          />
        ) : null}
      </div>
    </div>
  );
}
