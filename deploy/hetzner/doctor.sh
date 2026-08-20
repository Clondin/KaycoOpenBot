#!/usr/bin/env bash
# Read-only production preflight and health report. It never prints secret values.
set -euo pipefail

cd "$(dirname "$0")/../.."
ENV_FILE="${1:-deploy/hetzner/env.production}"
OVERLAY=()
if [ "${2:-}" = "--single-user" ]; then
  OVERLAY=(-f deploy/hetzner/compose.single-user.yaml)
fi

pass() { printf '\033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '\033[33mWARN\033[0m  %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
setting() {
  local name="$1"
  grep -E "^${name}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r'
}

FAILED=0
if [ ! -f "$ENV_FILE" ]; then
  fail "$ENV_FILE does not exist."
  exit 1
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  pass "Docker Engine and Compose are available."
else
  fail "Docker Engine with the Compose plugin is required."
fi

permissions="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
if [ "$permissions" = "600" ] || [ "$permissions" = "400" ]; then
  pass "Production environment file is owner-only."
else
  warn "$ENV_FILE permissions are ${permissions:-unknown}; use chmod 600."
fi

if grep -Eq '=(replace-me|changeme|example)$' "$ENV_FILE"; then
  fail "The environment file still contains placeholder values."
else
  pass "No known placeholder values remain."
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/hetzner/compose.yaml "${OVERLAY[@]}")
if "${COMPOSE[@]}" config --quiet >/dev/null; then
  pass "Compose configuration resolves without missing variables."
else
  fail "Compose configuration is invalid."
fi

available_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
if [ "${available_kb:-0}" -ge 10485760 ]; then
  pass "At least 10 GB of disk is free."
else
  warn "Less than 10 GB of disk is free."
fi

memory_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || printf 0)"
if [ "${memory_mb:-0}" -ge 3500 ]; then
  pass "Host memory is ${memory_mb} MB."
else
  fail "Host memory is only ${memory_mb} MB; the single-user floor is 4 GB plus swap."
fi

api_host="$(setting OPENBOT_API_HOST)"
app_origin="$(setting OPENBOT_APP_ORIGIN)"
if [[ "$api_host" == api.* ]] && [[ "$app_origin" == https://* ]]; then
  pass "Public API host and HTTPS app origin are configured."
else
  warn "Use an API hostname and an HTTPS app origin."
fi

if "${COMPOSE[@]}" ps --status running --quiet 2>/dev/null | grep -q .; then
  if curl --fail --silent --show-error --max-time 10 "https://${api_host}/health" >/dev/null; then
    pass "Public API health endpoint answers over TLS."
  else
    fail "Public API health endpoint does not answer over TLS."
  fi
  migration="$("${COMPOSE[@]}" exec -T postgres psql -U openbot -d openbot -tAc \
    "select to_regclass('public.task_runs'), to_regclass('public.approval_requests')" 2>/dev/null | tr -d '[:space:]')"
  if [ "$migration" = "task_runs|approval_requests" ]; then
    pass "Durable task and approval migrations are applied."
  else
    fail "Durable task and approval tables are missing."
  fi
else
  warn "The stack is not running; live endpoint and migration checks were skipped."
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\nProduction checks failed. Fix the FAIL items before deploying.\n'
  exit 1
fi
printf '\nProduction checks passed. Review WARN items before organization use.\n'
