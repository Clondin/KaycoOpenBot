# OpenClaw capability harvest

Kayco OpenBot borrows selected product patterns from
[OpenClaw](https://github.com/openclaw/openclaw) without importing OpenClaw as a
second runtime or trust boundary. The design review used OpenClaw commit
`c7b216edef00873126210b4c069e5b69f33a806c` as its pinned reference.

OpenClaw and OpenBot are both MIT-licensed. This implementation was written for
OpenBot's existing services and schema; it does not copy OpenClaw source. Keep
the pinned reference here so future maintainers can distinguish inspiration
from an untracked dependency and can reassess behavior against a known version.

## What was harvested

- **Always-on checks:** a routine can be a monitor with active hours and an
  exact quiet token. It uses the ordinary scheduler, durable task queue,
  approvals, and audit trail.
- **Channel gateway:** Telegram, Slack Events API, Discord interactions, and a
  generic signed webhook normalize into the ordinary task queue. External
  identities must be explicitly paired. Duplicate provider messages are
  idempotent, and replies leave through a leased, retrying outbox.
- **Skill Workshop:** completed work or a person can create a skill proposal.
  Proposals are scanned, hash-bound to both their proposed content and the
  installed base, reviewable, rejectable, and safely rollbackable. Nothing
  learns directly into an active skill.
- **Memory lifecycle:** possible durable memory enters a review inbox and joins
  active memory only after promotion.
- **Model failover:** unattended built-in runs can use a short, per-user model
  route. Only configured transient failure classes advance to a fallback; each
  attempt is visible and credentials remain in the vault.
- **Context hygiene:** small tool sets remain direct. Larger sets become a
  search/describe/call catalog over only the tools already granted to the Bot.
  Oversized results are bounded in the model context and stored as owner-scoped
  artifacts for 30 days.

## Boundaries intentionally not imported

OpenClaw's gateway process, session/auth model, browser control, cron engine,
and frontend are not used. OpenBot remains the authority for:

- signed-in user and Bot identity;
- channel membership and external identity pairing;
- encrypted credentials and outbound target validation;
- grants, CEL policy, approvals, and audit;
- isolated Bot computers;
- durable task leases, retries, and attempt ceilings;
- CopilotKit Intelligence conversation threads.

This matters because OpenClaw's documented security model assumes a trusted
single operator. Kayco OpenBot supports multiple users and shared coworkers, so
an external channel event can never be treated as the connection owner's action
until its provider signature and explicit identity pairing both pass.

## Provider setup contracts

- **Telegram:** store the bot token as a connector credential. Configure the
  returned inbound secret as Telegram's webhook `secret_token`.
- **Slack:** store JSON containing `botToken` and `signingSecret` as the
  connector credential. Requests use Slack's timestamped HMAC signature.
- **Discord:** store the Bot token as a connector credential and put the
  application's Ed25519 public key in the bridge settings.
- **Generic webhook:** send `Authorization: Bearer <inbound secret>`. An
  optional outbound HTTPS URL can receive replies; an optional vault credential
  becomes its bearer token.

Provider tokens and signing secrets must never appear in bridge settings,
source control, audit payloads, or chat transcripts.
