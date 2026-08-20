import { and, eq } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  projectMembers,
} from "../db/schema";

export class WorkNotFoundError extends Error {
  constructor(message = "Work item not found.") {
    super(message);
    this.name = "WorkNotFoundError";
  }
}

export class WorkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkConflictError";
  }
}

export class WorkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkValidationError";
  }
}

export async function projectRole(
  database: Database,
  actor: AgentActor,
  projectId: string,
) {
  const [membership] = await database
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, actor.id),
      ),
    )
    .limit(1);
  return membership?.role ?? null;
}

export async function requireProject(
  database: Database,
  actor: AgentActor,
  projectId: string,
  write = false,
) {
  const role = await projectRole(database, actor, projectId);
  if (!role) throw new WorkNotFoundError("Project not found.");
  if (write && role === "viewer") {
    throw new WorkConflictError("This project is read-only for you.");
  }
  return role;
}

export async function requireChannelAgent(
  database: Database,
  actor: AgentActor,
  channelId: string,
  agentId: string,
) {
  const [row] = await database
    .select({ channelId: channelMemberships.channelId })
    .from(channelMemberships)
    .innerJoin(
      channelAgents,
      and(
        eq(channelAgents.channelId, channelMemberships.channelId),
        eq(channelAgents.agentId, agentId),
      ),
    )
    .where(
      and(
        eq(channelMemberships.channelId, channelId),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .limit(1);
  if (!row) throw new WorkNotFoundError("Channel or coworker not found.");
}

export function safeLine(value: string, field: string, maximum = 120) {
  const line = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  })
    .join("")
    .trim()
    .replace(/\s+/g, " ");
  if (!line) throw new WorkValidationError(`${field} is required.`);
  return Array.from(line).slice(0, maximum).join("");
}

export function safeBody(value: string, field: string, maximum = 20_000) {
  const body = Array.from(value)
    .filter((character) => character.codePointAt(0) !== 0)
    .join("")
    .trim();
  if (!body) throw new WorkValidationError(`${field} is required.`);
  return Array.from(body).slice(0, maximum).join("");
}
