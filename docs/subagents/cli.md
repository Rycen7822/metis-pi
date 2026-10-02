# Subagent management

Run `python3 src/subagents/core/bin/subagent-pi --help` from the metis checkout
(or use the corresponding installed package path). Native Pi state is stored
in the effective Pi agent directory under `subagent-pi`.

Pass `--home <state directory>` before the subcommand. `list`, `inspect`, `result`,
`wait` and `doctor` read the existing state. Management operations such as
`close` and `respawn` require a stable `--request-id`; inspect any uncertain
operation before retrying it. `daemon stop` refuses active work without explicit
`--force`. Use the same state directory as the parent Pi adapter.

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

In the TUI, active subagents appear above the input box with their names and
states, including waiting for input. The list clears when work settles or the
parent session closes. Up to eight entries are shown, followed by a remaining
count; the footer keeps its running/total count. Click an entry to open its
read-only conversation overlay, with current state, tool activity and completed
messages. Use arrows, Page Up/Down or the mouse wheel to scroll; Esc closes the
overlay without stopping the agent or acknowledging its result. History uses
bounded event previews and does not show token-by-token streaming or images.

Linux/WSL, Python 3.11+, Node 22.19+ and Pi 1.0+ are required. Children use the
parent's Pi SDK and agent directory. Their default model is the parent's model
identity; provider definitions existing only in parent memory are unavailable to
an independent child. A task must contain its own instructions and context.

`access: "read"` permits Pi's built-in read/search tools, the search tools from
`@ff-labs/pi-fff` (including override names), and individual MCP tools declaring
`readOnlyHint: true` in an `mcp_*` namespace. Shell, editing, generic MCP gateways
and nested subagent control are blocked. This is a managed tool policy, not an
operating-system sandbox; loaded extensions retain their own capabilities.

Git installs and updates prepare the tool schema during `npm install`. For a
development checkout installed with `--ignore-scripts`, run
`npm run prepare:subagents`. `npm pack` also prepares the schema payload;
installed npm packages already contain it.
