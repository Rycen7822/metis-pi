# Metis-maintained pi-lsp

Source: [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions), `packages/pi-lsp`, **@narumitw/pi-lsp 0.49.9**, commit `55d784704cdec1ec1534b59f78f07f139539119e`. Copyright (c) 2026 narumiruna; [MIT license](LICENSE) retained.

`extensions/lsp.ts` loads `pi-lsp.ts` directly. Root dependencies/checks own this source distribution; no standalone dependency, redundant index, generated dist, Docker build or reference checkout is required. [Public interface/configuration](../../docs/features/lsp.md) is maintained separately from the implementation notes below.

## Retained integration contracts

- One direct `lsp`, flat `action: diagnostics/fix` with paths/root/limit/server/path/write/kind; no old aliases or describe. Diagnostics accepts multiple servers, fix one and a required path; default preview, `/lsp` only views command availability.
- Global TOML `[lsp]` only: absent uses defaults, malformed errors, no project/legacy JSON fallback, init or migration. Explicit servers replace the catalog (empty disables it); preserve default 20000ms, argv/env/initialization/exclusions/settle/push/pull settings.
- Normalize config once. `config.ts` owns validation/catalog, `adapters.ts` construction/language discovery, `command.ts` platform launch translation.
- `lsp-client.ts` owns JSON-RPC/processes; `published-diagnostics.ts` owns canonical keys, publication versions and waiters. Failure drains both tables without merging completion policies; initialization/replies share the captured workspace.
- `runner.ts` opens/closes scoped documents and publishes fixes: open all diagnostic files before waits, close fix documents before write, retain cancellation checks and no scan-text cache.
- `code-actions.ts` selects enabled literal actions by kind; bare commands/disabled actions are informational, not resolved/applied. Enabled resolve errors propagate; server Command execution remains unsupported.
- Preserve extension routing, bounded discovery, missing-default skips versus explicit/custom errors, single-file preview/write, per-session ownership and awaited shutdown (including partial clients), Windows resolution, ty/Ruff configuration and rust-analyzer grace handling.

## Limits and updates

Name-only read-only policies must omit `lsp` or inspect action/write. Servers inherit Pi permissions; preview is not a sandbox. Sibling calls share one status key, fix writes do not use Pi's mutation queue, and model outputs are not independently bounded: aggregation did not fix these limits. Windows cmd.exe escaping/descendant cleanup require real Windows verification, not Linux fixtures.

Disable `npm:@narumitw/pi-lsp` before activation; Metis does not rewrite packages, and old JSON may be kept for standalone rollback. For upstream updates, compare the pinned commit, preserve these contracts/notices and run affected backend/tool/global-config/package-loader checks. LSP success never replaces repository lint/types/build/tests.
