import type { ConnectorDefinition } from "./connector";
import {
  requireExtensionId,
  requireLabel,
  requireVersion,
  unique,
} from "./validation";

export const PLUGIN_API_VERSION = "2026-08-01" as const;

export type SkillDefinition = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
};

export type PluginManifest = {
  apiVersion: typeof PLUGIN_API_VERSION;
  id: string;
  name: string;
  version: string;
  description: string;
  homepage?: string;
};

/**
 * An installable bundle of declarative OpenBot extensions.
 *
 * External action tools intentionally do not run in-process through this contract. They use MCP, so
 * grants, policy, approval, credentials, and audit remain on the same reviewed execution path.
 */
export type PluginDefinition = {
  manifest: PluginManifest;
  skills?: SkillDefinition[];
  connectors?: ConnectorDefinition<unknown>[];
};

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  const { manifest } = definition;
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `Unsupported plugin API ${manifest.apiVersion}; expected ${PLUGIN_API_VERSION}.`,
    );
  }
  requireExtensionId(manifest.id, "Plugin id");
  requireVersion(manifest.version);
  requireLabel(manifest.name, "Plugin name");
  requireLabel(manifest.description, "Plugin description");
  if (manifest.homepage) {
    const homepage = new URL(manifest.homepage);
    if (homepage.protocol !== "https:") {
      throw new Error("A plugin homepage must use https.");
    }
  }

  const skills = definition.skills ?? [];
  unique(
    skills.map((skill) => skill.slug),
    "Skill slugs",
  );
  for (const skill of skills) {
    requireExtensionId(skill.slug, "Skill slug");
    requireLabel(skill.title, "Skill title");
    requireLabel(skill.summary, "Skill summary");
    requireLabel(skill.instructions, "Skill instructions");
  }
  unique(
    (definition.connectors ?? []).map((connector) => connector.manifest.id),
    "Connector ids",
  );
  return Object.freeze({
    ...definition,
    manifest: Object.freeze({ ...manifest }),
    skills: Object.freeze(
      skills.map((skill) => Object.freeze({ ...skill })),
    ) as unknown as SkillDefinition[],
    connectors: Object.freeze([
      ...(definition.connectors ?? []),
    ]) as unknown as ConnectorDefinition<unknown>[],
  });
}
