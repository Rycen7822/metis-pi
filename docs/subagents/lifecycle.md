# Subagent lifecycle

Metis owns the runtime under `src/subagents/core`. Each parent Pi session has its
own scope. Reload reconnects the frontend; closing the parent does not silently
kill background tasks. An interrupt stops the current work; close terminates the
owned worker; respawn reuses its durable session without replaying old input.

Managed children cannot replace, fork, reload or navigate their own sessions.
Access is a tool policy, not an operating system sandbox. Writer admission rejects
overlapping declared cwd subtrees; it does not constrain actual write paths.
Write tools, shell commands and extensions can write outside the declared cwd,
including another writer's directory. Assign separate workspaces and explicit
task boundaries, and treat stronger filesystem isolation as a separate requirement.
Queued input is not consumed input. Tool result delivery automatically consumes
the returned terminal notices; no separate confirmation is required. Pi consumes
only receipts saved to the parent's current session branch; standalone CLI/MCP
consumes after successful output. Failed delivery leaves attention pending.
Result files remain available for paging and rereading. Default wait and the
outstanding list include active and not-yet-delivered runs. Explicit run IDs can
always reread a result. An uncertain mutation is never retried automatically.
`completed` means the model stopped normally; acceptance still requires checking
the requested artifacts. Inspection usage counters are cumulative per run
(`token_scope=run_total`); `last_message_output` and `max_message_output` measure
individual assistant responses, not the run's total output or configured limit.
Answering an expired UI request returns `input_not_found` without waking the
worker or creating a new run. Local cwd preflight failures return structured
`invalid_cwd` errors before launch.

The per-scope limit covers live agents and workers whose cleanup is unverified.
Settled idle workers are parked automatically; retained history does not consume
capacity. Model and thinking configuration failures keep diagnostic identities
and results, and release their original name after verified cleanup.

A failed worker can be inspected with `pi_inspect_agent`; create a new agent with
`pi_spawn_agent` when its launch settings or saved session are unusable. A verified
parked/closed agent resumes via `pi_followup_task`. Unverified cleanup requires
inspection and the CLI `close` operation before reuse.

Runtime upgrades require draining work, closing resident children and waiting
for the daemon to finish shutting down before reconnecting. A frontend reload
reconnects the existing daemon and retains the parent session's scope.
The native frontend checks the loaded backend's source fingerprint, including
updates within the same package version. A mismatch reports `version_mismatch`
instead of silently using stale code; it never interrupts background work.
