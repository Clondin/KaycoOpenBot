import {
  IconArchive,
  IconBolt,
  IconBox,
  IconCheck,
  IconClock,
  IconFileDiff,
  IconHistory,
  IconPlus,
  IconSearch,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { AgentProfile } from "@/lib/agents/queries";
import type { AgentChannel } from "@/lib/channels/queries";
import {
  continuityKeys,
  continuityOverviewQueryOptions,
  continuityRequest,
  continuitySearchQueryOptions,
  type ToolProgram,
} from "@/lib/continuity/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ContinuitySection =
  | "context"
  | "history"
  | "programs"
  | "skills"
  | "bundles";

export function ContinuityView({
  agents,
  channels,
}: {
  agents: AgentProfile[];
  channels: AgentChannel[];
}) {
  const [section, setSection] = useState<ContinuitySection>("context");
  const overview = useQuery(continuityOverviewQueryOptions());
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: (job: () => Promise<unknown>) => job(),
    onSuccess: () => {
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: continuityKeys.all });
    },
    onError: (error) =>
      setProblem(error instanceof Error ? error.message : "That did not work."),
  });

  if (overview.isPending) {
    return (
      <p className="mt-8 text-sm text-muted-foreground">Loading continuity…</p>
    );
  }
  if (!overview.data) {
    return (
      <p className="mt-8 text-sm text-destructive">
        Continuity could not be loaded.
      </p>
    );
  }

  const data = overview.data;
  const sections = [
    ["context", "Context Vault", IconSearch],
    ["history", "Time Machine", IconHistory],
    ["programs", "Tool programs", IconBolt],
    ["skills", "Skill health", IconShieldCheck],
    ["bundles", "Bot bundles", IconBox],
  ] as const;

  return (
    <div className="mt-8">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Indexed messages" value={data.indexedMessageCount} />
        <Metric label="Recovery points" value={data.snapshots.length} />
        <Metric
          label="Reviewed programs"
          value={
            data.programs.filter((program) => program.status === "approved")
              .length
          }
        />
      </div>
      <nav className="mt-6 flex gap-1 overflow-x-auto rounded-xl border bg-muted/30 p-1">
        {sections.map(([value, label, Icon]) => (
          <Button
            key={value}
            onClick={() => setSection(value)}
            size="sm"
            variant={section === value ? "secondary" : "ghost"}
          >
            <Icon /> {label}
          </Button>
        ))}
      </nav>
      {problem ? (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {problem}
        </p>
      ) : null}

      {section === "context" ? (
        <ContextVault channels={channels} snapshots={data.snapshots} />
      ) : section === "history" ? (
        <TimeMachine action={action} agents={agents} />
      ) : section === "programs" ? (
        <Programs action={action} agents={agents} programs={data.programs} />
      ) : section === "skills" ? (
        <SkillHealth action={action} skills={data.skillHealth} />
      ) : (
        <Bundles action={action} bundles={data.bundles} />
      )}
    </div>
  );
}

function ContextVault({
  channels,
  snapshots,
}: {
  channels: AgentChannel[];
  snapshots: Array<{
    id: string;
    channelId: string;
    summary: string;
    sourceMessageCount: number;
    tokenEstimate: number;
    createdAt: string;
  }>;
}) {
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("");
  const results = useQuery(
    continuitySearchQueryOptions(query, channelId || undefined),
  );
  return (
    <section className="mt-7">
      <SectionTitle
        title="Context Vault"
        description="Exact owner-scoped recall across the derived transcript index. OpenBot Intelligence remains the canonical conversation."
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="relative">
          <IconSearch className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search the Context Vault"
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search decisions, errors, names…"
            value={query}
          />
        </div>
        <NativeSelect onChange={setChannelId} value={channelId}>
          <option value="">Every conversation</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="mt-4 space-y-2">
        {query.trim().length < 2 ? (
          <Empty>Type at least two characters to search.</Empty>
        ) : results.isFetching ? (
          <Empty>Searching the vault…</Empty>
        ) : results.data?.length ? (
          results.data.map((result) => (
            <article className="rounded-xl border bg-card p-4" key={result.id}>
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="capitalize">
                  {result.role} · {new Date(result.occurredAt).toLocaleString()}
                </span>
                <Button
                  render={
                    <Link
                      params={{ channelId: result.channelId }}
                      search={{ find: true }}
                      to="/channel/$channelId"
                    />
                  }
                  size="sm"
                  variant="ghost"
                >
                  Open conversation
                </Button>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm">
                {result.content}
              </p>
            </article>
          ))
        ) : (
          <Empty>No indexed messages match.</Empty>
        )}
      </div>
      <SectionTitle
        className="mt-10"
        title="Recovery snapshots"
        description="Inspectable compaction points keep summaries tied to message anchors instead of silently dropping the middle of a long context."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {snapshots.length ? (
          snapshots.map((snapshot) => (
            <article
              className="rounded-xl border bg-card p-4"
              key={snapshot.id}
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <IconClock className="size-4" />
                {new Date(snapshot.createdAt).toLocaleString()} ·{" "}
                {snapshot.sourceMessageCount} messages · ~
                {snapshot.tokenEstimate} tokens
              </div>
              <p className="mt-3 line-clamp-5 whitespace-pre-wrap text-sm">
                {snapshot.summary}
              </p>
            </article>
          ))
        ) : (
          <Empty>No recovery snapshots yet.</Empty>
        )}
      </div>
    </section>
  );
}

