import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconArrowBackUp,
  IconBrain,
  IconCheck,
  IconDatabase,
  IconPlugConnected,
  IconPlus,
  IconRoute,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  autonomyKeys,
  autonomyOverviewQueryOptions,
  autonomyRequest,
  type ExternalConnection,
  type MemorySuggestion,
  type ModelAttempt,
  type ModelRoute,
  type SkillProposal,
  type ToolResultSummary,
} from "@/lib/autonomy/queries";
import type { AgentChannel } from "@/lib/channels/queries";
import type { TaskRun } from "@/lib/runs/queries";
import { type Routine, workKeys, workRequest } from "@/lib/work/queries";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

type AutonomySection = "monitors" | "channels" | "learning" | "routing";
type AutonomyAction = ReturnType<typeof useAutonomyAction>;

export function AutonomyView({
  agents,
  channels,
  routines,
  runs,
}: {
  agents: AgentProfile[];
  channels: AgentChannel[];
  routines: Routine[];
  runs: TaskRun[];
}) {
  const overview = useQuery(autonomyOverviewQueryOptions());
  const action = useAutonomyAction();
  const [section, setSection] = useState<AutonomySection>("monitors");
  const data = overview.data;
  const monitors = routines.filter((routine) => routine.mode === "monitor");
  const pendingLearning =
    (data?.proposals.filter((proposal) =>
      ["pending", "quarantined", "stale"].includes(proposal.status),
    ).length ?? 0) +
    (data?.suggestions.filter((suggestion) => suggestion.status === "pending")
      .length ?? 0);

  return (
    <div className="mt-8">
      <div className="rounded-2xl border border-border bg-gradient-to-br from-card to-muted/40 p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Governed autonomy
            </p>
            <h2 className="mt-2 text-xl font-semibold">
              Always available, never invisible
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Proactive checks, external chat bridges, learned procedures,
              memory review, and model fallbacks all reuse OpenBot&apos;s
              identity, policy, approvals, audit, and durable task queue.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <MiniMetric label="Monitors" value={monitors.length} />
            <MiniMetric label="Bridges" value={data?.connections.length ?? 0} />
            <MiniMetric label="Review" value={pendingLearning} />
          </div>
        </div>
      </div>

      <nav
        aria-label="Autonomy sections"
        className="mt-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-muted/40 p-1"
      >
        {(
          [
            ["monitors", "Monitors", IconActivityHeartbeat],
            ["channels", "Channels", IconPlugConnected],
            ["learning", "Learning", IconBrain],
            ["routing", "Routing & context", IconRoute],
          ] as const
        ).map(([value, label, Icon]) => (
          <Button
            className="shrink-0"
            key={value}
            onClick={() => setSection(value)}
            size="sm"
            variant={section === value ? "secondary" : "ghost"}
          >
            <Icon /> {label}
          </Button>
        ))}
      </nav>

      {action.problem ? (
        <p
          className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {action.problem}
        </p>
      ) : null}
      {overview.isPending ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Loading autonomy workspace…
        </p>
      ) : overview.error || !data ? (
        <p className="mt-8 text-sm text-destructive" role="alert">
          The autonomy workspace could not be loaded.
        </p>
      ) : section === "monitors" ? (
        <MonitorsSection
          action={action}
          agents={agents}
          channels={channels}
          monitors={monitors}
        />
      ) : section === "channels" ? (
        <ChannelsSection
          action={action}
          agents={agents}
          channels={channels}
          connections={data.connections}
          identities={data.identities}
          messages={data.messages}
        />
      ) : section === "learning" ? (
        <LearningSection
          action={action}
          agents={agents}
          proposals={data.proposals}
          runs={runs}
          suggestions={data.suggestions}
        />
      ) : (
        <RoutingSection
          action={action}
          agents={agents}
          attempts={data.modelAttempts}
          routes={data.modelRoutes}
          toolResults={data.toolResults}
        />
      )}
    </div>
  );
}

