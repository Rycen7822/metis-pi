# metis-pi

**English** | [简体中文](README.zh-CN.md)

Codex-style transcripts and workflow extensions for Pi. **Metis 0.21.0 targets Pi 1.5.0 only**; Node.js **22.19.0+** is required.

## Installation

```bash
pi install .  # from a local checkout
# or: pi install git:git@github.com:Rycen7822/metis-pi.git
```

Restart Pi and select the `metis-pi` theme. Disable matching standalone providers first: `@howaboua/pi-codex-conversion`, `pi-web-access`, `pi-session-recall`, `@narumitw/pi-lsp`, and agent-stuff's BTW/commit/github/uv resources. Metis retains their original files and sessions; see [managed extensions](docs/features/managed-plugins.md) and [LSP](docs/features/lsp.md).

Use Pi package entry filters to disable features, for example `"extensions": ["-extensions/goal.ts"]` inside the package configuration. The [feature manual](docs/README.md) is currently in Chinese.

## Features

| Feature | Behavior |
| --- | --- |
| [Tool transcripts](docs/features/display.md) | Compact builtin tool rows, exploration groups, streaming write previews and diffs; third-party renderers remain native. |
| [Thinking](docs/features/display.md#思考块) | Latest 6 lines while streaming, folded on completion. Left-click toggles peek, right-click toggles full/closed; full ignores left-click. Ctrl+T stays native. |
| [Composer and status](docs/features/interface.md#输入区) | Gray composer, model/context, Working phases, live/calibrated output speed, usage and uncommitted changes. |
| [Selection copy](docs/features/selection-copy.md) | Fullscreen selections recover logical source text; unverifiable content falls back to native extraction. |
| [Long histories](docs/features/interface.md#全屏历史与留白) | Up to 5,000 retained display lines with paging and derived-cache release; original records remain intact. |
| [Goals](docs/features/goal.md) | `/goal` manages persistent objectives, timers, budgets and cross-turn continuation. |
| [BTW](docs/features/managed-plugins.md#btw-旁路对话) | Side conversation using the current Pi model/auth, with optional summary handoff. |
| [Multiple skills](docs/features/skills.md) | Expand multiple skills in one input and collapse them as one transcript entry. |
| [Bundled skills](docs/features/skills.md#随包-skills) | `ast-grep`, `commit`, `github`, `uv`; external CLIs are installed separately. |
| [MCP](docs/configuration.md#mcp) | Opt-in cached discovery, lazy connections and idle shutdown; native CLI/OAuth and permissions. |
| [Neural Search](docs/features/neural-search.md) | Deferred `neural_search`: native path/content search and CPU semantic search, discovered via `tool_search`. |
| [LSP](docs/features/lsp.md) | Direct `lsp` diagnostics/fix; fixes preview unless `write: true`. Read-only policies must inspect arguments, not just the tool name. |
| [Subagents](docs/subagents/native.md) | Durable native Pi children, deferred codemode tools, questions and completion wakeups. Requires Python 3.11+ and one active subagent provider. |
| [Execution](docs/execution.md) | Deferred PTY sessions; images use Pi `read` + `image()`. Pi owns providers and login. |
| [Dynamic agents](docs/features/dynamic-agents.md) | Next-run global instructions selected by provider/model; project rules and source files remain unchanged. |
| [Action Fusion](docs/features/action-fusion.md) | edit/write `then_run`: execute after successful mutation, retaining separate statuses, diffs and logs. |
| [Remote compaction](docs/features/codex-compaction.md) | Encrypted checkpoints for OpenAI/Codex, persistent replay and cross-model recovery. |
| [Condense](docs/features/condense.md) | Opt-in contextPrune, recoverable evidence and pressure/budget-gated summaries; token usage is tracked separately. |

Preferences live only in global `~/.pi/agent/metis-pi.toml` (or `PI_CODING_AGENT_DIR`), not project overrides. `/metis-config init` creates missing defaults and the [parameter guide](metis-pi-config.md), without importing or rewriting other settings. Edit existing TOML directly; omitted fields use [package defaults](metis-pi.toml). LSP JSON migration is manual; safely restart the subagent daemon after backend changes. `[appearance] enabled = false` disables display only. Pi keeps its model/theme/package/trust/MCP credential files. See [configuration](docs/configuration.md).

## Compatibility boundaries

- Only verified builtin tool origins are restyled. Unknown host shapes, foreign patches and immutable prototypes retain native behavior; `/codex-ui` reports why.
- Exact copy requires fullscreen application selections. Tables, unknown Markdown, images and terminal-native selections retain their documented fallbacks.
- The 5,000-line bound is a display-window limit, not a hard process-memory cap. Oversized components can still be laid out once; native search covers loaded history only.
- Editor/footer/Working replacements may conflict. Use one copy implementation rather than also enabling `pi-copy-soft-wrap`.
- Bundled PTY/FFF assets support Linux x64 (FFF: glibc ≥2.31) and Windows 10/11 x64; Windows needs Git Bash. Semantic search needs a separately prepared Linux x64 runtime. Exit Pi before updating loaded native assets.

See [compatibility](docs/compatibility.md) for contracts and limits; arbitrary plugin combinations are not guaranteed.

## Development

```bash
npm ci --ignore-scripts --bin-links=false --no-audit --no-fund
npm run verify
```

Use `npm run test:pty` for terminal journeys and `npm run preview` for static previews. [Development](docs/development.md) covers checks/build/release; [architecture](docs/architecture.md) maps owners; [CHANGELOG](CHANGELOG.md) records releases.

## Attribution and licenses

Derived from `pi-codex-style-tools` (MIT). Goal, BTW and commit/github/uv skills retain Apache-2.0 provenance; codex-conversion and LSP retain MIT provenance. See [NOTICE](NOTICE), [LICENSE](LICENSE) and [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0). This project is not affiliated with OpenAI or the Pi upstream.
