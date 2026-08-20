import {
  IconDeviceDesktop,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { CodexChannelStatus } from "@/components/channels/codex-status";
import { DeploymentPreviewChat } from "@/components/channels/deployment-preview-chat";
import { ComputerView } from "@/components/computer/computer-view";
import { useNeedsYou } from "@/components/computer/needs-you";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { deploymentPreviewEnabled } from "@/lib/deployment-preview";

const chatSearchSchema = z.object({
  /** Selects which coworker answers in a shared team channel. */
  agent: z.string().optional(),
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
  /** Opens transcript search without replacing the screen/settings detail pane. */
  find: z.boolean().optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** Shared detail pane width for the live screen view. */
const SCREEN_PANEL_WIDTH = 520;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  return (
    <div className="px-4 mt-4">
      <div className="p-4">
        <ComputerView active computerId={agentId} />
        <span className="flex items-center justify-center w-full text-center text-muted-foreground mt-4 text-sm">
          {name || "Agent"}'s screen
        </span>
      </div>
    </div>
  );
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { agent, settings, watch, find } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const profiles = useQuery(agentListQueryOptions());
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  const isSearching = find === true;
  const agentId = channel.data?.agentIds.includes(agent ?? "")
    ? agent
    : channel.data?.agentIds[0];
  const agentProfile = profiles.data?.find((profile) => profile.id === agentId);
  const agentName = agentProfile?.name;
  const warmedBot = useRef<string | null>(null);
  const prewarmComputer = () => {
    if (!agentId || deploymentPreviewEnabled || warmedBot.current === agentId)
      return;
    warmedBot.current = agentId;
    void fetch(`/api/computers/${encodeURIComponent(agentId)}/warm`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {
      warmedBot.current = null;
    });
  };
  /** Needs-you state is rendered by the screen when the screen is already open. */
  const needsYou = useNeedsYou(
    agentId,
    !deploymentPreviewEnabled && !isWatching,
  );

  // Needs-you prompts auto-open the screen because the actionable prompt is rendered there.
  useEffect(() => {
    if (!needsYou) return;
    show("watch");
  });

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);
  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      navigate({
        search: (previous) =>
          previous.watch === true || previous.settings === true
            ? previous
            : { ...previous, settings: undefined, watch: true },
      });
    });
  }, [agentId, navigate]);

  // Settings and watch share one pane; opening either clears the other URL flag.
  const show = (next: "settings" | "watch" | null) => {
    // Dismissal applies only to the current browser-activity run.
    if (next !== "watch" && isWatching)
      dismissedEpoch.current = runEpoch.current;
    return navigate({
      search: (previous) => ({
        ...previous,
        settings: next === "settings" ? true : undefined,
        watch: next === "watch" ? true : undefined,
      }),
    });
  };

  const showSearch = (open: boolean) =>
    navigate({
      search: (previous) => ({
        ...previous,
        find: open ? true : undefined,
      }),
    });

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      resizable={isWatching}
      minDetailWidth={360}
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel agentId={agentId} name={agentName} />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        <div className="h-12 border-b border-border sticky top-0 flex flex-row items-center justify-between px-3 gap-2">
          {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <motion.div
              animate={{ opacity: 1 }}
              className="shrink-0"
              initial={{ opacity: 0 }}
              key={`avatar:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              <ChannelAvatar
                participantIds={channel.data?.agentIds ?? []}
                size={22}
              />
            </motion.div>
            <motion.span
              animate={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px)" }
              }
              className="min-w-0 text-sm tracking-tight truncate"
              initial={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, transform: HEADING_ENTRANCE_OFFSET }
              }
              key={`name:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              {channel.data?.name ?? "Channel"}
            </motion.span>
          </div>
          <div className="flex flex-row gap-1.5">
            <CodexChannelStatus
              enabled={
                agentProfile?.systemOwned === true &&
                agentProfile.endpoint === null
              }
            />
            {(channel.data?.agentIds.length ?? 0) > 1 ? (
              <Select
                onValueChange={(next) =>
                  void navigate({
                    replace: true,
                    search: (previous) => ({
                      ...previous,
                      agent: next ?? undefined,
                    }),
                  })
                }
                value={agentId}
              >
                <SelectTrigger
                  aria-label="Speaking coworker"
                  className="max-w-40"
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {channel.data?.agentIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {profiles.data?.find((profile) => profile.id === id)
                        ?.name ?? "Coworker"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              aria-label="Search this conversation"
              aria-pressed={isSearching}
              className={isSearching ? "bg-foreground/5" : undefined}
              disabled={deploymentPreviewEnabled}
              onClick={() => void showSearch(!isSearching)}
              size="icon"
              variant="ghost"
            >
              <IconSearch className="size-4.5" />
            </Button>
            <Button
              aria-label={
                deploymentPreviewEnabled
                  ? "Screen unavailable in UI preview"
                  : needsYou
                    ? "This Bot is waiting for you. Open its screen"
                    : "Watch this Bot's screen"
              }
              aria-pressed={isWatching}
              className={`relative ${isWatching ? "bg-foreground/5" : ""}`}
              disabled={deploymentPreviewEnabled || agentId === undefined}
              onClick={() => show(isWatching ? null : "watch")}
              onFocus={prewarmComputer}
              onPointerEnter={prewarmComputer}
              variant="ghost"
              size="icon"
            >
              <IconDeviceDesktop className="size-4.5" />
              {/* Mirrors needs-you state outside the hidden screen pane. */}
              {needsYou ? (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-amber-500" />
              ) : null}
            </Button>
            <Button
              aria-label="Channel coworker"
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </div>
        </div>
      </div>
      <ChannelBody
        agentId={agentId}
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
        searchOpen={isSearching}
        onCloseSearch={() => void showSearch(false)}
      />
    </DetailPanel>
  );
}

function ChannelBody({
  agentId,
  channel,
  isPending,
  hasError,
  searchOpen,
  onCloseSearch,
}: {
  agentId: string | undefined;
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
  searchOpen: boolean;
  onCloseSearch: () => void;
}) {
  if (isPending) {
    return (
      <p className="p-8 text-sm text-muted-foreground">Loading channel…</p>
    );
  }
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Could not load this channel.
      </p>
    );
  }

  const runtimeAgentId = agentId;
  if (!runtimeAgentId) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This channel does not have an available coworker.
      </p>
    );
  }

  if (deploymentPreviewEnabled) {
    return <DeploymentPreviewChat channel={channel} />;
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      onCloseSearch={onCloseSearch}
      runtimeAgentId={runtimeAgentId}
      searchOpen={searchOpen}
    />
  );
}