function useAutonomyAction() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (job: () => Promise<unknown>) => job(),
    onSuccess: () => {
      setProblem(null);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: autonomyKeys.all }),
        queryClient.invalidateQueries({ queryKey: workKeys.all }),
      ]);
    },
    onError: (error) =>
      setProblem(error instanceof Error ? error.message : "That did not work."),
  });
  return { ...mutation, problem };
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-20 rounded-xl border border-border bg-background/70 px-3 py-3">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function MonitorsSection({
  action,
  agents,
  channels,
  monitors,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
  channels: AgentChannel[];
  monitors: Routine[];
}) {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  return (
    <section className="mt-7">
      <SectionHeader
        action={
          <CreateMonitorDialog
            action={action}
            agents={agents}
            channels={channels}
          />
        }
        description="A monitor wakes on schedule, checks one condition, and stays silent when its exact quiet token is returned."
        title="Proactive monitors"
      />
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {monitors.length ? (
          monitors.map((monitor) => (
            <article
              className="rounded-xl border border-border bg-card p-5"
              key={monitor.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill value={monitor.status} />
                    <span className="text-xs text-muted-foreground">
                      {agentNames.get(monitor.agentId) ?? "Coworker"}
                    </span>
                  </div>
                  <h3 className="mt-2 font-medium">{monitor.name}</h3>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {monitor.instruction}
                  </p>
                </div>
                <IconActivityHeartbeat className="size-5 shrink-0 text-muted-foreground" />
              </div>
              <div className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                {monitor.scheduleLabel ?? "Manual"} · quiet:{" "}
                {monitor.quietToken}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(() =>
                      workRequest(`/routines/${monitor.id}/run`, {
                        method: "POST",
                      }),
                    )
                  }
                  size="sm"
                >
                  Run now
                </Button>
                <Button
                  disabled={action.isPending || monitor.status === "archived"}
                  onClick={() =>
                    action.mutate(() =>
                      workRequest(`/routines/${monitor.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          status:
                            monitor.status === "active" ? "paused" : "active",
                        }),
                      }),
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  {monitor.status === "active" ? "Pause" : "Resume"}
                </Button>
              </div>
            </article>
          ))
        ) : (
          <EmptyCard>
            No monitors yet. Start with one narrow signal that is genuinely
            worth interrupting you for.
          </EmptyCard>
        )}
      </div>
    </section>
  );
}

function CreateMonitorDialog({
  action,
  agents,
  channels,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
  channels: AgentChannel[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [interval, setIntervalValue] = useState("30");
  const [quietToken, setQuietToken] = useState("NO_ACTION");
  const [activeHours, setActiveHours] = useState(true);
  const [activeStart, setActiveStart] = useState("08:00");
  const [activeEnd, setActiveEnd] = useState("18:00");

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const submit = async () => {
    const channel = await channelForAgent(agentId, channels);
    return workRequest("/routines", {
      method: "POST",
      body: JSON.stringify({
        name,
        instruction,
        agentId,
        channelId: channel.id,
        mode: "monitor",
        quietToken,
        trigger: "schedule",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        schedule: {
          kind: "every_minutes",
          interval: Number(interval),
          ...(activeHours
            ? { activeHours: { start: activeStart, end: activeEnd } }
            : {}),
        },
      }),
    });
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> New monitor
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New proactive monitor</DialogTitle>
          <DialogDescription>
            Define the signal, cadence, and silence contract. Tool permissions
            and approvals remain unchanged.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="overflow-y-auto">
          <FormField label="Name">
            <Input
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </FormField>
          <FormField label="Coworker">
            <NativeSelect onChange={setAgentId} value={agentId}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} — {agent.title}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="What to check">
            <Textarea
              className="min-h-32"
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Check the support queue for a new urgent ticket. Report the title, owner, and recommended next step."
              value={instruction}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Every (minutes)">
              <Input
                min={5}
                max={10080}
                onChange={(event) => setIntervalValue(event.target.value)}
                type="number"
                value={interval}
              />
            </FormField>
            <FormField label="Quiet token">
              <Input
                onChange={(event) => setQuietToken(event.target.value)}
                value={quietToken}
              />
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={activeHours}
              onChange={(event) => setActiveHours(event.target.checked)}
              type="checkbox"
            />
            Run only during active hours
          </label>
          {activeHours ? (
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Start">
                <Input
                  onChange={(event) => setActiveStart(event.target.value)}
                  type="time"
                  value={activeStart}
                />
              </FormField>
              <FormField label="End">
                <Input
                  onChange={(event) => setActiveEnd(event.target.value)}
                  type="time"
                  value={activeEnd}
                />
              </FormField>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              action.isPending ||
              !name.trim() ||
              !instruction.trim() ||
              !agentId ||
              !quietToken.trim() ||
              Number(interval) < 5
            }
            onClick={() =>
              action.mutate(submit, { onSuccess: () => setOpen(false) })
            }
          >
            Create monitor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelsSection({
  action,
  agents,
  channels,
  connections,
  identities,
  messages,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
  channels: AgentChannel[];
  connections: ExternalConnection[];
  identities: Array<{
    id: string;
    connectionId: string;
    externalUserId: string;
    externalConversationId: string | null;
    label: string;
  }>;
  messages: Array<{
    id: string;
    connectionId: string;
    direction: string;
    status: string;
    attempt: number;
    lastError: string | null;
  }>;
}) {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  return (
    <section className="mt-7">
      <SectionHeader
        action={
          <CreateBridgeDialog
            action={action}
            agents={agents}
            channels={channels}
          />
        }
        description="Every provider event is signature-checked, deduplicated, identity-paired, queued as a normal task, and answered through a retrying outbox."
        title="External chat bridges"
      />
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {connections.length ? (
          connections.map((connection) => {
            const paired = identities.filter(
              (identity) => identity.connectionId === connection.id,
            );
            const recent = messages.filter(
              (message) => message.connectionId === connection.id,
            );
            const failed = recent.filter(
              (message) => message.status === "failed",
            ).length;
            return (
              <article
                className="rounded-xl border border-border bg-card p-5"
                key={connection.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill value={connection.status} />
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
                        {connection.kind}
                      </span>
                    </div>
                    <h3 className="mt-2 font-medium">{connection.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {agentNames.get(connection.agentId) ?? "Coworker"} ·{" "}
                      {paired.length} paired{" "}
                      {paired.length === 1 ? "identity" : "identities"}
                    </p>
                  </div>
                  <IconPlugConnected className="size-5 text-muted-foreground" />
                </div>
                {connection.lastError ? (
                  <p className="mt-3 rounded-lg bg-destructive/5 p-2 text-xs text-destructive">
                    {connection.lastError}
                  </p>
                ) : null}
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                  <span>{recent.length} recent</span>
                  <span>{failed} failed</span>
                  <span>
                    {connection.credentialId
                      ? "Credential set"
                      : "No credential"}
                  </span>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate(() =>
                        autonomyRequest(`/connections/${connection.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            status:
                              connection.status === "active"
                                ? "paused"
                                : "active",
                          }),
                        }),
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    {connection.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <PairIdentityDialog action={action} connection={connection} />
                </div>
              </article>
            );
          })
        ) : (
          <EmptyCard>
            No external channel is connected. Generic signed webhooks need no
            provider credential; Telegram, Slack, and Discord use the existing
            credential vault.
          </EmptyCard>
        )}
      </div>
    </section>
  );
}

