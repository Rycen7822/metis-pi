# Subagent lifecycle

Metis owns the runtime under `src/subagents/core`. Each parent Pi session has its own scope. Reload reconnects the frontend; closing the parent does not silently kill background tasks. An interrupt stops the current work; close terminates the owned worker; respawn reuses its durable session without replaying old input.

After five consecutive seconds without active, queued or input-waiting runs, the shared daemon closes admission and parks its settled workers with verified cleanup, then exits. In-flight requests and notification sends finish first; unknown cleanup or active tools prevent automatic exit. Durable sessions, results and unread attention remain in the ledger. Explicit spawn/follow-up and other requested reads restart the daemon on demand; a passive watch or automatic parent synchronization does not keep an otherwise unused daemon alive or create a restart loop. The native frontend also releases an unused IPC helper without surrendering its logical session lease; reconnect cannot replace a later frontend owner.

Parent mailboxes use Codex-style safe streaming boundaries on Pi 1.0/1.1: after a completed thinking block or explicitly signed commentary block, the frontend claims pending attention and cancels only that provider request. The next model request receives the existing receipt-backed notification. Already-emitted tool calls are not preempted or replayed; final answers, unsigned text, failed/empty claims and unsupported hook ownership retain ordinary turn-end delivery. Genuine provider errors and user cancellation remain errors/cancellation, not successful yields. The saved notification records `samplingYield` for diagnostics, and question arrivals display one immediate UI notice per notification ID.

This is not token-by-token or instantaneous interruption: a long single thinking block still waits for its end, and a provider must honor request cancellation for draining to finish. No new configuration, provider, tool permission or model/thinking change is required. Reload/closing the frontend unregisters only its sampling owner without restoring over a later wrapper; background work and durable receipts keep their existing lifecycle.

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
Results ready during a tool turn enter the next model request before the final
reply. Later completions still wake an idle parent; delivered results do not repeat.
Inputs marked `not_consumed` after interruption are not replayed into a new task;
resend them explicitly if they are still wanted.
Status-only `list` queries preserve attention. Result files remain available for paging and rereading. Default wait and the
outstanding list include active and not-yet-delivered runs. Explicit run IDs can
always reread a result. An uncertain mutation is never retried automatically.
Native mutations save their generated operation identity and normalized arguments
in the Pi branch before dispatch. Retransmitting that invocation reuses its key;
transport failure exposes the same key instead of silently starting new work.
Name-based wait locks concrete run IDs before blocking. Automatic answers are
bound to a delivered question's run and worker generation and checked under the
agent lock. `send_message` remains store-only when idle; `followup_task` starts work.
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
inspection before reuse. When a killed guard cannot provide its descendant receipt,
remove all remaining descendants, inspect the owner generation, then use CLI
`close --confirm-cleanup GENERATION`. This records the operator's inspection;
it rejects live or unidentified owners and stale generations.

On Linux/WSL each worker guard adopts orphaned descendants, including detached
shell process groups, and reaps them before releasing its session lease. Cleanup
is verified from the guard's generation-specific receipt and process ownership.
If the guard is killed before confirming cleanup, the state remains unknown;
inspect remaining processes before reopening the workspace.

Children inherit the opening client's standard HTTP_PROXY, HTTPS_PROXY, ALL_PROXY,
NO_PROXY and lowercase equivalents, even with `childEnv=[]` or Codex inheritance
disabled. These routing values stay in the scope's memory, never its persisted
base environment or launches. Native Pi requests automatically rebind the authenticated parent's authorized environment and project trust after an idle restart; standalone clients must explicitly rebind their scope.
Other credential/environment names still require explicit `childEnv` authorization.
Profile environment overrides remain authoritative. Managed SDK startup configures
proxy-aware HTTP and WebSocket globals through public Undici APIs before extensions
load; Pi's global `httpProxy` supplies missing HTTP(S) proxy variables, and its
HTTP idle timeout applies to the dispatcher. NO_PROXY still permits direct traffic.

Backend capacity/timeouts/profiles/inheritance are read from global
`metis-pi.toml` at daemon startup; reload does not change a resident daemon's loaded
policy. The packaged TOML participates in its source fingerprint. Old standalone
provider JSON settings are not native frontend switches; migration reports
unsupported fields instead of silently pretending to enforce them.

Runtime upgrades and backend policy changes require letting work finish and waiting for verified idle shutdown, or closing resident children and stopping the daemon without `--force`, before reconnecting. Older daemons may lack automatic exit and must be stopped explicitly. A frontend reload reconnects and retains the parent session's scope; it does not upgrade a still-running daemon.

The native frontend checks the loaded backend's source fingerprint before every request, including updates within the same package version. A mismatch reports `version_mismatch` instead of silently using stale code; it never interrupts background work. A real automatic synchronization failure produces one warning and pauses watch/boundary/settlement RPCs for that frontend; explicit tools still report errors. A normal idle exit is silent and foreground activity resumes watching. Unknown mutation outcomes remain uncertain and are never automatically retried.
