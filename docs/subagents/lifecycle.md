# Subagent lifecycle

Python Runtime owns scheduling and the ledger; the JS worker owns a child Pi session. Parent coordination lives in `src/subagents/host`, presentation in `ui`. Each parent session has a scope; frontend reload reconnects it, and closing the frontend does not silently kill work.

## Idle shutdown and cleanup

After **30 consecutive idle seconds** without active, queued or input-waiting runs, the daemon closes admission, finishes in-flight requests and notifications, parks settled workers with verified cleanup, then exits. Unknown cleanup or active tools prevent automatic exit. Sessions, results and attention remain durable.

Explicit requests restart the daemon on demand; passive watches and automatic synchronization do not create restart loops. The frontend can release an unused IPC helper while retaining its logical session lease; reconnect cannot replace a later owner.

Interrupt stops current work; close terminates its owned worker. A verified parked/closed worker resumes from its saved session without replaying old input. Per-scope capacity includes live and cleanup-unverified workers, not retained history alone.

On Linux/WSL, a worker guard adopts and reaps orphaned descendants, including detached process groups. On Windows, the guard joins a private kill-on-close Job Object before launching Pi; process creation times and job membership establish ownership. Cleanup precedes releasing the session lease. A generation-specific receipt and OS ownership prove cleanup; unknown ownership is never cleared automatically.

## Notification and input delivery

| State | Contract |
| --- | --- |
| Accepted input | May still be queued; `not_consumed` input after interruption requires explicit resend if wanted. |
| Terminal result | Reading delivery consumes its notices only after receipts are saved to the active parent branch. Failed delivery leaves attention pending. |
| Status query | Preserves attention; default waits/outstanding lists include active and undelivered runs. |
| Retained result | Explicit run IDs support paging and rereading after delivery. |
| Uncertain mutation | Saved operation identity and normalized arguments are reused for identical retransmission; no automatic new work. |

Name-based wait locks concrete run IDs. Answers are bound to a delivered question, run and worker generation under the agent lock. Expired UI answers return `input_not_found` without waking work; invalid local cwd returns `invalid_cwd` before launch. `send_message` stores a note, while `followup_task` starts work.

Results ready during a tool turn enter the next request before the final reply; later completions wake an idle parent. `completed` means normal model stop, not successful acceptance. Inspection token counters are cumulative per run; `last_message_output` and `max_message_output` describe individual responses.

## Streaming and maintenance

At provider-supported safe boundaries—completed thinking or explicitly signed commentary—the frontend can claim pending attention and cancel that provider request. The next request receives receipt-backed notifications. Emitted tool calls are not preempted or replayed; final answers, unsigned text and unsupported hooks use turn-end delivery. Genuine errors and user cancellation remain errors/cancellation.

This is not token-by-token interruption: long thinking blocks wait for their end, and cancellation must drain. Questions show one immediate notice per notification ID; `samplingYield` records the handoff. Closing or reloading releases only that frontend's sampling owner.

Native compaction and summarization retries share an absolute maintenance window of `max(idle_timeout_seconds, 1800)` seconds. Nested retries do not extend it; the matching final end restores the ordinary idle budget. Settlement, cancellation and the next run clear maintenance state. This does not change Pi HTTP timeout or user settings.

## Access and environment

Managed children cannot replace, fork, reload or navigate their sessions. Read/write admission is not an OS sandbox: shell commands and extensions can write outside declared cwd. Use separate workspaces for writers when stronger isolation is needed.

Children inherit standard HTTP(S)/ALL/NO_PROXY variables and lowercase equivalents, even with `childEnv=[]`. Routing values remain in scope memory, not persisted base environment or launches. Other credential names require explicit `childEnv`; profile overrides win. Native authenticated requests rebind authorized environment and project trust after idle restart.

SDK startup configures proxy-aware HTTP and WebSocket globals before extensions. Pi `httpProxy` supplies missing HTTP(S) variables; HTTP idle timeout applies to the dispatcher, while NO_PROXY permits direct traffic.

## Configuration and upgrades

Global TOML capacity, timeouts and profiles are read at daemon startup. Let work finish and wait for verified idle shutdown before updating runtime or backend policy; frontend reload does not replace resident code.

Every request checks the backend source fingerprint, including same-package-version changes. `version_mismatch` reports a mismatch without interrupting work. Automatic synchronization failure warns once and pauses watch/boundary/settlement RPCs for that frontend; explicit tools still report errors. Normal idle exit is silent, and foreground activity resumes watching.

For unusable launch settings or saved sessions, inspect the failed worker and start a new agent. Verified parked workers use followup; cleanup-unverified workers require inspection before reuse.
