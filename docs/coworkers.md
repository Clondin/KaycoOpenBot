# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | AG-UI endpoint and optional key reference.                            |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, owner, visibility, and soft deletion. |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Intelligence mapping | `intelligence_channel_mappings` | Channel-to-thread mapping.                                            |

Package-provided agents are public and ownerless. User-created coworkers are owned by the creator.

## Standing role

Remote coworkers receive a system message derived from their title and role description:

```text
You are Expense Manager, Finance Operations.

Review receipts, categorize expenses, and prepare reimbursement reports.

This standing role applies in every channel. Treat channel messages as task-specific instructions within it.
```

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner and administrators.   |
| `public`   | Everyone in the deployment. |

Filtering happens in server/database queries. Package-provided agents cannot be edited or deleted through the product.

## Channels

Starting a channel creates a new conversation and Intelligence thread. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding is personal roster state. It removes the coworker from one user's list without disabling the coworker for anyone else.

## Team templates

The `/agents` page can export user-owned coworkers to a versioned Kayco team
template and import a template as new private coworkers. The portable file
contains only the team name and each coworker's name, title, and standing role.

The server discards unknown fields and never imports runtime ids, endpoints,
authorization headers, credentials, grants, messages, ownership, visibility,
browser state, or files. Imported coworkers receive new ids, use the managed
AG-UI endpoint, and stay private until their owner makes a separate sharing
decision. Name collisions receive an `(imported)` suffix. Imports are atomic
and limited to 25 coworkers.

## Default endpoint

Product-created coworkers use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui
```

The server requires this setting at startup. Package-provided agents use their own `agents.yaml` configuration.

## Register an external AG-UI agent

In `agents.yaml`:

```yaml
agents:
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: http://risk.internal/ag-ui
```

In the product, create or edit a coworker from `/agents` and set:

- name;
- title;
- role description;
- visibility;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.

`POST /api/agents/test-connection` checks whether an endpoint answers before saving it.

## Tool callback credential

A remote coworker can talk without a callback credential, but it needs one to use granted MCP tools. In the coworker's profile, choose **Generate token**, copy the token immediately, and configure the remote agent to send it as `x-openbot-agent-token` when it calls `/api/agent-tools/call`.

The token is shown once. Kayco stores only its hash, so a lost token must be rotated. Rotation immediately replaces the old token; revocation removes tool access without disabling conversation. The server also requires the signed `openbotRun` value supplied with that AG-UI run, which prevents one coworker from borrowing another coworker's grants or actor identity. For a channel task, that assertion also carries the server-validated task and channel identity so an MCP call can pause for approval and continue after the exact request is approved.

## Capabilities

A coworker's role does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- MCP tools are granted per Bot by administrators;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

See [architecture.md](architecture.md).

## Reference team

The example fintech package ships three production-oriented patterns in addition to the general, knowledge, and risk coworkers:

- **Research Analyst** separates facts, inferences, uncertainty, and recommendations with inline source evidence.
- **Operations Coordinator** turns requests into resumable work, prepares governed actions, and verifies outcomes.
- **Audit Reviewer** reconstructs runs and approvals as read-oriented findings without changing source systems.

Their standing prompts are intentionally specific about evidence and completion, while authority remains outside the prompt in grants, policy, approvals, and server-side action gateways.
