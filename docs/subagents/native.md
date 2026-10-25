# Native Pi subagents

Metis provides durable Pi workers through deferred `subagents_*` tools. Discover them with codemode/tool search. Each parent session owns a scope; workers retain sessions, results and delivery receipts across frontend reloads and verified idle shutdown.

## Requirements and configuration

- Linux/WSL or Windows, Python 3.11+, Node.js 22.19+ and Pi SDK 1.4.0. Children use the parent's SDK, Node executable and agent directory; Windows discovers installed Python through PATH or `py`.
- Global `[subagents]` controls registration, capacity, timeouts, `childEnv` and profiles. Backend policy is loaded at daemon startup.
- Profiles select tools, extensions, skills and optional model/thinking overrides. Read access is a tool policy, not an OS sandbox.
- Workers load and activate Pi's native `codemode` and `tool_search` when enabled. Scripted calls obey the same access and no-recursion rules; explicit extension/tool exclusions remain effective.
- Resolve registered model IDs and thinking capabilities before launch; do not guess them.

See the [parameter guide](../../metis-pi-config.md) and [lifecycle](lifecycle.md).

## Delegation skill

The enabled parent module exposes `subagent-delegation` through Pi resource discovery. Read it before assigning work: lightweight models generally benefit from explicit sequencing, while capable autonomous models can receive outcome-led tasks. Adjust to the task and observed behavior without changing permissions or model selection.

`enabled` controls tools, module guidance and skill exposure after reload. Disabling does not terminate running work or erase instructions already in the conversation.

## Workflow

| Tool | Purpose |
| --- | --- |
| `subagents_spawn_agent` | Start a bounded task with explicit ownership and expected evidence. |
| `subagents_wait_agent` | Wait for completion or questions. |
| `subagents_agent_result` | Read and page retained results. |
| `subagents_list_agents` / `subagents_inspect_agent` | Inspect state, history and receipts. |
| `subagents_answer_agent` | Answer a delivered question. |
| `subagents_followup_task` | Start more work using the saved worker session. |
| `subagents_send_message` | Queue a note; does not start idle work. |
| `subagents_interrupt_agent` | Stop current work, preserving history and possible partial filesystem effects. |

Use non-overlapping declared cwd subtrees for concurrent writers and explicit file boundaries. Admission does not constrain actual OS writes. Managed children cannot reload, fork, navigate or replace their own sessions.

Accepted input is not necessarily consumed input; normal completion is not acceptance of the artifacts. Inspect results and read all pages when `has_more=true`. Retry an operation ID only for the identical uncertain request, never to replay work automatically.

Click an active agent in fullscreen for its live, read-only transcript. `/subagents` also lists retained agents with their worker and latest task states; selecting an inactive agent opens its saved transcript, reads the available pages and stops polling. Tabs, scrollbar, wheel and navigation keys affect viewing only, not result acknowledgement.

Reopening a bound parent session restores saved results without starting a model turn or replaying tasks. Unconfirmed deliveries show a warning and status indicator. Use `/subagents` to inspect saved sessions; to deliver a retained result to the parent conversation, use `subagents_wait_agent` or `subagents_agent_result` with explicit run IDs. Native parent receipts confirm delivery.

## State and ownership

Private state lives at **`<agentDir>/metis/subagent/`**:

| Path | Content |
| --- | --- |
| `registry.sqlite` and sidecars | Scopes, agents, runs, requests and receipts. |
| `agents/<agentId>/` | Sessions, generation ownership and diagnostics. |
| `results/` | Immutable paged results. |

The ledger requires a Metis owner marker and supported schema; foreign state is rejected before writes. Source responsibilities are documented in [`src/subagents/README.md`](../../src/subagents/README.md).

Finish active work and wait for verified idle shutdown before changing an installed backend or its policy. Frontend reload reconnects the scope but cannot upgrade a running daemon. Inspect unknown ownership instead of clearing it or replaying uncertain work.
