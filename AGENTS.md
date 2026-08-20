# Kayco OpenBot Repository Instructions

## Repository identity

This repository is **Kayco OpenBot**, a long-lived product fork of
[CopilotKit/openbot](https://github.com/CopilotKit/openbot). It is not a working
checkout for contributing directly to the upstream OpenBot repository.

- `origin` is the canonical Kayco repository: `Clondin/KaycoOpenBot`.
- `upstream` is the read-only original project: `CopilotKit/openbot`.
- Never push branches, tags, or releases to `upstream`.
- Product behavior and the decisions in [docs/fork.md](docs/fork.md) take
  precedence when they intentionally differ from upstream.
- Preserve the upstream MIT license and attribution.

## Working-tree safety

This repository often contains active product work.

- Inspect `git status --short --branch` before editing.
- Treat existing modified and untracked files as user work. Never discard,
  reset, overwrite, or include them in a commit without explicit authorization.
- Keep upstream synchronization separate from product feature work.
- Do not regenerate migrations, snapshots, route trees, patches, or lockfiles
  unless the task requires it.
- Stage files by exact path. Never use `git add .`, `git add -A`, or equivalent
  broad staging commands.

## Read before substantial changes

- [README.md](README.md) for the product and local setup.
- [docs/architecture.md](docs/architecture.md) for runtime and trust boundaries.
- [docs/fork.md](docs/fork.md) for fork ownership and intentional divergence.
- [docs/development.md](docs/development.md) for validation and migrations.

More-specific `AGENTS.md` files may add instructions for their subtree but may
not redefine repository identity, remote ownership, or upstream policy.

## Branches and publishing

- `origin/main` is the canonical, protected product branch.
- Do product work on focused branches based on the latest `origin/main`.
- Push only to `origin` and normally merge through a pull request.
- Do not force-push shared branches or rewrite `main` history.
- Keep generally useful upstream-compatible fixes separate from Kayco-only
  product changes so they can be contributed upstream independently.

## Upstream synchronization

Integrate upstream only through a dedicated synchronization branch and pull
request. Never merge upstream into a feature branch or a dirty working tree.

1. Confirm the tree is clean and fetch both remotes.
2. Start from the latest `origin/main`.
3. Create `sync/upstream-YYYY-MM-DD`.
4. Merge `upstream/main` with a merge commit; do not rebase or squash it.
5. Resolve conflicts using [docs/fork.md](docs/fork.md), preserving intentional
   Kayco behavior and security boundaries.
6. Run the validation appropriate to every affected package, including database
   migration checks when schemas changed.
7. Update the upstream baseline and sync log in `docs/fork.md`.
8. Push the branch only to `origin` and open a reviewed pull request.

Suggested commands:

```sh
git status --short --branch
git fetch origin --prune
git fetch upstream --prune
git switch main
git pull --ff-only origin main
git switch -c sync/upstream-YYYY-MM-DD
git merge --no-ff upstream/main
```

The synchronization pull request must retain the merge commit so Git records
which upstream history has already been integrated.

## Conflict policy

- Never resolve conflicts mechanically when they touch auth, credentials,
  policy, approvals, audit, computer isolation, migrations, or deployment.
- Prefer upstream bug fixes unless they undo a documented Kayco product choice.
- Preserve fail-closed authorization and secret-handling behavior.
- Review generated Drizzle migrations and snapshots as one unit with schema
  changes; never choose one side wholesale.
- If the intended behavior is unclear, stop and document the decision before
  completing the merge.

## Change design

- Prefer adapters, extension points, and new modules over broad rewrites of
  upstream-owned code.
- Keep product branding and deployment configuration isolated where practical.
- Record durable, intentional divergence in `docs/fork.md`; do not turn it into
  a per-commit changelog.
- Keep credentials, tokens, service-account data, customer data, transcripts,
  and local environment files out of source control.

## Validation

Use the smallest relevant checks while iterating, then the complete checks for
cross-cutting or upstream-sync changes:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Integration tests write to `DATABASE_URL`. Point them at an isolated test
database, never a development or production database that must be preserved.
