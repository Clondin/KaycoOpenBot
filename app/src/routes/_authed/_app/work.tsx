import {
  IconBell,
  IconBrain,
  IconBriefcase,
  IconCheck,
  IconClock,
  IconGitBranch,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlug,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { stashAssignedWork } from "@/components/channels/transcript-messages";
import { PageShell } from "@/components/layout/page-shell";
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
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import type { AgentChannel } from "@/lib/channels/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import type { TaskRun } from "@/lib/runs/queries";
import {
  type Delegation,
  type MemoryEntry,
  type Project,
  type ProjectArtifact,
  type Routine,
  type WorkOverview,
  type WorkTemplate,
  workKeys,
  workOverviewQueryOptions,
  workRequest,
} from "@/lib/work/queries";

const viewSchema = z.object({
  view: z
    .enum(["queue", "routines", "projects", "integrations", "memory"])
    .optional(),
});

export const Route = createFileRoute("/_authed/_app/work")({
  validateSearch: viewSchema,
  component: WorkPage,
});

function WorkPage() {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const current = Route.useSearch().view ?? "queue";
  const overview = useQuery(workOverviewQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const [problem, setProblem] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: (job: () => Promise<unknown>) => job(),
    onSuccess: () => {
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: workKeys.all });
    },
    onError: (error) =>
      setProblem(error instanceof Error ? error.message : "That did not work."),
  });

  useDesktopNotifications(overview.data);

  const data = overview.data;
  const active = data?.runs.filter((run) => activeRun(run.status)).length ?? 0;
  const needsYou =
    data?.runs.filter((run) =>
      ["waiting_for_approval", "waiting_for_input", "failed"].includes(
        run.status,
      ),
    ).length ?? 0;
  const scheduled =
    data?.routines.filter(
      (routine) =>
        routine.status === "active" && routine.trigger === "schedule",
    ).length ?? 0;
  const unread = data?.notifications.filter((item) => !item.readAt).length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <PageShell
        className="pb-24"
        description="Always-on tasks, reusable routines, coworker handoffs, shared projects, and memory you can inspect."
        title="Work"
        width="wide"
      >
        <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric icon={<IconClock />} label="Active" value={active} />
          <Metric icon={<IconBell />} label="Needs you" value={needsYou} />
          <Metric
            icon={<IconPlayerPlay />}
            label="Scheduled"
            value={scheduled}
          />
          <Metric icon={<IconCheck />} label="Unread" value={unread} />
        </div>

        <nav
          aria-label="Work sections"
          className="mt-8 grid grid-cols-3 gap-1 rounded-xl border border-border bg-muted/40 p-1 sm:flex sm:overflow-x-auto"
        >
          {(
            [
              ["queue", "Queue", IconBriefcase],
              ["routines", "Routines", IconClock],
              ["projects", "Projects", IconGitBranch],
              ["integrations", "Integrations", IconPlug],
              ["memory", "Memory", IconBrain],
            ] as const
          ).map(([view, label, Icon]) => (
            <Button
              className="min-w-0 px-2 sm:shrink-0 sm:px-3"
              key={view}
              onClick={() => navigate({ search: { view } })}
              size="sm"
              variant={current === view ? "secondary" : "ghost"}
            >
              <Icon />
              {label}
            </Button>
          ))}
        </nav>

        {problem ? (
          <p
            className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        {overview.isPending ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading work…</p>
        ) : overview.error || !data ? (
          <p className="mt-8 text-sm text-destructive" role="alert">
            The work queue could not be loaded.
          </p>
        ) : current === "queue" ? (
          <QueueView action={action} agents={agents.data ?? []} data={data} />
        ) : current === "routines" ? (
          <RoutinesView
            action={action}
            agents={agents.data ?? []}
            channels={channels.data ?? []}
            projects={data.projects}
            routines={data.routines}
          />
        ) : current === "projects" ? (
          <ProjectsView
            action={action}
            agents={agents.data ?? []}
            projects={data.projects}
          />
        ) : current === "integrations" ? (
          <IntegrationsView
            action={action}
            agents={agents.data ?? []}
            channels={channels.data ?? []}
            projects={data.projects}
            templates={data.templates}
          />
        ) : (
          <MemoryView
            action={action}
            agents={agents.data ?? []}
            entries={data.memory}
            projects={data.projects}
          />
        )}
      </PageShell>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">
          {label}
        </span>
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function QueueView({
  action,
  agents,
  data,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  data: WorkOverview;
}) {
  const navigate = useNavigate();
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  const workByRun = new Map<
    string,
    { text: string; channelId: string; kind: "routine" | "delegation" }
  >();
  for (const routine of data.routines) {
    if (routine.latestRun) {
      workByRun.set(routine.latestRun.id, {
        text: routine.instruction,
        channelId: routine.channelId,
        kind: "routine",
      });
    }
  }
  for (const delegation of data.delegations) {
    workByRun.set(delegation.taskRunId, {
      text: delegation.instructions,
      channelId: delegation.targetChannelId,
      kind: "delegation",
    });
  }
  const visibleRuns = data.runs.slice(0, 40);
  return (
    <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <SectionHeading
          action={
            <CreateDelegationDialog
              action={action}
              agents={agents}
              projects={data.projects}
            />
          }
          description="Every scheduled routine and handoff lands here as a durable task."
          title="Work queue"
        />
        <div className="mt-4 space-y-2">
          {visibleRuns.length ? (
            visibleRuns.map((run) => {
              const assigned = workByRun.get(run.id);
              return (
                <div
                  className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                  key={run.id}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={run.status} />
                      <p className="truncate font-medium">{run.title}</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {run.agentId
                        ? (agentName.get(run.agentId) ?? "Coworker")
                        : "Coworker"}{" "}
                      · {relativeTime(run.createdAt)}
                    </p>
                    {run.error ? (
                      <p className="mt-2 line-clamp-2 text-sm text-destructive">
                        {run.error}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    className="shrink-0"
                    onClick={() => {
                      if (assigned && run.status === "queued") {
                        stashAssignedWork(
                          assigned.channelId,
                          assigned.text,
                          run.id,
                        );
                      }
                      void navigate({
                        to: "/channel/$channelId",
                        params: {
                          channelId: assigned?.channelId ?? run.channelId,
                        },
                      });
                    }}
                    size="sm"
                    variant={
                      run.status === "queued" && assigned
                        ? "default"
                        : "outline"
                    }
                  >
                    {run.status === "queued" && assigned
                      ? "Start task"
                      : "Open"}
                  </Button>
                </div>
              );
            })
          ) : (
            <EmptyLine>No work has been assigned yet.</EmptyLine>
          )}
        </div>

        <SectionHeading
          className="mt-10"
          description="Bots can pass bounded work and project context without making you the router."
          title="Handoffs"
        />
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {data.delegations.length ? (
            data.delegations
              .slice(0, 12)
              .map((delegation) => (
                <DelegationCard
                  action={action}
                  delegation={delegation}
                  key={delegation.id}
                />
              ))
          ) : (
            <EmptyLine>No coworker handoffs yet.</EmptyLine>
          )}
        </div>
      </div>

      <aside>
        <SectionHeading
          action={<DesktopAlertsButton />}
          description="Approvals, completed handoffs, and scheduled work appear here."
          title="Notifications"
        />
        <div className="mt-4 space-y-2">
          {data.notifications.length ? (
            data.notifications.slice(0, 20).map((notification) => (
              <button
                className={`w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/60 ${
                  notification.readAt
                    ? "border-border bg-card"
                    : "border-foreground/20 bg-muted/60"
                }`}
                key={notification.id}
                onClick={() => {
                  action.mutate(() =>
                    workRequest(
                      `/notifications/${encodeURIComponent(notification.id)}/read`,
                      {
                        method: "POST",
                      },
                    ),
                  );
                  if (notification.targetUrl)
                    window.location.assign(notification.targetUrl);
                }}
                type="button"
              >
                <p className="text-sm font-medium">{notification.title}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {notification.body}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {relativeTime(notification.createdAt)}
                </p>
              </button>
            ))
          ) : (
            <EmptyLine>You’re all caught up.</EmptyLine>
          )}
        </div>
      </aside>
    </div>
  );
}

function DelegationCard({
  action,
  delegation,
}: {
  action: WorkAction;
  delegation: Delegation;
}) {
  const terminal = ["completed", "failed", "cancelled"].includes(
    delegation.status,
  );
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <StatusPill status={delegation.status} />
          <p className="mt-2 truncate font-medium">{delegation.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Assigned to {delegation.targetName}
          </p>
        </div>
        <Button
          render={
            <Link
              params={{ channelId: delegation.targetChannelId }}
              to="/channel/$channelId"
            />
          }
          size="sm"
          variant="ghost"
        >
          Open
        </Button>
      </div>
      <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
        {delegation.instructions}
      </p>
      {!terminal ? (
        <div className="mt-3 flex gap-2">
          {delegation.status === "queued" ? (
            <Button
              onClick={() =>
                action.mutate(() =>
                  workRequest(`/delegations/${delegation.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ status: "accepted" }),
                  }),
                )
              }
              size="sm"
              variant="outline"
            >
              Accept
            </Button>
          ) : null}
          <Button
            onClick={() =>
              action.mutate(() =>
                workRequest(`/delegations/${delegation.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ status: "cancelled" }),
                }),
              )
            }
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RoutinesView({
  action,
  agents,
  channels,
  projects,
  routines,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  channels: AgentChannel[];
  projects: Project[];
  routines: Routine[];
}) {
  const byAgent = new Map(agents.map((agent) => [agent.id, agent.name]));
  return (
    <div className="mt-8">
      <SectionHeading
        action={
          <CreateRoutineDialog
            action={action}
            agents={agents}
            channels={channels}
            projects={projects}
          />
        }
        description="A routine keeps its instructions, owner, trigger, timezone, and execution history. Scheduled occurrences are idempotent across restarts."
        title="Reusable routines"
      />
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {routines.length ? (
          routines.map((routine) => (
            <div
              className="rounded-xl border border-border bg-card p-4"
              key={routine.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={routine.status} />
                    <span className="text-xs text-muted-foreground">
                      {routine.scheduleLabel ?? capitalize(routine.trigger)}
                    </span>
                  </div>
                  <h3 className="mt-2 truncate font-medium">{routine.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {byAgent.get(routine.agentId) ?? "Coworker"}
                    {routine.nextRunAt
                      ? ` · next ${relativeTime(routine.nextRunAt)}`
                      : ""}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    aria-label={`Run ${routine.name}`}
                    disabled={action.isPending || routine.status === "archived"}
                    onClick={() =>
                      action.mutate(() =>
                        workRequest(`/routines/${routine.id}/run`, {
                          method: "POST",
                        }),
                      )
                    }
                    size="icon-sm"
                    variant="ghost"
                  >
                    <IconPlayerPlay />
                  </Button>
                  {routine.status !== "archived" ? (
                    <Button
                      aria-label={
                        routine.status === "paused"
                          ? "Resume routine"
                          : "Pause routine"
                      }
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(() =>
                          workRequest(`/routines/${routine.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              status:
                                routine.status === "paused"
                                  ? "active"
                                  : "paused",
                            }),
                          }),
                        )
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      {routine.status === "paused" ? (
                        <IconPlayerPlay />
                      ) : (
                        <IconPlayerPause />
                      )}
                    </Button>
                  ) : null}
                </div>
              </div>
              <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
                {routine.instruction}
              </p>
              {routine.latestRun ? (
                <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                  Last dispatch: {capitalize(routine.latestRun.status)} ·{" "}
                  {relativeTime(routine.latestRun.createdAt)}
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <EmptyLine>
            Create a routine for work you want a coworker to repeat.
          </EmptyLine>
        )}
      </div>
    </div>
  );
}

function ProjectsView({
  action,
  agents,
  projects,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  projects: Project[];
}) {
  const navigate = useNavigate();
  return (
    <div className="mt-8">
      <SectionHeading
        action={<CreateProjectDialog action={action} agents={agents} />}
        description="Projects share explicit context and artifacts while each coworker keeps its own isolated computer and credentials."
        title="Shared project workspaces"
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects.length ? (
          projects.map((project) => (
            <div
              className="rounded-xl border border-border bg-card p-4"
              key={project.id}
            >
              <div className="flex items-center justify-between gap-3">
                <StatusPill status={project.status} />
                <span className="text-xs capitalize text-muted-foreground">
                  {project.role}
                </span>
              </div>
              <h3 className="mt-3 font-medium">{project.name}</h3>
              <p className="mt-1 line-clamp-3 min-h-10 text-sm text-muted-foreground">
                {project.description ||
                  "A shared workspace for coworker handoffs and results."}
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {project.agents.map((agent) => (
                  <span
                    className="rounded-full bg-muted px-2 py-1 text-xs"
                    key={agent.id}
                  >
                    {agent.name}
                  </span>
                ))}
                {!project.agents.length ? (
                  <span className="text-xs text-muted-foreground">
                    No coworkers assigned
                  </span>
                ) : null}
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
                <ProjectArtifactsDialog project={project} />
                <Button
                  disabled={!project.agents.length || action.isPending}
                  onClick={() =>
                    action.mutate(async () => {
                      const response = await fetch("/api/channels", {
                        body: JSON.stringify({
                          agentIds: project.agents.map((agent) => agent.id),
                        }),
                        credentials: "include",
                        headers: { "content-type": "application/json" },
                        method: "POST",
                      });
                      if (!response.ok) {
                        throw new Error(
                          "The project channel could not be created.",
                        );
                      }
                      const { channel } = (await response.json()) as {
                        channel: AgentChannel;
                      };
                      await navigate({
                        params: { channelId: channel.id },
                        to: "/channel/$channelId",
                      });
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Team channel
                </Button>
              </div>
            </div>
          ))
        ) : (
          <EmptyLine>No projects yet.</EmptyLine>
        )}
      </div>
    </div>
  );
}

function ProjectArtifactsDialog({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const artifacts = useQuery({
    enabled: open,
    queryFn: () =>
      workRequest<{ artifacts: ProjectArtifact[] }>(
        `/projects/${encodeURIComponent(project.id)}/artifacts`,
      ),
    queryKey: [...workKeys.all, "projects", project.id, "artifacts"],
  });
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="ghost" />}>
        {project.artifactCount} artifact{project.artifactCount === 1 ? "" : "s"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{project.name} artifacts</DialogTitle>
          <DialogDescription>
            Durable results shared by the coworkers assigned to this project.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[65dvh] overflow-y-auto">
          {artifacts.isPending ? (
            <p className="text-sm text-muted-foreground">Loading artifacts…</p>
          ) : artifacts.error ? (
            <p className="text-sm text-destructive">
              Artifacts could not be loaded.
            </p>
          ) : artifacts.data?.artifacts.length ? (
            <div className="space-y-3">
              {artifacts.data.artifacts.map((artifact) => (
                <article
                  className="rounded-xl border border-border p-4"
                  key={artifact.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{artifact.title}</h3>
                    <span className="text-xs text-muted-foreground">
                      {artifact.kind} · v{artifact.version}
                    </span>
                  </div>
                  <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-muted-foreground">
                    {artifact.content}
                  </pre>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    Updated {relativeTime(artifact.updatedAt)}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <EmptyLine>No artifacts have been saved yet.</EmptyLine>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IntegrationsView({
  action,
  agents,
  channels,
  projects,
  templates,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  channels: AgentChannel[];
  projects: Project[];
  templates: WorkTemplate[];
}) {
  return (
    <div className="mt-8">
      <SectionHeading
        action={
          <div className="flex gap-2">
            <Button
              render={<Link to="/admin/connectors" />}
              size="sm"
              variant="outline"
            >
              Knowledge sources
            </Button>
            <Button
              render={<Link to="/admin/plugins" />}
              size="sm"
              variant="outline"
            >
              MCP tools
            </Button>
          </div>
        }
        description="Start from reviewed operating patterns, then connect first-party knowledge sources or MCP tools. Every write still passes through grants, policy, audit, and approval."
        title="Integration recipes"
      />
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {templates.map((template) => (
          <div
            className="rounded-xl border border-border bg-card p-5"
            key={template.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
                {template.trigger}
              </span>
              <span className="text-xs text-muted-foreground">
                {template.agentRole}
              </span>
            </div>
            <h3 className="mt-3 font-medium">{template.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {template.summary}
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {template.integrationLabels.map((label) => (
                <span
                  className="rounded-full border border-border px-2 py-1 text-xs"
                  key={label}
                >
                  {label}
                </span>
              ))}
            </div>
            <div className="mt-5">
              <CreateRoutineDialog
                action={action}
                agents={agents}
                channels={channels}
                label="Use template"
                preset={template}
                projects={projects}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-xl border border-border bg-muted/30 p-5">
        <h3 className="font-medium">Connection model</h3>
        <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
          Google Drive is a native knowledge source. Slack, Atlassian, Box,
          Salesforce, and ServiceNow use pinned first-party MCP endpoints. Other
          approved vendors can be connected through an HTTPS custom MCP server,
          and any system can securely dispatch a routine through its one-time
          bearer-token webhook.
        </p>
      </div>
    </div>
  );
}

function MemoryView({
  action,
  agents,
  entries,
  projects,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  entries: MemoryEntry[];
  projects: Project[];
}) {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  return (
    <div className="mt-8">
      <SectionHeading
        action={
          <CreateMemoryDialog
            action={action}
            agents={agents}
            projects={projects}
          />
        }
        description="Memory is scoped, editable, and removable. Coworkers are instructed never to store secrets or transient chat text here."
        title="Inspectable memory"
      />
      <div className="mt-4 space-y-2">
        {entries.length ? (
          entries.map((entry) => (
            <div
              className="rounded-xl border border-border bg-card p-4"
              key={entry.id}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
                      {entry.kind}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.scope === "agent"
                        ? (agentNames.get(entry.agentId ?? "") ?? "Coworker")
                        : entry.scope === "project"
                          ? (projectNames.get(entry.projectId ?? "") ??
                            "Project")
                          : "You"}
                    </span>
                    {entry.pinned ? (
                      <span className="text-xs">Pinned</span>
                    ) : null}
                  </div>
                  <h3 className="mt-2 font-medium">{entry.title}</h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {entry.content}
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {entry.confidence}% confidence · {entry.source} · updated{" "}
                    {relativeTime(entry.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <EditMemoryDialog action={action} entry={entry} />
                  <Button
                    onClick={() =>
                      action.mutate(() =>
                        workRequest(`/memory/${entry.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ pinned: !entry.pinned }),
                        }),
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    {entry.pinned ? "Unpin" : "Pin"}
                  </Button>
                  <Button
                    onClick={() =>
                      action.mutate(() =>
                        workRequest(`/memory/${entry.id}`, {
                          method: "DELETE",
                        }),
                      )
                    }
                    size="sm"
                    variant="ghost"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))
        ) : (
          <EmptyLine>No inspectable memory has been saved.</EmptyLine>
        )}
      </div>
    </div>
  );
}

function EditMemoryDialog({
  action,
  entry,
}: {
  action: WorkAction;
  entry: MemoryEntry;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(entry.kind);
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [confidence, setConfidence] = useState(String(entry.confidence));
  const confidenceNumber = Number(confidence);
  const validConfidence =
    Number.isInteger(confidenceNumber) &&
    confidenceNumber >= 0 &&
    confidenceNumber <= 100;
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Edit
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit memory</DialogTitle>
          <DialogDescription>
            Changes become available to the next coworker turn.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Kind">
            <NativeSelect
              onChange={(value) => setKind(value as MemoryEntry["kind"])}
              value={kind}
            >
              <option value="preference">Preference</option>
              <option value="fact">Fact</option>
              <option value="instruction">Instruction</option>
              <option value="decision">Decision</option>
            </NativeSelect>
          </Field>
          <Field label="Title">
            <Input
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </Field>
          <Field label="Memory">
            <Textarea
              className="min-h-28"
              onChange={(event) => setContent(event.target.value)}
              value={content}
            />
          </Field>
          <Field label="Confidence (0–100)">
            <Input
              max={100}
              min={0}
              onChange={(event) => setConfidence(event.target.value)}
              type="number"
              value={confidence}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              !title.trim() ||
              !content.trim() ||
              !validConfidence ||
              action.isPending
            }
            onClick={() =>
              action.mutate(
                () =>
                  workRequest(`/memory/${entry.id}`, {
                    body: JSON.stringify({
                      confidence: confidenceNumber,
                      content,
                      kind,
                      title,
                    }),
                    method: "PATCH",
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateRoutineDialog({
  action,
  agents,
  channels,
  label = "New routine",
  preset,
  projects,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  channels: AgentChannel[];
  label?: string;
  preset?: WorkTemplate;
  projects: Project[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(preset?.title ?? "");
  const [instruction, setInstruction] = useState(preset?.instruction ?? "");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [trigger, setTrigger] = useState<"manual" | "schedule" | "webhook">(
    preset?.trigger ?? "manual",
  );
  const [time, setTime] = useState("08:00");
  const [webhook, setWebhook] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const submit = async () => {
    let channel = channels.find(
      (candidate) =>
        candidate.agentIds.length === 1 && candidate.agentIds[0] === agentId,
    );
    if (!channel) {
      const response = await fetch("/api/channels", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds: [agentId] }),
      });
      if (!response.ok)
        throw new Error("A channel for this routine could not be created.");
      channel = ((await response.json()) as { channel: AgentChannel }).channel;
    }
    const response = await workRequest<{
      routine: Routine;
      webhookToken?: string;
    }>("/routines", {
      method: "POST",
      body: JSON.stringify({
        name,
        instruction,
        agentId,
        channelId: channel.id,
        ...(projectId ? { projectId } : {}),
        trigger,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        ...(trigger === "schedule"
          ? { schedule: { kind: "daily", time } }
          : {}),
      }),
    });
    if (response.webhookToken) {
      setWebhook(
        `${window.location.origin}/api/hooks/routines/${response.routine.id}\nAuthorization: Bearer ${response.webhookToken}`,
      );
      return;
    }
    setOpen(false);
    setName("");
    setInstruction("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> {label}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New routine</DialogTitle>
          <DialogDescription>
            {preset
              ? "Review the instructions, choose a coworker, and connect the listed systems before relying on this routine."
              : "Store a repeatable assignment and optionally dispatch it on a schedule or authenticated webhook."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="overflow-y-auto">
          {webhook ? (
            <div>
              <Label>Webhook details — shown once</Label>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                {webhook}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                Keep the bearer token in your secret manager. OpenBot stores
                only its hash.
              </p>
            </div>
          ) : (
            <>
              <Field label="Name">
                <Input
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </Field>
              <Field label="Coworker">
                <NativeSelect onChange={setAgentId} value={agentId}>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} — {agent.title}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Instructions">
                <Textarea
                  className="min-h-32"
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Describe the finished result, systems to use, and where approval is required."
                  value={instruction}
                />
              </Field>
              <Field label="Trigger">
                <NativeSelect
                  onChange={(value) => setTrigger(value as typeof trigger)}
                  value={trigger}
                >
                  <option value="manual">Manual</option>
                  <option value="schedule">Daily schedule</option>
                  <option value="webhook">Authenticated webhook</option>
                </NativeSelect>
              </Field>
              {trigger === "schedule" ? (
                <Field label="Local time">
                  <Input
                    onChange={(event) => setTime(event.target.value)}
                    type="time"
                    value={time}
                  />
                </Field>
              ) : null}
              <Field label="Project (optional)">
                <NativeSelect onChange={setProjectId} value={projectId}>
                  <option value="">No project</option>
                  {projects
                    .filter((project) => project.status === "active")
                    .map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                </NativeSelect>
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {webhook ? (
            <Button
              onClick={() => {
                setOpen(false);
                setWebhook(null);
              }}
            >
              Done
            </Button>
          ) : (
            <Button
              disabled={
                !name.trim() ||
                !instruction.trim() ||
                !agentId ||
                action.isPending
              }
              onClick={() =>
                action.mutate(submit, { onSuccess: () => undefined })
              }
            >
              {action.isPending ? "Saving…" : "Save routine"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateDelegationDialog({
  action,
  agents,
  projects,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  projects: Project[];
}) {
  const [open, setOpen] = useState(false);
  const [targetAgentId, setTargetAgentId] = useState(agents[0]?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");
  useEffect(() => {
    if (!targetAgentId && agents[0]) setTargetAgentId(agents[0].id);
  }, [targetAgentId, agents]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> Assign work
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign work to a coworker</DialogTitle>
          <DialogDescription>
            This creates a durable handoff, its own channel, and a queued task.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="overflow-y-auto">
          <Field label="Coworker">
            <NativeSelect onChange={setTargetAgentId} value={targetAgentId}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} — {agent.title}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Title">
            <Input
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </Field>
          <Field label="Instructions">
            <Textarea
              className="min-h-28"
              onChange={(event) => setInstructions(event.target.value)}
              value={instructions}
            />
          </Field>
          <Field label="Expected output">
            <Input
              onChange={(event) => setExpectedOutput(event.target.value)}
              value={expectedOutput}
            />
          </Field>
          <Field label="Project (optional)">
            <NativeSelect onChange={setProjectId} value={projectId}>
              <option value="">No project</option>
              {projects
                .filter((project) => project.status === "active")
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={
              !targetAgentId ||
              !title.trim() ||
              !instructions.trim() ||
              action.isPending
            }
            onClick={() =>
              action.mutate(
                () =>
                  workRequest("/delegations", {
                    method: "POST",
                    body: JSON.stringify({
                      targetAgentId,
                      title,
                      instructions,
                      expectedOutput,
                      ...(projectId ? { projectId } : {}),
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            {action.isPending ? "Assigning…" : "Assign work"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateProjectDialog({
  action,
  agents,
}: {
  action: WorkAction;
  agents: AgentProfile[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> New project
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New shared project</DialogTitle>
          <DialogDescription>
            Coworkers share project context and artifacts, not browser sessions
            or credentials.
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
            <Textarea
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </Field>
          <div>
            <Label>Coworkers</Label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {agents.map((agent) => (
                <label
                  className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm"
                  key={agent.id}
                >
                  <input
                    checked={selected.includes(agent.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, agent.id]
                          : current.filter((id) => id !== agent.id),
                      )
                    }
                    type="checkbox"
                  />
                  <span className="truncate">{agent.name}</span>
                </label>
              ))}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={!name.trim() || action.isPending}
            onClick={() =>
              action.mutate(
                () =>
                  workRequest("/projects", {
                    method: "POST",
                    body: JSON.stringify({
                      name,
                      description,
                      agentIds: selected,
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            {action.isPending ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateMemoryDialog({
  action,
  agents,
  projects,
}: {
  action: WorkAction;
  agents: AgentProfile[];
  projects: Project[];
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"user" | "agent" | "project">("user");
  const [kind, setKind] = useState<
    "preference" | "fact" | "instruction" | "decision"
  >("preference");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const validTarget = scope === "user" || Boolean(target);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <IconPlus /> Add memory
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add inspectable memory</DialogTitle>
          <DialogDescription>
            Store stable context—not secrets or temporary conversation text.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Scope">
            <NativeSelect
              onChange={(value) => {
                setScope(value as typeof scope);
                setTarget("");
              }}
              value={scope}
            >
              <option value="user">You</option>
              <option value="agent">One coworker</option>
              <option value="project">One project</option>
            </NativeSelect>
          </Field>
          {scope !== "user" ? (
            <Field label={scope === "agent" ? "Coworker" : "Project"}>
              <NativeSelect onChange={setTarget} value={target}>
                <option value="">Choose…</option>
                {(scope === "agent" ? agents : projects).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="Kind">
            <NativeSelect
              onChange={(value) => setKind(value as typeof kind)}
              value={kind}
            >
              <option value="preference">Preference</option>
              <option value="fact">Fact</option>
              <option value="instruction">Instruction</option>
              <option value="decision">Decision</option>
            </NativeSelect>
          </Field>
          <Field label="Title">
            <Input
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </Field>
          <Field label="Memory">
            <Textarea
              className="min-h-28"
              onChange={(event) => setContent(event.target.value)}
              value={content}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={
              !validTarget ||
              !title.trim() ||
              !content.trim() ||
              action.isPending
            }
            onClick={() =>
              action.mutate(
                () =>
                  workRequest("/memory", {
                    method: "POST",
                    body: JSON.stringify({
                      scope,
                      kind,
                      title,
                      content,
                      source: "user",
                      ...(scope === "agent" ? { agentId: target } : {}),
                      ...(scope === "project" ? { projectId: target } : {}),
                    }),
                  }),
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            {action.isPending ? "Saving…" : "Save memory"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="space-y-1.5">
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
      className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/40"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
  );
}

function SectionHeading({
  action,
  className = "",
  description,
  title,
}: {
  action?: React.ReactNode;
  className?: string;
  description?: string;
  title: string;
}) {
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {description ? (
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed" || status === "succeeded" || status === "active"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : status === "failed" || status === "cancelled" || status === "archived"
        ? "bg-red-500/10 text-red-700 dark:text-red-300"
        : status.includes("waiting") || status === "paused"
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {capitalize(status)}
    </span>
  );
}

function activeRun(status: TaskRun["status"]) {
  return [
    "queued",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
  ].includes(status);
}

function capitalize(value: string) {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});
function relativeTime(value: string) {
  const elapsed = new Date(value).getTime() - Date.now();
  const absolute = Math.abs(elapsed);
  if (absolute < 60_000) return "now";
  if (absolute < 3_600_000)
    return relativeFormatter.format(Math.round(elapsed / 60_000), "minute");
  if (absolute < 86_400_000)
    return relativeFormatter.format(Math.round(elapsed / 3_600_000), "hour");
  return relativeFormatter.format(Math.round(elapsed / 86_400_000), "day");
}

type WorkAction = ReturnType<
  typeof useMutation<unknown, Error, () => Promise<unknown>>
>;

function DesktopAlertsButton() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(supported ? Notification.permission : "unsupported");
  if (!supported || permission === "granted") return null;
  return (
    <Button
      onClick={async () =>
        setPermission(await Notification.requestPermission())
      }
      size="sm"
      variant="ghost"
    >
      Enable alerts
    </Button>
  );
}

function useDesktopNotifications(data: WorkOverview | undefined) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!data) return;
    for (const item of data.notifications) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      if (
        !item.readAt &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        new Notification(item.title, { body: item.body, tag: item.id });
      }
    }
  }, [data]);
}
