import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { GrantedTool } from "../plugins/tools";
import type { EmbedTexts } from "./embeddings";

export type KnowledgeCitation = {
  chunkId: string;
  documentId: string;
  title: string;
  canonicalUrl: string;
  content: string;
  score: number;
};

export type KnowledgeSearchService = ReturnType<
  typeof createKnowledgeSearchService
>;

/** Hybrid full-text/vector retrieval with source ACLs enforced inside the SQL query. */
export function createKnowledgeSearchService(options: {
  database: Database;
  embed?: EmbedTexts;
  audit?: AuditStore;
}) {
  return {
    async search(
      actor: AgentActor,
      rawQuery: string,
      rawLimit = 6,
    ): Promise<KnowledgeCitation[]> {
      const query = Array.from(rawQuery.trim()).slice(0, 2_000).join("");
      if (!query) return [];
      const limit = Math.max(1, Math.min(Math.trunc(rawLimit), 12));
      const [user] = await options.database
        .select({ email: users.email, groups: users.groups })
        .from(users)
        .where(sql`${users.id} = ${actor.id}`)
        .limit(1);
      if (!user) return [];
      const email = user.email.toLowerCase();
      const domain = email.includes("@") ? email.split("@").at(-1) : null;
      const principals = [
        `user:${actor.id}`,
        `user:${email}`,
        "group:*",
        ...(domain ? [`group:domain:${domain}`] : []),
        ...user.groups
          .slice(0, 100)
          .map((group) => `group:${group.trim().toLowerCase()}`),
      ];
      const principalSql = sql.join(
        principals.map((principal) => sql`${principal}`),
        sql`, `,
      );

      let embedding: number[] | null = null;
      if (options.embed) {
        try {
          embedding = (await options.embed([query]))[0] ?? null;
        } catch (error) {
          console.warn(
            JSON.stringify({
              type: "knowledge-embedding-unavailable",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      const vector = embedding ? `[${embedding.join(",")}]` : null;
      const vectorScore = vector
        ? sql`greatest(0, 1 - (c.embedding <=> ${vector}::vector))`
        : sql`0::double precision`;
      const rows = await options.database.execute<{
        chunk_id: string;
        document_id: string;
        title: string;
        canonical_url: string;
        content: string;
        score: number;
      }>(sql`
        with ranked as (
          select c.id as chunk_id,
                 d.id as document_id,
                 d.title,
                 d.canonical_url,
                 c.content,
                 ts_rank_cd(
                   to_tsvector('simple', c.content),
                   websearch_to_tsquery('simple', ${query})
                 ) as lexical_score,
                 ${vectorScore} as vector_score
          from chunks c
          join documents d on d.id = c.document_id
          where d.deleted_at is null
            and exists (
              select 1 from document_acls allowed
              where allowed.document_id = d.id
                and allowed.effect = 'allow'
                and allowed.principal in (${principalSql})
            )
            and not exists (
              select 1 from document_acls denied
              where denied.document_id = d.id
                and denied.effect = 'deny'
                and denied.principal in (${principalSql})
            )
        )
        select chunk_id,
               document_id,
               title,
               canonical_url,
               content,
               (lexical_score * 0.35 + vector_score * 0.65)::float8 as score
        from ranked
        where lexical_score > 0 or vector_score > 0.15
        order by score desc, document_id, chunk_id
        limit ${limit}
      `);
      const citations = [...rows].map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        canonicalUrl: row.canonical_url,
        content: row.content,
        score: Number(row.score),
      }));
      if (options.audit) {
        await recordAuditEvent(options.audit, {
          actorUserId: actor.id,
          eventType: "knowledge.searched",
          targetType: "knowledge",
          payload: {
            queryHash: await sha256(query),
            results: citations.length,
            documentIds: citations.map((citation) => citation.documentId),
            semantic: Boolean(embedding),
          },
        });
      }
      return citations;
    },
  };
}

/** The retrieval capability offered to every coworker, with actor identity closed over server-side. */
export function knowledgeSearchTool(
  service: KnowledgeSearchService,
  actor: AgentActor,
): GrantedTool {
  return {
    name: "openbot_search_knowledge",
    description:
      "Search the organization's indexed knowledge. Results include source titles and canonical URLs that must be cited in the answer.",
    parameters: z.object({
      query: z.string().min(1).max(2_000),
      limit: z.number().int().min(1).max(12).optional(),
    }),
    execute: async (raw) => {
      const input = raw as { query?: unknown; limit?: unknown };
      if (typeof input.query !== "string") {
        return JSON.stringify({ error: "A search query is required." });
      }
      const citations = await service.search(
        actor,
        input.query,
        typeof input.limit === "number" ? input.limit : 6,
      );
      return JSON.stringify({
        citations: citations.map((citation, index) => ({
          citation: index + 1,
          title: citation.title,
          url: citation.canonicalUrl,
          excerpt: citation.content,
          score: Number(citation.score.toFixed(4)),
        })),
      });
    },
  };
}

async function sha256(value: string) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}
