# metis-pi

**English** | [简体中文](README.zh-CN.md)

A compact, Codex-style transcript UI for Pi, with separate extensions for goals, skill input, condense, and execution tools. Current version: **0.21.0**. Development and host checks target **Pi 1.3.0**.

## Installation

Requires Node.js >=22.19.0 and Pi >=1.3.0. From a local checkout, run:

```bash
pi install .
```

Restart Pi to load the changes, then select `metis-pi` in the theme picker. To install from Git, use `pi install git:git@github.com:Rycen7822/metis-pi.git`. This package provides independent execution tools; remove or disable the standalone `@howaboua/pi-codex-conversion` before installing to avoid duplicate tool registrations.

Metis also maintains bundled `pi-web-access`, `pi-session-recall`, and `@narumitw/pi-lsp` sources. Remove or disable their standalone npm entries before activating Metis to avoid duplicate tools or `/lsp` commands; original files and sessions are retained. See the [managed extensions guide](docs/features/managed-plugins.md) and [LSP guide](docs/features/lsp.md).

Individual features can be disabled through Pi's package entry filters, for example with `"extensions": ["-extensions/goal.ts"]` in the package configuration. See the [feature guide](docs/README.md) for details. The linked guides are currently in Chinese.

## Features

| Feature | Behavior |
| --- | --- |
| [Tool transcripts](docs/features/display.md) | Compact headers for built-in tools, grouped exploration, streaming write previews, and edit/write diffs. Third-party tools retain their own renderers. |
| [Thinking display](docs/features/display.md#思考块) | Shows the latest 6 lines while streaming, then collapses. Left-click toggles collapsed/scrollable preview; right-click toggles fully expanded/closed. Fully expanded ignores left-click. Ctrl+T retains the host behavior. |
| [Composer and status](docs/features/interface.md#输入区) | Gray input area with model and context information. The [Working indicator and footer](docs/features/interface.md#统计口径) show the execution phase, measured output speed, usage, and the amount of uncommitted changes. |
| [Selection copy](docs/features/selection-copy.md) | In fullscreen mode, maps selected display content back to logical source text. Falls back to native extraction for lines that cannot be verified. |
| [Long histories](docs/features/interface.md#全屏历史与留白) | Keeps a window of up to 5,000 display lines, loads pages on demand, and releases derived caches. Original session records are retained. |
| [Goals](docs/features/goal.md) | Use `/goal` to set persistent objectives, timers, and budgets, with continuation across turns based on goal status. |
| [Multiple skills](docs/features/skills.md) | Accepts multiple skills in one input, expands them into the host format, and groups them into a collapsed transcript entry. |
| [ast-grep skill](docs/features/skills.md#随包-skills) | Bundled structural code-search guidance and rule reference, discovered by Pi and updated with Metis. Requires `ast-grep` on PATH; no automatic CLI installation or extra service. |
| [MCP](docs/configuration.md#mcp) | Optional Pi-native MCP integration: cached directory, lazy connections and idle shutdown; shares native CLI/OAuth and tool permissions. Disabled by default. |
| [LSP](docs/features/lsp.md) | One direct `lsp` tool with `action: diagnostics/fix`, flat parameters and preview-by-default fixes; `/lsp` checks configured command availability. Name-only read-only allowlists need an argument-level policy to distinguish writes. |
| [Subagents](docs/subagents/native.md) | Metis-owned durable Pi children, deferred native tools discovered/called through codemode, explicit questions and completion wakeups. Linux/WSL with Python 3.11+; choose one subagent provider in Pi config. |
| [Execution tools](docs/execution.md) | Deferred PTY tools for Pi native codemode; ordinary images use Pi `read` + `image()`. Pi owns providers and login. |
| [Dynamic agents](docs/features/dynamic-agents.md) | Select global instructions by provider/model from an external JSON file, applied at the next agent run. Replaces request context only; preserves project rules and source files. |
| [Action Fusion](docs/features/action-fusion.md) | Native edit/write support `then_run`: run a command after a successful edit, preserving separate statuses, diffs, and full logs. Also supports Pi native codemode calls. Exclude `extensions/action-fusion.ts` to disable fusion across all entry points. |
| [OpenAI / Codex remote compaction](docs/features/codex-compaction.md) | ChatGPT OAuth keeps development on `openai` and uses legacy Codex OAuth for encrypted compaction; API keys use `/responses/compact`, and Codex sessions use Remote V2. |
| [Condense](docs/features/condense.md) | Opt-in history condensation using contextPrune. Measures mechanical replacements independently; paid summaries need pressure and complete-message proxy budgets. Deferred evidence stays recoverable. Supports paginated retrieval and token-only summary usage. |

All Metis-owned preferences use one global `~/.pi/agent/metis-pi.toml` (honoring `PI_CODING_AGENT_DIR`), with no project Metis overrides. When TOML is absent, run `/metis-config init` to import legacy global settings and install the adjacent [parameter guide](metis-pi-config.md); originals are retained. Edit existing TOML directly; omitted settings use package defaults. LSP reads only `[lsp]`; copy legacy LSP JSON values into it manually, as init does not import them. Subagent backend preferences also use `[subagents]`; safely drain/restart its daemon to apply them. The bundled [TOML template](metis-pi.toml) contains all defaults. Set `[appearance] enabled = false` to disable only display; Pi-owned model/theme/package/MCP credentials remain in their own files. See the [configuration reference](docs/configuration.md).

## Compatibility boundaries

- The display layer only takes over Pi built-in tools with a verified origin. It backs off for unknown host structures, third-party patches, or non-modifiable prototypes; see `/codex-ui` for the reason.
- Exact copying depends on application-managed selections in fullscreen mode. Markdown tables, unknown tokens, images, and similar content retain native fallbacks. Native terminal selections are outside this plugin's control.
- The 5,000-line limit applies to the retained display window. A single oversized component may still be fully laid out once, and native search only covers the loaded window.
- The main UI may conflict with other plugins that replace the editor, footer, or Working indicator. This package's exact copy path takes over the heuristic copying provided by `pi-copy-soft-wrap`; use only one implementation.
- The bundled native PTY helper is linux-x64 only. See the [execution guide](docs/execution.md) for the retained tools.

The [compatibility guide](docs/compatibility.md) documents host contracts and limits; it does not guarantee compatibility with every plugin combination.

## Development

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

Run `npm run test:pty` for visible interaction checks, or `npm run preview` for a static preview. See the [development guide](docs/development.md) for test scope, source checks, and documentation maintenance; [architecture](docs/architecture.md) for module responsibilities; and [CHANGELOG.md](CHANGELOG.md) for version changes.

## Attribution and licenses

Based on `pi-codex-style-tools`, retaining its MIT license. Goal-derived code comes from an Apache-2.0 upstream; codex-conversion and the maintained LSP module come from MIT upstreams. See [NOTICE](NOTICE), [LICENSE](LICENSE), and [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) for attribution and modification notices. This project is not officially affiliated with OpenAI or the Pi upstream project.
