# Kayco OpenBot fork

## Identity and ownership

Kayco OpenBot is a long-lived product fork maintained at
[`Clondin/KaycoOpenBot`](https://github.com/Clondin/KaycoOpenBot). Its upstream
project is [`CopilotKit/openbot`](https://github.com/CopilotKit/openbot).

The fork preserves OpenBot's MIT license and attribution. Product releases,
branches, issues, and pull requests belong in the Kayco repository. The
`upstream` Git remote exists only to import improvements from the original
project.

| Role | Repository | Local remote | Write policy |
| --- | --- | --- | --- |
| Kayco product | `Clondin/KaycoOpenBot` | `origin` | Product branches and releases are published here. |
| Original project | `CopilotKit/openbot` | `upstream` | Fetch only; never push. |

## Upstream baseline

The fork currently contains upstream history through:

- Commit: `06a1a8417bce5343854060b8480eef37c0544143`
- Date: 2026-08-19
- Subject: `Take back the two features that only worked on one machine (#21)`

Git ancestry is the source of truth. Update this section only after an upstream
synchronization pull request has merged into `origin/main`.

## Intentional divergence

These are durable product directions, not a complete change log:

- **Deployment:** frontend-only Vercel previews and a production-oriented
  Hetzner deployment path.
- **Authentication:** OAuth support for hosted frontend/backend deployments,
  including secure cross-site cookies.
- **Model choice:** product-specific provider support, currently including
  Grok 4.6.
- **Governed work:** durable runs, approvals, routines, projects, memory,
  delegation, notifications, and user-facing work surfaces are active product
  development areas.
- **Conversation and team workflow:** persistent drafts, attachments, search,
  reactions, transcript screenshots, user-selected Codex settings, explicit
  browser handover, and safe portable coworker templates are Kayco product
  behavior.
- **Computer experience:** leased and prewarmed Bot computers, compact
  action-and-observe results, concurrent capacity with operator recovery,
  goal-and-step progress, batched form filling, structured table extraction,
  durable downloads, one adaptive reconnecting live screen, resizable takeover,
  and direct human paste/file transfer are Kayco product behavior.
- **Extensions and quality:** a versioned extension SDK, policy evaluations,
  and operational tooling are active product development areas.
- **Governed autonomy:** proactive monitors, paired external chat bridges,
  reviewed skill learning, memory promotion, model fallback routes, lazy tool
  discovery, and bounded tool-result artifacts are Kayco product behavior. See
  [the OpenClaw capability harvest](openclaw-harvest.md) for provenance and
  intentionally preserved boundaries.

When upstream changes overlap one of these areas, preserve the Kayco product
contract while incorporating compatible fixes and improvements. If a product
choice changes, update this document in the same pull request.

## Customization hotspots

Upstream synchronization deserves extra review in these areas:

- `server/src/app.ts` and `server/src/index.ts`: service composition and routes.
- `server/src/auth/`, `server/src/credentials.ts`, `server/src/computer/`, and
  `server/src/plugins/`: authentication, secrets, policy, approvals, and audit.
- `server/src/db/schema/` and `server/drizzle/`: schema and migration history.
- `app/src/lib/copilot/` and channel/work routes: runtime context and product UI.
- `deploy/`, `.env.example`, and `docs/configuration.md`: hosting contract.
- `sdk/`, `evals/`, and `worker/`: extension and evaluation contracts.
- Patched dependencies in `patches/` and `patchedDependencies` in
  `package.json`.

## Synchronization policy

Use a dedicated `sync/upstream-YYYY-MM-DD` branch based on `origin/main`, then
merge `upstream/main` with `--no-ff`. Do not rebase the product branch onto
upstream and do not squash an upstream synchronization pull request. Preserved
merge ancestry lets Git distinguish new upstream work from history already
integrated.

Every synchronization pull request must include:

- the old and new upstream commit IDs;
- a summary of upstream changes being imported;
- explicit notes for conflicts and intentionally omitted behavior;
- migration and configuration impact;
- validation results;
- an update to the baseline and log below.

## Synchronization log

| Integrated on | Upstream commit | Kayco merge/PR | Notes |
| --- | --- | --- | --- |
| 2026-08-19 | `06a1a8417bce5343854060b8480eef37c0544143` | `sync/upstream-2026-08-19` | Imported provider base URLs, queued follow-up turns, reliable Stop behavior, and the stalled-stream watchdog/audit trail. Preserved Kayco's durable approvals, Codex runtime, xAI support, governed runs, and deployment configuration. No database migration. |
| 2026-08-19 | `68cc78d8a30cbb2d44be070870ae45772907d385` | Initial fork baseline | Product fork established from the current upstream `main`. |

The scheduled `Upstream status` workflow opens or updates a GitHub issue when
new commits appear on `upstream/main`. It reports availability only; upstream
merges and conflict resolution remain deliberate, reviewed work.
