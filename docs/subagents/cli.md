# Subagent management

Run `python3 src/subagents/core/bin/subagent-pi --help` from the metis checkout
(or use the corresponding installed package path). Native Pi state is stored
in the effective Pi agent directory under `subagent-pi`.

Pass `--home <state directory>` before the subcommand. `list`, `inspect`, `result`,
`wait` and `doctor` read the existing state. Management operations such as
`close` and `respawn` require a stable `--request-id`; inspect any uncertain
operation before retrying it. `daemon stop` refuses active work without explicit
`--force`. Use the same state directory as the parent Pi adapter.

For a default native install, pass `--home ~/.pi/agent/subagent-pi`; a custom Pi
agent directory changes this path. `scope_not_found` reports the state directory
actually queried. Check `--home`/`PI_AGENTS_HOME` before opening a new scope.
The shell CLI defaults to XDG state and can otherwise query the independent
Codex installation's ledger. Separate daemons are expected for separate homes;
provider conflict detection applies to tools loaded in the same parent Pi session.

The independent Codex plugin remains a separate installation. This checkout
contains no Codex marketplace installer or standalone runtime npm dependency.

## Native Pi entry

The `extensions/subagents.ts` entry registers the ten `pi_*` daily tools. It keeps
Pi's current tool set; users can call the same tools through native codemode.
`/metis-subagents` lists this session's agents; select one to open its read-only
conversation. With no agents, it shows a short empty-state message.
`stop <agent>`, `continue <agent> <task>` and
`answer <agent>` provide explicit controls. Closing a question dialog does not
answer it. Another enabled subagent provider makes this entry stand down; choose
one provider with `pi config` and reload.

Subagent tool rows show compact operation, target and status summaries by default.
Use Ctrl+O or click a tool row to expand its full arguments and result. Errors keep
a short visible preview; wait timeouts, failed children and pending questions remain visible.

Runtime failures retain `isError: true` and `error.code/message` in structured
output. Native codemode resolves this value; check `result.isError` before using
success fields. `error.blocking_agent_id` identifies an existing conflicting
writer; `error.agent_id/run_id` identify a failed launch. Saved direct and nested
failure receipts consume attention without acknowledging the result. Unobserved
background failures still wake the parent.

An output-limit stop produces a `failed` run with an explicit error. Partial final
text remains readable; a thinking-only stop does not reuse an earlier preamble.
Output budgets follow Pi's `models.json` model `maxTokens` and remaining context,
without a separate Metis cap. Use the provider-supported budget for normal work;
small budgets belong in isolated test models. `pi_followup_task` can continue the task.

For an unusable failed worker, inspect its state and use `pi_spawn_agent` with
valid settings. `pi_followup_task` resumes a verified parked/closed agent; a missing
or empty saved session requires a new agent. Unverified cleanup needs the CLI
`close` operation with the correct `--home` before reuse.

In the TUI, active subagents appear above the input box as a tree with animated
running indicators, names, states, elapsed time, tool counts, tokens and current
tool activity. Agents waiting for input appear first. The list clears when work
settles or the parent session closes. It uses at most twelve lines, including
any remaining-agent count. Click either line of an entry to open its
read-only conversation overlay, with current state, tool activity and completed
messages. Use arrows, Page Up/Down or the mouse wheel to scroll; Esc closes the
overlay without stopping the agent or acknowledging its result. The overlay reads
bounded saved conversation history, with command highlighting and the same tool
and thinking fold controls as the main conversation. Click tools to expand or
collapse; click thoughts for a short preview or to collapse, and double-click for
full text. Ctrl+O toggles tools and Ctrl+T toggles thoughts. Choices survive refresh.
Reasoning is displayed only in the overlay, never added to parent tool results.
Token-by-token streaming and images are not displayed.

Linux/WSL, Python 3.11+, Node 22.19+ and Pi 1.0+ are required. Children use the
parent's Pi SDK and agent directory. Their default model is the parent's model
identity; provider definitions existing only in parent memory are unavailable to
an independent child. A task must contain its own instructions and context.

`access: "read"` permits Pi's built-in read/search tools, the search tools from
`@ff-labs/pi-fff` (including override names), and individual MCP tools declaring
`readOnlyHint: true` in an `mcp_*` namespace. Shell, editing, generic MCP gateways
and nested subagent control are blocked. This is a managed tool policy, not an
operating-system sandbox; loaded extensions retain their own capabilities.
Writer exclusivity checks declared cwd overlap at admission. It does not restrict
write/edit/bash, MCP or extensions to that directory; disjoint cwd declarations
do not provide filesystem isolation.

Git installs and updates prepare the tool schema during `npm install`. For a
development checkout installed with `--ignore-scripts`, run
`npm run prepare:subagents`. `npm pack` also prepares the schema payload;
installed npm packages already contain it.
