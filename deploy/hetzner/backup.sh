#!/usr/bin/env bash
# Consistent PostgreSQL backup with private permissions and a checksum.
set -euo pipefail
umask 077

cd "$(dirname "$0")/../.."
ENV_FILE="${1:-deploy/hetzner/env.production}"
OUTPUT_DIR="${2:-backups}"
if [ ! -f "$ENV_FILE" ]; then
  printf 'Environment file not found: %s\n' "$ENV_FILE" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$OUTPUT_DIR/openbot-postgres-$STAMP.dump"
TEMP="$TARGET.partial"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/hetzner/compose.yaml)

cleanup() { rm -f -- "$TEMP"; }
trap cleanup EXIT
"${COMPOSE[@]}" exec -T postgres pg_dump \
  --username=openbot --dbname=openbot --format=custom --no-owner --no-privileges >"$TEMP"
test -s "$TEMP"
mv -- "$TEMP" "$TARGET"
trap - EXIT
sha256sum "$TARGET" >"$TARGET.sha256"

printf 'Database backup: %s\n' "$TARGET"
printf 'Checksum:        %s.sha256\n' "$TARGET"
printf 'Browser profiles and Bot workspaces are separate Docker volumes and are not in this database backup.\n'
printf 'Connected ChatGPT credentials and Codex thread state are in codex-user-data and are not in this database backup.\n'
