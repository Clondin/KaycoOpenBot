# Hetzner backend deployment

This stack runs the private OpenBot backend on a dedicated Hetzner Cloud server while the React app
runs on Vercel. Only Caddy is public. PostgreSQL, the API process, the model agent, the supervisor,
and every Bot computer stay on a private Docker network.

## Before provisioning

- Use a new Ubuntu 24.04 server; do not reuse an unrelated server.
- Target a `ccx33` in Ashburn for the initial organization deployment: 8 dedicated vCPUs, 32 GB RAM,
  and 240 GB NVMe. Dedicated CPU is preferable to a higher shared-vCPU count for simultaneous
  Chromium workloads.
- The default resource budget gives each active Bot computer 3 GB RAM, 1.5 CPU cores, and 512
  processes. A 32 GB host has practical headroom for roughly 6-8 simultaneously active browser
  computers plus PostgreSQL and the platform services. If expected browser concurrency exceeds
  that, use a 64 GB dedicated-CPU server or split the computer supervisor onto worker hosts.
- Point a DNS `A` record such as `api.openbot.example.com` to the new server.
- Give the Vercel app a sibling custom domain such as `openbot.example.com`. Keeping the app and API
  under the same registrable domain avoids third-party-cookie restrictions.
- Allow inbound TCP 22, 80, and 443 and UDP 443 in the Hetzner Cloud Firewall. Do not expose ports
  3001, 4201, 4300, 5432, or any Bot-computer port.

## Configure

Install Docker Engine and the Compose plugin from Docker's official Ubuntu repository, then clone the
organization fork into `/opt/openbot`.

```sh
cd /opt/openbot
cp deploy/hetzner/env.example deploy/hetzner/env.production
chmod 600 deploy/hetzner/env.production
```

Generate independent secrets:

```sh
openssl rand -base64 32       # KEY_ENCRYPTION_KEY (must decode to exactly 32 bytes)
openssl rand -base64 48       # BETTER_AUTH_SECRET
openssl rand -hex 32          # POSTGRES_PASSWORD
openssl rand -hex 32          # COMPUTER_TOKEN
openssl rand -hex 32          # SUPERVISOR_TOKEN
```

Fill the remaining settings in `env.production`. In Google Cloud, register this redirect URI:

```text
https://api.openbot.example.com/api/auth/callback/google
```

## Build and start

The supervisor creates one browser-computer container per Bot. Build that image before starting the
normal services:

```sh
docker compose --env-file deploy/hetzner/env.production \
  -f deploy/hetzner/compose.yaml --profile images build agent-computer-image

docker compose --env-file deploy/hetzner/env.production \
  -f deploy/hetzner/compose.yaml up -d --build
```

Caddy obtains and renews TLS automatically. Verify the public boundary:

```sh
curl --fail https://api.openbot.example.com/health
```

## Connect Vercel

Set these Vercel production environment variables and redeploy the frontend:

```text
VITE_OPENBOT_PREVIEW=false
VITE_OPENBOT_API_URL=https://api.openbot.example.com
```

The API allows credentialed requests only from `OPENBOT_APP_ORIGIN`; WebSocket upgrades are checked
against the same allowlist. The browser never receives the model, Intelligence, database, computer,
or supervisor secrets.

## Operate

```sh
docker compose --env-file deploy/hetzner/env.production -f deploy/hetzner/compose.yaml ps
docker compose --env-file deploy/hetzner/env.production -f deploy/hetzner/compose.yaml logs -f server caddy
```

Back up PostgreSQL before upgrades. Hetzner server snapshots do not replace database backups, and
Bot workspaces and browser profiles are Docker volumes that need their own retention decision.