function CreateBridgeDialog({
  action,
  agents,
  channels,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
  channels: AgentChannel[];
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExternalConnection["kind"]>("telegram");
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [credentialId, setCredentialId] = useState("");
  const [outboundUrl, setOutboundUrl] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [externalUserId, setExternalUserId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [setup, setSetup] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const submit = async () => {
    const channel = await channelForAgent(agentId, channels);
    const created = await autonomyRequest<{
      connection: ExternalConnection;
      inboundSecret: string;
    }>("/connections", {
      method: "POST",
      body: JSON.stringify({
        kind,
        name,
        agentId,
        channelId: channel.id,
        ...(credentialId.trim() ? { credentialId: credentialId.trim() } : {}),
        config: {
          ...(kind === "webhook" && outboundUrl.trim()
            ? { outboundUrl: outboundUrl.trim() }
            : {}),
          ...(kind === "discord" && publicKey.trim()
            ? { publicKey: publicKey.trim() }
            : {}),
        },
      }),
    });
    if (externalUserId.trim()) {
      await autonomyRequest(
        `/connections/${created.connection.id}/identities`,
        {
          method: "POST",
          body: JSON.stringify({
            externalUserId,
            ...(conversationId.trim()
              ? { externalConversationId: conversationId }
              : {}),
            label: "Initial pairing",
          }),
        },
      );
    }
    setSetup(
      [
        `Webhook: ${window.location.origin}/api/hooks/channels/${created.connection.id}`,
        `Inbound secret: ${created.inboundSecret}`,
        kind === "telegram"
          ? "Set the secret as Telegram's secret_token header."
          : kind === "slack"
            ? "Slack verifies with signingSecret from the JSON vault credential."
            : kind === "discord"
              ? "Discord verifies against the application public key."
              : "Send the secret as Authorization: Bearer <secret>.",
      ].join("\n"),
    );
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> New bridge
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect an external chat</DialogTitle>
          <DialogDescription>
            Provider secrets stay in Admin → Credentials. This bridge stores
            only the credential ID and a hash of its inbound secret.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="overflow-y-auto">
          {setup ? (
            <div>
              <Label>Setup details — shown once</Label>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                {setup}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                Store the inbound secret in the provider or your secret manager.
                OpenBot cannot show it again.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Provider">
                  <NativeSelect
                    onChange={(value) =>
                      setKind(value as ExternalConnection["kind"])
                    }
                    value={kind}
                  >
                    <option value="telegram">Telegram</option>
                    <option value="slack">Slack</option>
                    <option value="discord">Discord</option>
                    <option value="webhook">Signed webhook</option>
                  </NativeSelect>
                </FormField>
                <FormField label="Name">
                  <Input
                    onChange={(event) => setName(event.target.value)}
                    value={name}
                  />
                </FormField>
              </div>
              <FormField label="Coworker">
                <NativeSelect onChange={setAgentId} value={agentId}>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} — {agent.title}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Vault credential ID (provider bot token)">
                <Input
                  onChange={(event) => setCredentialId(event.target.value)}
                  placeholder={
                    kind === "webhook"
                      ? "Optional outbound bearer credential"
                      : "UUID from Admin → Credentials"
                  }
                  value={credentialId}
                />
              </FormField>
              {kind === "webhook" ? (
                <FormField label="Outbound HTTPS URL">
                  <Input
                    onChange={(event) => setOutboundUrl(event.target.value)}
                    placeholder="https://example.com/openbot-replies"
                    value={outboundUrl}
                  />
                </FormField>
              ) : null}
              {kind === "discord" ? (
                <FormField label="Discord application public key">
                  <Input
                    onChange={(event) => setPublicKey(event.target.value)}
                    value={publicKey}
                  />
                </FormField>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="External user ID to pair">
                  <Input
                    onChange={(event) => setExternalUserId(event.target.value)}
                    placeholder="Required before messages are accepted"
                    value={externalUserId}
                  />
                </FormField>
                <FormField label="Conversation ID (optional lock)">
                  <Input
                    onChange={(event) => setConversationId(event.target.value)}
                    value={conversationId}
                  />
                </FormField>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {setup ? (
            <Button
              onClick={() => {
                setOpen(false);
                setSetup(null);
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)} variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={
                  action.isPending ||
                  !name.trim() ||
                  !agentId ||
                  (kind !== "webhook" && !credentialId.trim()) ||
                  (kind === "discord" && !publicKey.trim())
                }
                onClick={() => action.mutate(submit)}
              >
                Create bridge
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PairIdentityDialog({
  action,
  connection,
}: {
  action: AutonomyAction;
  connection: ExternalConnection;
}) {
  const [open, setOpen] = useState(false);
  const [externalUserId, setExternalUserId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [label, setLabel] = useState("");
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="ghost" />}>
        Pair identity
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair an external identity</DialogTitle>
          <DialogDescription>
            Unpaired senders are rejected even when the provider signature is
            valid.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FormField label="External user ID">
            <Input
              onChange={(event) => setExternalUserId(event.target.value)}
              value={externalUserId}
            />
          </FormField>
          <FormField label="Conversation ID (optional)">
            <Input
              onChange={(event) => setConversationId(event.target.value)}
              value={conversationId}
            />
          </FormField>
          <FormField label="Label">
            <Input
              onChange={(event) => setLabel(event.target.value)}
              value={label}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={action.isPending || !externalUserId.trim()}
            onClick={() =>
              action.mutate(
                () =>
                  autonomyRequest(`/connections/${connection.id}/identities`, {
                    method: "POST",
                    body: JSON.stringify({
                      externalUserId,
                      ...(conversationId.trim()
                        ? { externalConversationId: conversationId }
                        : {}),
                      label,
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Pair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LearningSection({
  action,
  agents,
  proposals,
  runs,
  suggestions,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
  proposals: SkillProposal[];
  runs: TaskRun[];
  suggestions: MemorySuggestion[];
}) {
  const completedRuns = runs.filter(
    (run) => run.status === "succeeded" && run.output,
  );
  return (
    <section className="mt-7 space-y-8">
      <div>
        <SectionHeader
          action={<NewSkillProposalDialog action={action} />}
          description="Learning creates a diff-like proposal. Applying checks both the proposal hash and the installed skill's base hash; risky instructions are quarantined."
          title="Skill workshop"
        />
        <div className="mt-4 space-y-3">
          {proposals.length ? (
            proposals.map((proposal) => (
              <article
                className="rounded-xl border border-border bg-card p-5"
                key={proposal.id}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill value={proposal.status} />
                      <span className="text-xs text-muted-foreground">
                        {proposal.operation} /{proposal.slug}
                      </span>
                    </div>
                    <h3 className="mt-2 font-medium">{proposal.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {proposal.summary}
                    </p>
                    <pre className="mt-3 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-sans text-xs">
                      {proposal.instructions}
                    </pre>
                    {proposal.scan.findings?.length ? (
                      <p className="mt-2 flex items-center gap-1 text-xs text-amber-600">
                        <IconAlertTriangle className="size-4" />
                        {proposal.scan.findings
                          .map((finding) => finding.id)
                          .join(", ")}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {proposal.status === "pending" ? (
                      <>
                        <Button
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate(() =>
                              autonomyRequest(
                                `/learning/skills/${proposal.id}/apply`,
                                {
                                  method: "POST",
                                },
                              ),
                            )
                          }
                          size="sm"
                        >
                          <IconCheck /> Apply
                        </Button>
                        <Button
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate(() =>
                              autonomyRequest(
                                `/learning/skills/${proposal.id}/reject`,
                                {
                                  method: "POST",
                                },
                              ),
                            )
                          }
                          size="sm"
                          variant="ghost"
                        >
                          <IconX /> Reject
                        </Button>
                      </>
                    ) : proposal.status === "applied" ? (
                      <Button
                        disabled={action.isPending}
                        onClick={() =>
                          action.mutate(() =>
                            autonomyRequest(
                              `/learning/skills/${proposal.id}/rollback`,
                              {
                                method: "POST",
                              },
                            ),
                          )
                        }
                        size="sm"
                        variant="outline"
                      >
                        <IconArrowBackUp /> Roll back
                      </Button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))
          ) : (
            <EmptyCard>No skill proposals yet.</EmptyCard>
          )}
        </div>
        {completedRuns.length ? (
          <div className="mt-4 rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm font-medium">Learn from a completed run</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {completedRuns.slice(0, 5).map((run) => (
                <Button
                  disabled={action.isPending}
                  key={run.id}
                  onClick={() =>
                    action.mutate(() =>
                      autonomyRequest(`/learning/runs/${run.id}/skill`, {
                        method: "POST",
                        body: JSON.stringify({}),
                      }),
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  Learn “{run.title}”
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div>
        <SectionHeader
          action={<NewMemorySuggestionDialog action={action} agents={agents} />}
          description="Potential long-term memory stays outside the active memory prompt until you promote it."
          title="Memory review inbox"
        />
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {suggestions.length ? (
            suggestions.map((suggestion) => (
              <article
                className="rounded-xl border border-border bg-card p-5"
                key={suggestion.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill value={suggestion.status} />
                  <span className="text-xs text-muted-foreground">
                    {suggestion.kind} · {suggestion.confidence}% confidence
                  </span>
                </div>
                <h3 className="mt-2 font-medium">{suggestion.title}</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {suggestion.content}
                </p>
                {suggestion.status === "pending" ? (
                  <div className="mt-4 flex gap-2">
                    <Button
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(() =>
                          autonomyRequest(
                            `/learning/memory/${suggestion.id}/promote`,
                            {
                              method: "POST",
                            },
                          ),
                        )
                      }
                      size="sm"
                    >
                      Promote
                    </Button>
                    <Button
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(() =>
                          autonomyRequest(
                            `/learning/memory/${suggestion.id}/reject`,
                            {
                              method: "POST",
                            },
                          ),
                        )
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Reject
                    </Button>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <EmptyCard>No memory suggestions are waiting.</EmptyCard>
          )}
        </div>
      </div>
    </section>
  );
}

function NewSkillProposalDialog({ action }: { action: AutonomyAction }) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [instructions, setInstructions] = useState("");
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> New proposal
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Propose a learned skill</DialogTitle>
          <DialogDescription>
            Saving creates a review item; it does not change any coworker.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="overflow-y-auto">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Slash command">
              <Input
                onChange={(event) => setSlug(event.target.value)}
                placeholder="weekly-brief"
                value={slug}
              />
            </FormField>
            <FormField label="Title">
              <Input
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </FormField>
          </div>
          <FormField label="Summary">
            <Input
              onChange={(event) => setSummary(event.target.value)}
              value={summary}
            />
          </FormField>
          <FormField label="Reusable instructions">
            <Textarea
              className="min-h-44"
              onChange={(event) => setInstructions(event.target.value)}
              value={instructions}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              action.isPending ||
              !slug.trim() ||
              !title.trim() ||
              !instructions.trim()
            }
            onClick={() =>
              action.mutate(
                () =>
                  autonomyRequest("/learning/skills", {
                    method: "POST",
                    body: JSON.stringify({
                      slug,
                      title,
                      summary,
                      instructions,
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Create proposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewMemorySuggestionDialog({
  action,
  agents,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"user" | "agent">("user");
  const [kind, setKind] = useState("preference");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <IconPlus /> Suggest memory
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suggest long-term memory</DialogTitle>
          <DialogDescription>
            The suggestion remains inactive until it is promoted.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Scope">
              <NativeSelect
                onChange={(value) => setScope(value as typeof scope)}
                value={scope}
              >
                <option value="user">You</option>
                <option value="agent">Coworker</option>
              </NativeSelect>
            </FormField>
            <FormField label="Kind">
              <NativeSelect onChange={setKind} value={kind}>
                <option value="preference">Preference</option>
                <option value="fact">Fact</option>
                <option value="instruction">Instruction</option>
                <option value="decision">Decision</option>
              </NativeSelect>
            </FormField>
          </div>
          {scope === "agent" ? (
            <FormField label="Coworker">
              <NativeSelect onChange={setAgentId} value={agentId}>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          ) : null}
          <FormField label="Title">
            <Input
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </FormField>
          <FormField label="Memory">
            <Textarea
              className="min-h-32"
              onChange={(event) => setContent(event.target.value)}
              value={content}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              action.isPending ||
              !title.trim() ||
              !content.trim() ||
              (scope === "agent" && !agentId)
            }
            onClick={() =>
              action.mutate(
                () =>
                  autonomyRequest("/learning/memory", {
                    method: "POST",
                    body: JSON.stringify({
                      scope,
                      kind,
                      ...(scope === "agent" ? { agentId } : {}),
                      title,
                      content,
                      confidence: 70,
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Add to review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoutingSection({
  action,
  agents,
  attempts,
  routes,
  toolResults,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
  attempts: ModelAttempt[];
  routes: ModelRoute[];
  toolResults: ToolResultSummary[];
}) {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  return (
    <section className="mt-7 space-y-8">
      <div>
        <SectionHeader
          action={<NewModelRouteDialog action={action} agents={agents} />}
          description="Unattended work may try the next model only for selected transient failures. Authentication, context limits, and unknown failures stop by default."
          title="Model fallback routes"
        />
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {routes.length ? (
            routes.map((route) => (
              <article
                className="rounded-xl border border-border bg-card p-5"
                key={route.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <StatusPill value={route.status} />
                      <span className="text-xs text-muted-foreground">
                        {route.agentId
                          ? (agentNames.get(route.agentId) ?? "Coworker")
                          : "Default"}
                      </span>
                    </div>
                    <h3 className="mt-2 font-medium">{route.name}</h3>
                  </div>
                  <IconRoute className="size-5 text-muted-foreground" />
                </div>
                <ol className="mt-4 space-y-2">
                  {route.candidates.map((candidate, index) => (
                    <li
                      className="flex gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm"
                      key={`${candidate.provider}/${candidate.model}`}
                    >
                      <span className="text-muted-foreground">{index + 1}</span>
                      <span>
                        {candidate.provider} / {candidate.model}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-muted-foreground">
                  Fallback on: {route.retryableCodes.join(", ")}
                </p>
                <Button
                  className="mt-4"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(() =>
                      autonomyRequest(`/model-routes/${route.id}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                  size="sm"
                  variant="ghost"
                >
                  Delete route
                </Button>
              </article>
            ))
          ) : (
            <EmptyCard>
              No fallback route is configured. The deployment model runs once.
            </EmptyCard>
          )}
        </div>
        {attempts.length ? (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Outcome</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-4 py-3 font-medium">Run</th>
                </tr>
              </thead>
              <tbody>
                {attempts.slice(0, 12).map((attempt) => (
                  <tr className="border-t border-border" key={attempt.id}>
                    <td className="px-4 py-3">
                      {attempt.provider} / {attempt.model}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill value={attempt.outcome} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {attempt.errorCode ?? "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {attempt.taskRunId.slice(0, 8)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div>
        <SectionHeader
          description="When a granted tool set grows, the model sees search, describe, and call instead of every schema. Results over the prompt limit keep a full, owner-scoped artifact for 30 days."
          title="Context hygiene"
        />
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {toolResults.length ? (
            toolResults.map((result) => (
              <article
                className="rounded-xl border border-border bg-card p-5"
                key={result.id}
              >
                <div className="flex items-center gap-2">
                  <IconDatabase className="size-4 text-muted-foreground" />
                  <h3 className="font-medium">{result.toolName}</h3>
                </div>
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                  {result.preview}
                </p>
                <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <code>{result.contentHash.slice(0, 12)}</code>
                  <a
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                    href={`/api/autonomy/tool-results/${result.id}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open full result
                  </a>
                </div>
              </article>
            ))
          ) : (
            <EmptyCard>
              No tool result has exceeded the prompt context limit.
            </EmptyCard>
          )}
        </div>
      </div>
    </section>
  );
}

function NewModelRouteDialog({
  action,
  agents,
}: {
  action: AutonomyAction;
  agents: AgentProfile[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Background fallback");
  const [agentId, setAgentId] = useState("");
  const [provider, setProvider] = useState("openai");
  const [models, setModels] = useState("");
  const candidates = models
    .split("\n")
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => ({ provider: provider.trim(), model }));
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> New route
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New model fallback route</DialogTitle>
          <DialogDescription>
            Candidates must use the deployment&apos;s current provider;
            credentials never move into this route.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FormField label="Name">
            <Input
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </FormField>
          <FormField label="Coworker">
            <NativeSelect onChange={setAgentId} value={agentId}>
              <option value="">Default for unattended work</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Provider">
            <Input
              onChange={(event) => setProvider(event.target.value)}
              value={provider}
            />
          </FormField>
          <FormField label="Models, first choice then fallbacks (one per line)">
            <Textarea
              className="min-h-32 font-mono"
              onChange={(event) => setModels(event.target.value)}
              placeholder={"gpt-5.4\ngpt-5.3-codex"}
              value={models}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              action.isPending ||
              !name.trim() ||
              !provider.trim() ||
              candidates.length === 0 ||
              candidates.length > 4
            }
            onClick={() =>
              action.mutate(
                () =>
                  autonomyRequest("/model-routes", {
                    method: "POST",
                    body: JSON.stringify({
                      name,
                      ...(agentId ? { agentId } : {}),
                      candidates,
                      retryableCodes: ["rate_limit", "timeout", "unavailable"],
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Save route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeader({
  action,
  description,
  title,
}: {
  action?: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-3xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function NativeSelect({
  children,
  onChange,
  value,
}: {
  children: React.ReactNode;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
  );
}

function StatusPill({ value }: { value: string }) {
  const warning = ["failed", "quarantined", "stale"].includes(value);
  const success = [
    "active",
    "applied",
    "promoted",
    "succeeded",
    "delivered",
  ].includes(value);
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs capitalize ${
        warning
          ? "bg-destructive/10 text-destructive"
          : success
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "bg-muted text-muted-foreground"
      }`}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground lg:col-span-2">
      {children}
    </div>
  );
}

async function channelForAgent(agentId: string, channels: AgentChannel[]) {
  const existing = channels.find(
    (channel) =>
      channel.agentIds.length === 1 && channel.agentIds[0] === agentId,
  );
  if (existing) return existing;
  const response = await fetch("/api/channels", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentIds: [agentId] }),
  });
  const body = (await response.json().catch(() => null)) as {
    channel?: AgentChannel;
    error?: string;
  } | null;
  if (!response.ok || !body?.channel) {
    throw new Error(body?.error ?? "A coworker channel could not be created.");
  }
  return body.channel;
}
