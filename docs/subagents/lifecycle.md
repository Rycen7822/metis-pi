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
Queued input is
not consumed input. Reading a result does not acknowledge it; ACK requires its
exact hash. An uncertain mutation is never retried automatically.

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
