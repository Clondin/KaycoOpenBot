# Production operations

Run every command from the repository root on the Hetzner server. Scripts never print secret values.

## Preflight and diagnosis

```sh
bash deploy/hetzner/doctor.sh deploy/hetzner/env.production
```

For the 4 GB profile, append `--single-user`. The doctor validates Compose interpolation, file permissions, placeholders, host resources, public TLS health, and required migrations. A warning is reviewable; a failure exits non-zero.

## Backups

```sh
bash deploy/hetzner/backup.sh deploy/hetzner/env.production /var/backups/openbot
```

This creates a private PostgreSQL custom-format dump and SHA-256 checksum. Copy both off the VPS. Schedule it with the host's timer system and test a restore quarterly.

Database backups include users, configuration, runs, approvals, audit data, connector state, and knowledge records. They do not include:

- Bot browser profile volumes, which contain live authenticated sessions and need encrypted, tightly controlled retention;
- Bot workspace volumes;
- the `codex-user-data` volume, which contains live per-user ChatGPT credentials and Codex thread state;
- `env.production` and its secrets;
- tenant package changes not committed to source control.

Decide retention for those separately. Never copy browser profiles to a less trusted location than the production host.

## Upgrade

1. Make a database backup and copy it off-host.
2. Record the current Git revision and image tag.
3. Fetch the reviewed source revision.
4. Build the computer image and service images.
5. Run the migration service.
6. Start the stack and run `doctor.sh`.
7. Verify Google login, one read-only task, one approval-gated task, and the audit trail.

Migrations are forward changes. Roll back application images only when the prior version is compatible with the migrated schema. Otherwise restore the pre-upgrade database dump with the matching source revision.

## Guarded restore

```sh
bash deploy/hetzner/restore.sh \
  deploy/hetzner/env.production \
  /var/backups/openbot/openbot-postgres-YYYYMMDDTHHMMSSZ.dump \
  --yes
```

Restore is destructive. The script verifies the checksum when present, makes another safety backup, stops application writers, restores, reapplies migrations, and starts services.

## Incident snapshot

Before restarting a failing service, capture:

```sh
docker compose --env-file deploy/hetzner/env.production -f deploy/hetzner/compose.yaml ps
docker compose --env-file deploy/hetzner/env.production -f deploy/hetzner/compose.yaml logs --since 30m server caddy supervisor > incident.log
df -h
free -h
```

Treat `incident.log` as sensitive: URLs, user ids, and operational metadata may be present even though credentials and typed secrets are intentionally excluded from application audit payloads.
