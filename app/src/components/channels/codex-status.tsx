import { IconChartBar } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  capabilitiesQueryOptions,
  codexAccountQueryOptions,
  codexPreferencesQueryOptions,
  codexUsageQueryOptions,
} from "@/lib/codex/queries";

/** Compact, truthful runtime context for built-in coworkers backed by a connected Codex account. */
export function CodexChannelStatus({ enabled }: { enabled: boolean }) {
  const capabilities = useQuery(capabilitiesQueryOptions());
  const codexEnabled = enabled && capabilities.data?.codex === true;
  const account = useQuery(codexAccountQueryOptions(codexEnabled));
  const connected = account.data?.connected === true;
  const preferences = useQuery(codexPreferencesQueryOptions(connected));
  const usage = useQuery(codexUsageQueryOptions(connected));

  if (!connected) return null;
  const selected = preferences.data?.preferences;
  const model = selected?.model ?? "Default model";
  const effort = selected?.effort ? ` · ${selected.effort}` : "";
  const tokens = usage.data?.summary?.lifetimeTokens;
  return (
    <Button
      className="hidden max-w-56 text-muted-foreground lg:inline-flex"
      render={(props) => <Link {...props} to="/settings" />}
      size="xs"
      title="Codex model and lifetime subscription usage. Per-turn dollar cost is not reported by ChatGPT."
      variant="ghost"
    >
      <IconChartBar />
      <span className="truncate">
        {model}
        {effort}
        {tokens ? ` · ${tokens.toLocaleString()} tokens` : ""}
      </span>
    </Button>
  );
}
