# Subagent lifecycle

Metis owns the runtime under `src/subagents/core`. Each parent Pi session has its
own scope. Reload reconnects the frontend; closing the parent does not silently
kill background tasks. An interrupt stops the current work; close terminates the
owned worker; respawn reuses its durable session without replaying old input.

Managed children cannot replace, fork, reload or navigate their own sessions.
Read access is a tool policy, not an operating system sandbox. Queued input is
not consumed input. Reading a result does not acknowledge it; ACK requires its
exact hash. An uncertain mutation is never retried automatically.

The per-scope limit covers live agents and workers whose cleanup is unverified.
Settled idle workers are parked automatically; retained history does not consume
capacity. Model and thinking configuration failures keep diagnostic identities
and results, and release their original name after verified cleanup.

Runtime upgrades require draining work, closing resident children and waiting
for the daemon to finish shutting down before reconnecting. A frontend reload
reconnects the existing daemon and retains the parent session's scope.
