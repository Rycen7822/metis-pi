# Metis-maintained pi-lsp

Upstream: https://github.com/narumiruna/pi-extensions

Source path: `packages/pi-lsp`, npm **@narumitw/pi-lsp 0.49.9**, commit
`55d784704cdec1ec1534b59f78f07f139539119e`.
Copyright (c) 2026 narumiruna; the upstream MIT license is retained in `LICENSE`.

Metis owns the source in this directory. `extensions/lsp.ts` loads it directly;
there is no standalone npm dependency or generated `dist` runtime. Temporary
upstream checkouts are reference material, not installation inputs. Dependencies
and verification are owned by the Metis root, not a nested package.

Local integration changes:

- Register one direct `lsp` tool with `action: "diagnostics" | "fix"` and compact,
  flat parameters: `paths`, `root`, `limit`, `server`, `path`, `write`, `kind`.
  Diagnostics accepts one server name or an array; fixes accept one name and
  require `path`. A fix previews by default (`write: false`). There are no
  `lsp_diagnostics` / `lsp_fix` aliases or deferred `describe` operation.
  `/lsp` remains the configured-command availability viewer.
- Read preferences only from Metis's global `metis-pi.toml`, under `[lsp]`.
  Project settings and global/project `pi-lsp.json` / `lsp.json` are not read,
  even when TOML is absent. There is no LSP-specific init or legacy-read bridge;
  users on other machines must copy their JSON values into TOML manually.
  Reads never modify configuration, and malformed TOML is an error rather than
  a reason to fall back to old JSON.
- Preserve the 20000ms default timeout and built-in server catalog. An omitted
  `servers` uses that catalog; an explicit server map replaces it, including
  `servers = {}` to disable all routes. Preserve argv commands, child environment
  overrides, initialization options, discovery exclusions and diagnostic
  settle/push/pull grace settings.
- `config.ts` owns global TOML reading, validation and the default server catalog;
  `adapters.ts` only constructs runtime adapters and language/discovery capabilities.
  Configuration fields are normalized once at the boundary.
- `lsp-client.ts` owns JSON-RPC and process lifetime; `published-diagnostics.ts`
  owns canonical document keys, publication versions and all grace/settle waiters.
  A failure drains both tables but their completion policies remain separate.
  Commands come from the adapter; initialization and workspace replies use the
  same captured workspace. Platform launch translation lives in `command.ts`.
- `runner.ts` owns scoped document opening/closing and fix calculation/publication.
  Open all diagnostic documents before awaiting results; close fix documents
  before writing; do not retain scan source text or bypass cancellation checks.
- `code-actions.ts` distinguishes literal actions from bare LSP commands and
  selects enabled actions by kind. Bare commands and disabled actions remain
  informational and are not resolved/applied; advertised enabled resolution
  errors still propagate. Server command execution is intentionally unsupported.
- `extensions/lsp.ts` loads `pi-lsp.ts` directly, without a redundant index forwarding
  module. Local TypeScript modules also load directly for native Node verification;
  do not restore the standalone build/Docker packaging paths.

Preserve backend behavior when updating: extension-based multi-server diagnostics,
missing-default-command skips, explicit/custom-command errors, bounded workspace
file discovery, single-file source actions, and preview-or-write edits. Retain
per-session call ownership, best-effort activity status, cancellation and awaited
shutdown (including partially initialized clients), Windows launcher resolution,
and the ty/Ruff workspace-configuration and rust-analyzer grace handling.

Aggregation changes permission granularity: a name-only allowlist cannot permit
only diagnostics while denying fix writes under the same `lsp` name. A policy
that needs that distinction must inspect `action` and `write`, or omit `lsp`.
Configured servers still run with Pi's permissions; preview is not a sandbox.

The retained Windows launcher uses the upstream cmd.exe translation. Its general
argument escaping and descendant-process cleanup need real Windows verification;
Linux fixtures do not prove those platform guarantees.

Known upstream limits remain: sibling calls share one status key, so one completion
can clear another's indicator; fix writes are not in Pi's shared mutation queue;
model-facing outputs are not independently bounded. Do not treat these limitations
as new normative test contracts or imply they were repaired by aggregation.

Before activating this entry, disable or remove `npm:@narumitw/pi-lsp` from Pi's
loaded packages to avoid duplicate `/lsp` registration and the old tool surface.
Metis does not change package settings automatically. Retain original JSON files
if needed for rollback to the standalone extension.

When adopting a new upstream version, compare against the pinned commit, preserve
these Metis interface/configuration boundaries, update provenance and notices,
and run the relevant backend, tool-contract, global-config and package/loader
checks. Repository-native format, lint, typecheck, build and tests remain the
completion checks; a clean LSP result does not replace them.
