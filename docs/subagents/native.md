# Native Pi subagents

Metis provides durable subagents through the `subagents` namespace in Pi. Tools are deferred: discover them through codemode/tool search before invoking them. A parent Pi session owns a scope; workers retain their own sessions, results and delivery receipts across frontend reloads and verified idle shutdown.

## Requirements and configuration

- Linux/WSL, Python 3.11+, Node.js 22.19+ and Pi SDK 1.3.0+.
- The child uses its parent's SDK, Node executable and agent directory.
- Global preferences are `[subagents]` in `<agentDir>/metis-pi.toml`. `enabled` controls registration; capacity, timeouts, `childEnv` and profiles are backend policy loaded at daemon startup.
- Profiles select built-in tools, extensions, skills and optional model/thinking overrides. Read access adds the native read-only tool policy; this is not an operating-system sandbox.
- The parent model and registered thinking capabilities are resolved before starting work. Do not guess model IDs or reasoning levels.

See the [parameter guide](../../metis-pi-config.md) and [lifecycle contracts](lifecycle.md).

## Workflow

Use `pi_spawn_agent` for a bounded independent task. Assign disjoint writes and explicit expected evidence. `pi_wait_agent` waits for completion or questions; `pi_agent_result` retrieves and pages results. Answer delivered questions with `pi_answer_agent`. Reuse an operation ID only for an identical uncertain request; never automatically replay a mutation whose response was lost.

Messages accepted by a worker are not necessarily consumed. Completed work means the model stopped normally; verify the requested artifacts before accepting it. Parent notifications count as delivered only after their receipt is saved to the active Pi session branch. Read all pages when a result has more content.

A follow-up resumes a cleanly parked worker from its saved session. Interruptions preserve history and can leave partial filesystem changes. Managed children cannot reload, fork, navigate or replace their own sessions. Declared workspace admission coordinates writers but does not confine OS write access.

## State and ownership

State is private to Metis at **`<agentDir>/metis/subagent/`**, normally **`~/.pi/agent/metis/subagent/`**:

- `registry.sqlite` and its SQLite sidecars: scopes, agents, runs, requests and delivery receipts.
- `agents/`: sessions, generation-specific ownership records and diagnostic logs.
- `results/`: immutable paged results.

The ledger requires the Metis native owner marker and current schema. An existing foreign or unsupported database is rejected before schema writes; it is not adopted or automatically upgraded. No other plugin's state directory is discovered or modified. The private `core/bin/metis-subagent` launcher only serves the native host and its daemon.

Let active work finish and wait for verified idle shutdown before changing an installed runtime or backend policy. Frontend reload reconnects to the same scope; it cannot upgrade a running daemon. Never clear an unknown process owner or replay uncertain work merely to make an upgrade proceed.
