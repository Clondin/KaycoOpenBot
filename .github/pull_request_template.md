## Summary

<!-- What changes, and why does Kayco OpenBot need it? -->

## Change type

- [ ] Kayco product change
- [ ] Upstream-compatible fix
- [ ] Upstream synchronization
- [ ] Documentation or operations only

## Safety and compatibility

- [ ] I inspected the working tree and staged only files that belong to this change.
- [ ] I did not add credentials, tokens, customer data, transcripts, or local environment files.
- [ ] I reviewed auth, policy, approvals, audit, secret, migration, and deployment effects where applicable.
- [ ] I updated architecture, configuration, or fork documentation where behavior changed.

## Distributed-system behavior

OpenBot runs as several server processes behind a load balancer. Answer these even when the answer is
"none":

- [ ] New state outlives a request: where is it shared? A process-local `Map` or `Set` is not durable.
- [ ] A consecutive request can reach a second replica: what concrete outcome does it see?
- [ ] Concurrent writes are serialized by a unique index, conditional update, advisory lock, or equivalent.
- [ ] Browser fan-out reaches sockets held by other processes where applicable.
- [ ] New listeners, ports, and schedules use the shared ingress and tolerate multiple replicas.

Postgres is the default home for durable shared state. Every acting call must still resolve, decide,
audit, then act through the gateway; new refusals and failures must each write an audit row.

## Upstream synchronization

<!-- Complete this section only for an upstream synchronization. Do not squash the PR. -->

- Previous upstream commit:
- New upstream commit:
- Conflicts and their resolutions:
- Intentionally omitted or retained Kayco behavior:
- Migration or configuration impact:

## Validation

- [ ] `bun run format:check`
- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run build`

<!-- Record skipped checks and the reason. Integration tests require an isolated database. -->
