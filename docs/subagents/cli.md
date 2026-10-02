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
`/metis-subagents` shows status; `stop <agent>`, `continue <agent> <task>` and
`answer <agent>` provide explicit controls. Closing a question dialog does not
answer it. Another enabled subagent provider makes this entry stand down; choose
one provider with `pi config` and reload.

Linux/WSL, Python 3.11+, Node 22.19+ and Pi 1.0+ are required. Children use the
parent's Pi SDK and agent directory. Their default model is the parent's model
identity; provider definitions existing only in parent memory are unavailable to
an independent child. A task must contain its own instructions and context.

For a Git development checkout, run `npm run prepare:subagents`. `npm pack`
prepares the schema payload; installed npm packages already contain it.