type Checkpoint = {
  id: string;
  path: string;
  operation: string;
  bytesBefore: number;
  createdAt: string;
};

function TimeMachine({
  action,
  agents,
}: {
  action: Action;
  agents: AgentProfile[];
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const activeAgentId = agents.some((agent) => agent.id === agentId)
    ? agentId
    : (agents[0]?.id ?? "");
  const [revision, setRevision] = useState(0);
  const [diff, setDiff] = useState<{
    path: string;
    before: string;
    current: string;
    changedSinceWrite: boolean;
  } | null>(null);
  const history = useQuery({
    enabled: Boolean(activeAgentId),
    queryKey: ["continuity", "checkpoints", activeAgentId, revision],
    queryFn: () =>
      computerPost<{ checkpoints: Checkpoint[] }>(
        activeAgentId,
        "/files/checkpoints",
        {},
      ),
  });
  return (
    <section className="mt-7">
      <SectionTitle
        title="Workspace Time Machine"
        description="Every Bot text write gets a pre-write checkpoint. Rollback is file-selective, preserves later human edits by default, and creates an undo checkpoint."
      />
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <NativeSelect onChange={setAgentId} value={activeAgentId}>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          onClick={() => setRevision((value) => value + 1)}
          variant="outline"
        >
          <IconHistory /> Refresh
        </Button>
      </div>
      {diff ? (
        <div className="mt-4 rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">{diff.path}</h3>
            <Button onClick={() => setDiff(null)} size="sm" variant="ghost">
              Close diff
            </Button>
          </div>
          {diff.changedSinceWrite ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
              This file changed after the Bot wrote it; normal rollback will
              preserve those edits.
            </p>
          ) : null}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Code title="Before">{diff.before}</Code>
            <Code title="Current">{diff.current}</Code>
          </div>
        </div>
      ) : null}
      <div className="mt-4 space-y-2">
        {history.data?.checkpoints.length ? (
          history.data.checkpoints.map((checkpoint) => (
            <article
              className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
              key={checkpoint.id}
            >
              <div>
                <p className="font-medium">{checkpoint.path}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {checkpoint.operation} ·{" "}
                  {checkpoint.bytesBefore.toLocaleString()} bytes before ·{" "}
                  {new Date(checkpoint.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() =>
                    action.mutate(() =>
                      computerPost<{
                        before: string;
                        current: string;
                        changedSinceWrite: boolean;
                      }>(activeAgentId, "/files/checkpoint-diff", {
                        checkpointId: checkpoint.id,
                        path: checkpoint.path,
                      }).then((result) =>
                        setDiff({ path: checkpoint.path, ...result }),
                      ),
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  <IconFileDiff /> Diff
                </Button>
                <Button
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(() =>
                      computerPost(activeAgentId, "/files/rollback", {
                        checkpointId: checkpoint.id,
                        path: checkpoint.path,
                      }).then(() => setRevision((value) => value + 1)),
                    )
                  }
                  size="sm"
                  variant="ghost"
                >
                  <IconHistory /> Roll back
                </Button>
              </div>
            </article>
          ))
        ) : (
          <Empty>
            No checkpoints yet. The next Bot file write creates one
            automatically.
          </Empty>
        )}
      </div>
    </section>
  );
}

function Programs({
  action,
  agents,
  programs,
}: {
  action: Action;
  agents: AgentProfile[];
  programs: ToolProgram[];
}) {
  return (
    <section className="mt-7">
      <SectionTitle
        action={<ProgramDialog action={action} agents={agents} />}
        title="Governed tool programs"
        description="Reviewed sequences call only already-granted tools. Each step keeps policy, approval, credential, and audit enforcement; only the final output returns to model context."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {programs.length ? (
          programs.map((program) => (
            <article className="rounded-xl border bg-card p-4" key={program.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Status value={program.status} />
                  <h3 className="mt-2 font-medium">{program.name}</h3>
                </div>
                <span className="text-xs text-muted-foreground">
                  v{program.revision}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {program.description || "No description"}
              </p>
              <code className="mt-2 block text-xs text-muted-foreground">
                Program ID: {program.id}
              </code>
              <ol className="mt-3 space-y-1 text-xs">
                {program.steps.map((step, index) => (
                  <li className="rounded-md bg-muted px-2 py-1.5" key={step.id}>
                    <span>
                      {index + 1}. {step.tool}
                    </span>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                      {JSON.stringify(step.arguments, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
              <Button
                className="mt-3"
                disabled={action.isPending}
                onClick={() =>
                  action.mutate(() =>
                    continuityRequest(`/programs/${program.id}/review`, {
                      method: "POST",
                      body: JSON.stringify({
                        approved: program.status !== "approved",
                      }),
                    }),
                  )
                }
                size="sm"
                variant="outline"
              >
                {program.status === "approved" ? (
                  "Return to draft"
                ) : (
                  <>
                    <IconCheck /> Approve
                  </>
                )}
              </Button>
            </article>
          ))
        ) : (
          <Empty>No tool programs yet.</Empty>
        )}
      </div>
    </section>
  );
}

function ProgramDialog({
  action,
  agents,
}: {
  action: Action;
  agents: AgentProfile[];
}) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const activeAgentId = agents.some((agent) => agent.id === agentId)
    ? agentId
    : (agents[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState(
    '[\n  { "tool": "tool_name", "arguments": {} }\n]',
  );
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> New program
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New tool program</DialogTitle>
          <DialogDescription>
            Save as draft, inspect every fixed argument, then approve it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Coworker">
            <NativeSelect onChange={setAgentId} value={activeAgentId}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Name">
            <Input
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </Field>
          <Field label="Description">
            <Input
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </Field>
          <Field label="Steps (JSON)">
            <Textarea
              className="min-h-48 font-mono text-xs"
              onChange={(event) => setSteps(event.target.value)}
              value={steps}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={action.isPending || !activeAgentId || !name.trim()}
            onClick={() =>
              action.mutate(
                () =>
                  continuityRequest("/programs", {
                    method: "POST",
                    body: JSON.stringify({
                      agentId: activeAgentId,
                      name,
                      description,
                      steps: JSON.parse(steps),
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillHealth({
  action,
  skills,
}: {
  action: Action;
  skills: Array<{
    id: string;
    title: string;
    slug: string;
    health: string;
    lifecycleStatus: string;
    latestVersion: number | null;
    versionCount: number;
    pinnedVersion: number | null;
    mutable: boolean;
    usageCount: number;
    lastUsedAt: string | null;
  }>;
}) {
  return (
    <section className="mt-7">
      <SectionTitle
        title="Skill health"
        description="Provenance hashes, immutable versions, usage, drift, archive, pin, and rollback make learned behavior inspectable instead of silently accumulating."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {skills.length ? (
          skills.map((skill) => (
            <article className="rounded-xl border bg-card p-4" key={skill.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Status value={skill.health} />
                  <h3 className="mt-2 font-medium">/{skill.slug}</h3>
                  <p className="text-xs text-muted-foreground">{skill.title}</p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {skill.versionCount} versions
                </span>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Used {skill.usageCount} times
                {skill.lastUsedAt
                  ? ` · last ${new Date(skill.lastUsedAt).toLocaleDateString()}`
                  : ""}
                {skill.pinnedVersion ? ` · pinned v${skill.pinnedVersion}` : ""}
              </p>
              {skill.mutable ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate(() =>
                        continuityRequest(`/skills/${skill.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            lifecycleStatus:
                              skill.lifecycleStatus === "archived"
                                ? "active"
                                : "archived",
                          }),
                        }),
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    <IconArchive />{" "}
                    {skill.lifecycleStatus === "archived"
                      ? "Restore"
                      : "Archive"}
                  </Button>
                  {skill.latestVersion ? (
                    <Button
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(() =>
                          continuityRequest(`/skills/${skill.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              pinnedVersion: skill.pinnedVersion
                                ? null
                                : skill.latestVersion,
                            }),
                          }),
                        )
                      }
                      size="sm"
                      variant="ghost"
                    >
                      {skill.pinnedVersion
                        ? "Unpin"
                        : `Pin v${skill.latestVersion}`}
                    </Button>
                  ) : null}
                  {skill.versionCount > 1 && skill.latestVersion ? (
                    <Button
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(() =>
                          continuityRequest(`/skills/${skill.id}/rollback`, {
                            method: "POST",
                            body: JSON.stringify({
                              version: Number(skill.latestVersion) - 1,
                            }),
                          }),
                        )
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Rollback
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Deployment skill · health controls require an administrator.
                </p>
              )}
            </article>
          ))
        ) : (
          <Empty>No skills are installed.</Empty>
        )}
      </div>
    </section>
  );
}

function Bundles({
  action,
  bundles,
}: {
  action: Action;
  bundles: Array<{
    id: string;
    name: string;
    description: string;
    version: number;
    contentHash: string;
    status: string;
    manifest: Record<string, unknown>;
  }>;
}) {
  return (
    <section className="mt-7">
      <SectionTitle
        action={<BundleDialog action={action} />}
        title="Portable Bot bundles"
        description="Versioned persona, skills, routines, components, and model defaults. OpenBot rejects credentials, grants, transcripts, sessions, and memory from the manifest."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {bundles.length ? (
          bundles.map((bundle) => (
            <article className="rounded-xl border bg-card p-4" key={bundle.id}>
              <div className="flex items-start justify-between">
                <div>
                  <Status value={bundle.status} />
                  <h3 className="mt-2 font-medium">{bundle.name}</h3>
                </div>
                <span className="text-xs text-muted-foreground">
                  v{bundle.version}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {bundle.description || "No description"}
              </p>
              <code className="mt-3 block text-xs text-muted-foreground">
                {bundle.contentHash.slice(0, 16)}
              </code>
              <div className="mt-3 flex gap-2">
                <Button
                  onClick={() => exportBundle(bundle)}
                  size="sm"
                  variant="outline"
                >
                  Export JSON
                </Button>
                {bundle.status !== "archived" ? (
                  <Button
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate(() =>
                        continuityRequest(`/bundles/${bundle.id}/archive`, {
                          method: "POST",
                        }),
                      )
                    }
                    size="sm"
                    variant="ghost"
                  >
                    <IconArchive /> Archive
                  </Button>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <Empty>No Bot bundles yet.</Empty>
        )}
      </div>
    </section>
  );
}

function BundleDialog({ action }: { action: Action }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [manifest, setManifest] = useState(
    '{\n  "persona": {},\n  "skillSlugs": [],\n  "routines": [],\n  "components": [],\n  "modelDefaults": {}\n}',
  );
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> New bundle
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Bot bundle</DialogTitle>
          <DialogDescription>
            Portable configuration only. Secret-like or private-state keys are
            rejected.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Name">
            <Input
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </Field>
          <Field label="Description">
            <Input
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </Field>
          <Field label="Manifest (JSON)">
            <Textarea
              className="min-h-64 font-mono text-xs"
              onChange={(event) => setManifest(event.target.value)}
              value={manifest}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={action.isPending || !name.trim()}
            onClick={() =>
              action.mutate(
                () =>
                  continuityRequest("/bundles", {
                    method: "POST",
                    body: JSON.stringify({
                      name,
                      description,
                      manifest: JSON.parse(manifest),
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Create bundle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Action = {
  isPending: boolean;
  mutate: (
    job: () => Promise<unknown>,
    options?: { onSuccess?: () => void },
  ) => void;
};
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
function SectionTitle({
  title,
  description,
  action,
  className = "",
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${className}`}
    >
      <div className="max-w-3xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
function Status({ value }: { value: string }) {
  const good = ["approved", "healthy", "active", "succeeded"].includes(value);
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs capitalize ${good ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}
    >
      {value}
    </span>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/20 p-6 text-sm text-muted-foreground md:col-span-2">
      {children}
    </div>
  );
}
function NativeSelect({
  children,
  value,
  onChange,
}: {
  children: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
  );
}
function Field({
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
function Code({ title, children }: { title: string; children: string }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
        {children || "(file did not exist)"}
      </pre>
    </div>
  );
}

async function computerPost<T>(
  botId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(
    `/api/computers/${encodeURIComponent(botId)}${path}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const parsed = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok)
    throw new Error(parsed?.error ?? "Computer request failed.");
  return parsed as T;
}

function exportBundle(bundle: {
  name: string;
  version: number;
  description: string;
  manifest: Record<string, unknown>;
  contentHash: string;
}) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${bundle.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "openbot-bundle"}-v${bundle.version}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
