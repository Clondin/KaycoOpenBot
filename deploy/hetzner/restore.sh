#!/usr/bin/env bash
# Guarded database restore. Requires an explicit dump and acknowledgement.
set -euo pipefail

cd "$(dirname "$0")/../.."
ENV_FILE="${1:-}"
DUMP_FILE="${2:-}"
CONFIRM="${3:-}"
if [ -z "$ENV_FILE" ] || [ -z "$DUMP_FILE" ] || [ "$CONFIRM" != "--yes" ]; then
  printf 'Usage: %s <env.production> <backup.dump> --yes\n' "$0" >&2
  printf 'This replaces the OpenBot database. A safety backup is created first.\n' >&2
  exit 2
fi
if [ ! -f "$ENV_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  printf 'The environment file and backup dump must both exist.\n' >&2
  exit 2
fi
if [ -f "$DUMP_FILE.sha256" ]; then
  sha256sum --check "$DUMP_FILE.sha256"
fi

SAFETY_DIR="backups/pre-restore"
bash deploy/hetzner/backup.sh "$ENV_FILE" "$SAFETY_DIR"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/hetzner/compose.yaml)

"${COMPOSE[@]}" stop server agent-langgraph supervisor
trap '"${COMPOSE[@]}" up -d server agent-langgraph supervisor' EXIT
cat -- "$DUMP_FILE" | "${COMPOSE[@]}" exec -T postgres pg_restore \
  --username=openbot --dbname=openbot --clean --if-exists --no-owner --no-privileges
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d server agent-langgraph supervisor
trap - EXIT

printf 'Restore complete. Run deploy/hetzner/doctor.sh %s.\n' "$ENV_FILE"
