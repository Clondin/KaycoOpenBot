import type { KnowledgeAclEntry, KnowledgeActor } from "./types";

export function canRead(
  actor: KnowledgeActor,
  entries: KnowledgeAclEntry[],
): boolean {
  let allowed = false;

  for (const entry of entries) {
    if (!matchesPrincipal(actor, entry.principal)) continue;
    if (entry.effect === "deny") return false;
    allowed = true;
  }

  return allowed;
}

function matchesPrincipal(actor: KnowledgeActor, principal: string): boolean {
  if (principal === `user:${actor.userId}`) return true;
  const email = actor.email?.trim().toLowerCase();
  if (email && principal === `user:${email}`) return true;
  if (!principal.startsWith("group:")) return false;
  const group = principal.slice("group:".length).toLowerCase();
  if (group === "*") return true;
  if (email?.includes("@") && group === `domain:${email.split("@").at(-1)}`) {
    return true;
  }
  return actor.groups.some((value) => value.trim().toLowerCase() === group);
}
