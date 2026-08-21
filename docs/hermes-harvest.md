# Hermes capability harvest

Kayco OpenBot borrows selected product ideas from Hermes Agent without embedding
Hermes as a second runtime. OpenBot remains the authority for identity, grants,
policy, approval, audit, durable work, and computer isolation.

## Integrated natively

- **Context Vault:** owner-scoped, derived message indexing; exact search for
  people and Bots; anchored extractive recovery snapshots every 50 indexed
  messages. CopilotKit Intelligence remains the canonical transcript.
- **Workspace Time Machine:** pre-write checkpoints, bounded text comparison,
  selective rollback, protection for later human edits, and an inverse
  checkpoint that can undo a rollback.
- **Governed tool programs:** reviewed fixed sequences of already-granted tools.
  Every inner call keeps its original policy, approval, credential, and audit
  path. Intermediate output is retained in an inspectable trace; only the final
  output enters model context.
- **Workrooms and delegation trees:** up to six Bots in a shared channel with an
  explicit active responder; nested durable handoffs with depth, child,
  parallelism, runtime, review, pre-start steering, and stop-tree limits.
- **Skill health:** immutable content-hash versions, provenance, usage, stale and
  drift states, pinning, archive, and rollback.
- **Context references:** `@file`, `@folder`, `@diff`, `@result`, and `@url`
  references resolved through existing governed OpenBot APIs.
- **Routine safeguards:** preflight validation, pinned model metadata, tool
  allowlists, per-routine notepads, and deterministic execution through an
  approved tool program. Dollar ceilings are rejected until a provider reports
  enforceable, comparable per-run cost; write approvals stay in tool policy.
- **Bot bundles:** versioned persona, skill, routine, component, and model-default
  manifests. Keys that resemble secrets, credentials, grants, sessions,
  transcripts, or memory are rejected.

## Deliberately not imported

- Hermes gateway, SQLite session store, or runtime loop;
- host-executed plugins or arbitrary generated scripts;
- secret/session/history export;
- automatic LLM-authored skill mutation without a human review decision;
- context compression that can silently discard unanchored middle content.

These exclusions preserve Kayco's fail-closed authorization and keep one
auditable execution boundary.
