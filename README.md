# metis-pi

**English** | [简体中文](README.zh-CN.md)

A compact, Codex-style transcript UI for Pi, with separate extensions for goals, todos, skill input, condense, and Codex conversion. Current version: **0.19.6**. Development and host checks target **Pi 0.87.0**.

## Installation

Requires Node.js >=22.19.0 and Pi >=0.87.0. From a local checkout, run:

```bash
pi install .
```

Restart Pi to load the changes, then select `metis-pi` in the theme picker. To install from Git, use `pi install git:git@github.com:Rycen7822/metis-pi.git`. This package includes codex-conversion; remove or disable the standalone `@howaboua/pi-codex-conversion` before installing to avoid duplicate tool registrations.

Individual features can be disabled through Pi's package entry filters, for example with `"extensions": ["-extensions/goal.ts"]` in the package configuration. See the [feature guide](docs/README.md) for details. The linked guides are currently in Chinese.

## Features

| Feature | Behavior |
| --- | --- |
| [Tool transcripts](docs/features/transcript.md) | Compact headers for built-in tools, grouped exploration, streaming write previews, and edit/write diffs. Third-party tools retain their own renderers. |
| [Thinking display](docs/features/thinking.md) | Shows the latest 6 lines while streaming, then collapses. Single-click toggles collapsed/peek; double-click toggles peek/expanded. Ctrl+T retains the host behavior. |
| [Composer and status](docs/features/composer.md) | Gray input area with model and context information. The [Working indicator and footer](docs/features/working-footer.md) show the execution phase, measured output speed, usage, and the amount of uncommitted changes. |
| [Selection copy](docs/features/selection-copy.md) | In fullscreen mode, maps selected display content back to logical source text. Falls back to native extraction for lines that cannot be verified. |
| [Long histories](docs/features/fullscreen-layout.md) | Keeps a window of up to 5,000 display lines, loads pages on demand, and releases derived caches. Original session records are retained. |
| [Todos](docs/features/todo.md) | Persistent workspace task lists with hierarchical numbering, dependencies, and a collapsible panel. Use `/todos` to view or restore the panel. |
| [Goals](docs/features/goal.md) | Use `/goal` to set persistent objectives, timers, and budgets, with continuation across turns based on goal status. |
| [Multiple skills](docs/features/skills.md) | Accepts multiple skills in one input, expands them into the host format, and groups them into a collapsed transcript entry. |
| [Codex conversion](docs/vendor-codex-conversion.md) | Bundled provider, native tools, and code/notebook modes, with source patches maintained in this repository. |
| [Dynamic agents](docs/features/dynamic-agents.md) | Select global instructions by provider/model from an external JSON file, applied at the next agent run. Replaces request context only; preserves project rules and source files. |
| [Action Fusion](docs/features/action-fusion.md) | Native edit/write and apply_patch support `then_run`: run a command after a successful edit, preserving separate statuses, diffs, and full logs. Also covers nested Code/Notebook entry points. Exclude `extensions/action-fusion.ts` to disable fusion across all entry points. |
| [Condense](docs/features/condense.md) | Bundles pi-condense 2.11.0 and uses its existing configuration. After each final reply, simplifies history before applying threshold-based summarization. Persists large outputs and supports paginated retrieval and summary usage display. |

Display settings are optional and live in `~/.pi/agent/metis-pi.json`. Invalid fields fall back according to the configuration rules; the display layer does not rewrite user files. Set `enabled: false` to disable the display layer; filter the separate goal/todo/condense/vendor entries individually. Display options and defaults are maintained in the [configuration reference](docs/configuration.md). Condense uses `contextPrune` in Pi's `settings.json`.

## Compatibility boundaries

- The display layer only takes over Pi built-in tools with a verified origin. It backs off for unknown host structures, third-party patches, or non-modifiable prototypes; see `/codex-ui` for the reason.
- Exact copying depends on application-managed selections in fullscreen mode. Markdown tables, unknown tokens, images, and similar content retain native fallbacks. Native terminal selections are outside this plugin's control.
- The 5,000-line limit applies to the retained display window. A single oversized component may still be fully laid out once, and native search only covers the loaded window.
- The main UI may conflict with other plugins that replace the editor, footer, or Working indicator. This package's exact copy path takes over the heuristic copying provided by `pi-copy-soft-wrap`; use only one implementation.
- Vendored native tools include only linux-x64 binaries. The upstream voice implementation has been removed; see the [conversion guide](docs/vendor-codex-conversion.md).

The [compatibility guide](docs/compatibility.md) documents host contracts. [VALIDATION.md](VALIDATION.md) records current checks and coverage gaps; it does not guarantee compatibility with every plugin combination.

## Development

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

Run `npm run test:pty` for visible interaction checks, or `npm run preview` for a static preview. See the [development guide](docs/development.md) for test scope, vendor builds, and documentation maintenance; [architecture](docs/architecture.md) for module responsibilities; and [CHANGELOG.md](CHANGELOG.md) for version changes.

## Attribution and licenses

Based on `pi-codex-style-tools`, retaining its MIT license. Goal-derived code comes from an Apache-2.0 upstream, and codex-conversion comes from an MIT upstream. See [NOTICE](NOTICE), [LICENSE](LICENSE), and [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) for attribution and modification notices. This project is not officially affiliated with OpenAI or the Pi upstream project.
