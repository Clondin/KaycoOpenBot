import type { AgentProfile } from "./profile-types";

export const TEAM_TEMPLATE_SCHEMA = "kayco.openbot.team";
export const TEAM_TEMPLATE_VERSION = 1;
export const MAX_TEAM_MEMBERS = 25;

export type TeamTemplateMember = {
  name: string;
  title: string;
  roleDescription: string;
};

export type TeamTemplate = {
  schema: typeof TEAM_TEMPLATE_SCHEMA;
  version: typeof TEAM_TEMPLATE_VERSION;
  name: string;
  coworkers: TeamTemplateMember[];
};

export function teamTemplateFrom(
  name: string,
  profiles: readonly AgentProfile[],
): TeamTemplate {
  return {
    schema: TEAM_TEMPLATE_SCHEMA,
    version: TEAM_TEMPLATE_VERSION,
    name,
    coworkers: profiles.map((profile) => ({
      name: profile.name,
      title: profile.title,
      roleDescription: profile.roleDescription,
    })),
  };
}

/**
 * Parse only the persona fields Kayco deliberately shares.
 *
 * Unknown fields are discarded. In particular ids, endpoints, credentials, grants, permissions,
 * messages and ownership never enter the returned value, even when a file includes them.
 */
export function parseTeamTemplate(
  input: unknown,
): { ok: true; value: TeamTemplate } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Team template must be a JSON object." };
  }
  const root = input as Record<string, unknown>;
  if (
    root.schema !== TEAM_TEMPLATE_SCHEMA ||
    root.version !== TEAM_TEMPLATE_VERSION
  ) {
    return { ok: false, error: "This is not a supported Kayco team template." };
  }
  const name = boundedText(root.name, 120);
  if (!name)
    return {
      ok: false,
      error: "Team name must be between 1 and 120 characters.",
    };
  if (
    !Array.isArray(root.coworkers) ||
    root.coworkers.length === 0 ||
    root.coworkers.length > MAX_TEAM_MEMBERS
  ) {
    return {
      ok: false,
      error: `A team template must contain between 1 and ${MAX_TEAM_MEMBERS} coworkers.`,
    };
  }

  const coworkers: TeamTemplateMember[] = [];
  for (const item of root.coworkers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "Every coworker must be a JSON object." };
    }
    const record = item as Record<string, unknown>;
    const member = {
      name: boundedText(record.name, 80),
      title: boundedText(record.title, 120),
      roleDescription: boundedText(record.roleDescription, 1000),
    };
    if (!member.name || !member.title || !member.roleDescription) {
      return {
        ok: false,
        error: "A coworker has an invalid name, title, or role description.",
      };
    }
    coworkers.push(member as TeamTemplateMember);
  }

  return {
    ok: true,
    value: {
      schema: TEAM_TEMPLATE_SCHEMA,
      version: TEAM_TEMPLATE_VERSION,
      name,
      coworkers,
    },
  };
}

function boundedText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}
