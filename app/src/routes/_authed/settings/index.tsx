import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  cancelCodexLogin,
  capabilitiesQueryOptions,
  codexAccountQueryOptions,
  codexKeys,
  codexLimitsQueryOptions,
  codexModelsQueryOptions,
  codexPreferencesQueryOptions,
  codexUsageQueryOptions,
  disconnectCodexAccount,
  startCodexDeviceLogin,
  updateCodexPreferences,
  type CodexPreferences,
  type CodexDeviceLogin,
  type RateLimitWindow,
} from "@/lib/codex/queries";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();
  const queryClient = useQueryClient();
  const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const capabilities = useQuery(capabilitiesQueryOptions());
  const codexEnabled = capabilities.data?.codex === true;
  const account = useQuery(codexAccountQueryOptions(codexEnabled));
  const connected = account.data?.connected === true;
  const limits = useQuery(codexLimitsQueryOptions(connected));
  const usage = useQuery(codexUsageQueryOptions(connected));
  const models = useQuery(codexModelsQueryOptions(connected));
  const preferences = useQuery(codexPreferencesQueryOptions(connected));
  const action = useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: () => {
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: codexKeys.all });
    },
    onError: (error) =>
      setProblem(
        error instanceof Error ? error.message : "That action did not work.",
      ),
  });
  const preferenceAction = useMutation({
    mutationFn: updateCodexPreferences,
    onSuccess: (next) => {
      queryClient.setQueryData(codexKeys.preferences(), {
        preferences: next,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      });
    },
  });
  const limit =
    limits.data?.rateLimitsByLimitId?.codex ?? limits.data?.rateLimits;
  const modelChoices = modelOptions(models.data?.data ?? []);
  const selectedPreferences = preferences.data?.preferences;
  const effortLevels = preferences.data?.effortLevels ?? [];
  const savePreference = (patch: Partial<CodexPreferences>) => {
    if (!selectedPreferences) return;
    preferenceAction.mutate({ ...selectedPreferences, ...patch });
  };

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   */
  return (
    <PageShell
      description="How OpenBot looks and behaves for you. These apply to your account alone, on every deployment you sign in to."
      title="Preferences"
    >
      <PageSection title="General">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Dark theme</ItemTitle>
              <ItemDescription>
                Use the dark appearance across OpenBot.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Dark theme"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <PageSection title="ChatGPT & Codex">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>
                {connected
                  ? "ChatGPT connected"
                  : "Use your Codex subscription"}
              </ItemTitle>
              <ItemDescription>
                {connected
                  ? `${account.data?.account?.email ?? "Your ChatGPT account"}${
                      account.data?.account?.planType
                        ? ` · ${account.data.account.planType}`
                        : ""
                    }. Built-in coworkers now use this account's Codex allowance.`
                  : codexEnabled
                    ? "Connect ChatGPT with a one-time device code. OpenBot keeps its own app sign-in separate and never receives your ChatGPT password."
                    : "This deployment has not enabled the Codex App Server integration."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connected ? (
                <Button
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(async () => {
                      await disconnectCodexAccount();
                      setLogin(null);
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Disconnect
                </Button>
              ) : codexEnabled ? (
                <Button
                  disabled={action.isPending || account.isPending}
                  onClick={() =>
                    action.mutate(async () => {
                      const next = await startCodexDeviceLogin();
                      setLogin(next);
                    })
                  }
                  size="sm"
                >
                  Connect ChatGPT
                </Button>
              ) : null}
            </ItemActions>
          </Item>

          {login && !connected ? (
            <Item size="sm" variant="muted">
              <ItemContent>
                <ItemTitle>Enter code {login.userCode}</ItemTitle>
                <ItemDescription>
                  Open ChatGPT, sign in, enter this code, then return here. This
                  page checks the connection automatically.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  onClick={() =>
                    void navigator.clipboard.writeText(login.userCode)
                  }
                  size="sm"
                  variant="outline"
                >
                  Copy code
                </Button>
                <Button
                  onClick={() =>
                    window.open(
                      login.verificationUrl,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  Open ChatGPT
                </Button>
                <Button
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(async () => {
                      await cancelCodexLogin(login.loginId);
                      setLogin(null);
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </ItemActions>
            </Item>
          ) : null}

          {connected && (limit || usage.data?.summary) ? (
            <Item size="sm" variant="muted">
              <ItemContent>
                <ItemTitle>Codex allowance</ItemTitle>
                <ItemDescription>
                  {usage.data?.summary?.lifetimeTokens
                    ? `${usage.data.summary.lifetimeTokens.toLocaleString()} lifetime tokens reported. `
                    : ""}
                  Usage refreshes once a minute. ChatGPT subscriptions do not
                  report a reliable per-turn dollar cost, so Kayco does not
                  invent one.
                </ItemDescription>
                {limit ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <UsageWindow
                      label="Primary window"
                      window={limit.primary}
                    />
                    <UsageWindow
                      label="Secondary window"
                      window={limit.secondary}
                    />
                  </div>
                ) : null}
              </ItemContent>
            </Item>
          ) : null}

          {connected && selectedPreferences ? (
            <Item size="sm" variant="muted">
              <ItemContent>
                <ItemTitle>Model and reasoning</ItemTitle>
                <ItemDescription>
                  These choices apply to built-in coworkers that use your
                  connected Codex account. External AG-UI coworkers keep their
                  own runtime settings.
                </ItemDescription>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1 text-xs">
                    <span className="font-medium">Model</span>
                    <Select
                      disabled={preferenceAction.isPending}
                      onValueChange={(value) =>
                        savePreference({
                          model: value === "__default__" ? null : value,
                        })
                      }
                      value={selectedPreferences.model ?? "__default__"}
                    >
                      <SelectTrigger
                        aria-label="Codex model"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">
                          Deployment default
                        </SelectItem>
                        {modelChoices.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1 text-xs">
                    <span className="font-medium">Reasoning effort</span>
                    <Select
                      disabled={preferenceAction.isPending}
                      onValueChange={(value) =>
                        savePreference({
                          effort:
                            value === "__default__"
                              ? null
                              : (value as CodexPreferences["effort"]),
                        })
                      }
                      value={selectedPreferences.effort ?? "__default__"}
                    >
                      <SelectTrigger
                        aria-label="Codex reasoning effort"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">Default</SelectItem>
                        {effortLevels
                          .filter((level): level is NonNullable<typeof level> =>
                            Boolean(level),
                          )
                          .map((level) => (
                            <SelectItem key={level} value={level}>
                              {level === "xhigh"
                                ? "Extra high"
                                : level[0].toUpperCase() + level.slice(1)}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {preferenceAction.error ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {preferenceAction.error.message}
                  </p>
                ) : null}
              </ItemContent>
            </Item>
          ) : null}

          {problem ||
          account.isError ||
          limits.isError ||
          usage.isError ||
          models.isError ||
          preferences.isError ? (
            <p className="px-3 text-sm text-destructive" role="alert">
              {problem ??
                account.error?.message ??
                limits.error?.message ??
                usage.error?.message ??
                models.error?.message ??
                preferences.error?.message ??
                "Codex could not be loaded."}
            </p>
          ) : null}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}

function modelOptions(data: unknown[]) {
  const choices = new Map<string, string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = [record.id, record.model, record.slug].find(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim()),
    );
    if (!id) continue;
    const label = [record.displayName, record.name, record.label].find(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim()),
    );
    choices.set(id, label ?? id);
  }
  return [...choices].map(([id, label]) => ({ id, label }));
}

function UsageWindow({
  label,
  window,
}: {
  label: string;
  window?: RateLimitWindow | null;
}) {
  if (!window) return null;
  const reset = window.resetsAt
    ? new Date(window.resetsAt * 1_000).toLocaleString()
    : null;
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="flex justify-between gap-2 text-xs">
        <span>{label}</span>
        <span>{window.usedPercent}% used</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{
            width: `${Math.max(0, Math.min(window.usedPercent, 100))}%`,
          }}
        />
      </div>
      {reset ? (
        <p className="mt-1 text-xs text-muted-foreground">Resets {reset}</p>
      ) : null}
    </div>
  );
}
