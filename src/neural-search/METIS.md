# Metis-owned Neural Search

## Source and ownership

Derived from `@ff-labs/pi-fff` 0.11.0 in <https://github.com/dmtrKovalenko/fff>, tag `v0.11.0`, commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5`, under the MIT license retained in `LICENSE`.

The pristine, sparse reference checkout is `references/pi-fff/packages/pi-fff/`. It is ignored by Git and is not a runtime dependency or package payload. The installed component is the locally maintained TypeScript in this directory, loaded by `extensions/neural-search.ts`.

Metis owns the Pi integration, configuration, native finder lifetime, bounded auxiliary finders and cursors, editor autocomplete, maintenance commands, tool schemas and display. Do not reinstall the standalone Pi wrapper to update this component. Compare upstream changes against the pinned source, port intentionally and verify affected behavior before updating this provenance.

The Rust search implementation is not copied or reimplemented. `@ff-labs/fff-node` and `@ff-labs/fff-bun` remain pinned 0.11.0 dependencies, with platform binaries and FFI bindings managed by their packages. Only the available runtime binding is loaded. The product name does not imply embeddings, vector indexing or model-assisted semantic search; searches run locally.

## Architecture

```text
index.ts          Pi composition, events/commands, action-map factory
config.ts         Global preferences and owned database-path resolution
session.ts        Session/cwd lifetime, indexes, leases and cursor invalidation
cursors.ts        Bounded continuation state and checked action/request identity
native/           FFF binding, finder/pool, path/filter codec, content protocol/pages
tools/            Pi action schemas, execution/query orchestration and returned text
ui/               Autocomplete adaptation and native fallback widgets
```

The extension consumes the factory's readonly action map directly; there is no registration callback or second action registry. `index.ts` is the composition root, not a barrel for native internals. The bundled root TOML is the sole defaults source. The config boundary resolves database paths once; each scoped native factory captures one fixed policy and explicitly whitelists native fields, so database-free retries cannot inherit persistence paths.

`session.ts` selects and leases an index and returns its root/relative constraint. It does not assemble queries: action execution owns initial, fuzzy-fallback and resumed queries together. Cursor lookup validates action/scope/request once and returns the corresponding typed variant; resource freshness is still checked after asynchronous acquisition.

Native path routing and root/home scan policy share one owner in `native/paths.ts`; database paths belong to configuration, not routing. Native resource code does not depend on tool execution or TUI presentation. The concrete Pi session/UI adaptation remains in the application session owner; no generic host port or resource framework is added.

SDK cache policy, database fallback/scan cancellation, auxiliary leases/eviction and cursor validation remain separate because they have distinct lifetimes and failure semantics. Within the auxiliary pool, one record owns a resource through pending and ready states; reservation counts are never copied between collections. Continuations lease the original live finder or fail immediately, never initialize a replacement. Find cursors retain the complete immutable result snapshot and next page; content cursors retain the effective query and native batch progress. Both retain the original request and derive page/context/case settings rather than storing duplicate projections. No compatibility re-export files preserve the former flat layout; private consumers are migrated together.

## Local contracts

- One public, deferred `neural_search` entry, using the existing Metis `action` / `params` / `describe` envelope. File lookup, single-pattern grep and literal multi-pattern grep are inner actions, not separately registered tools.
- A short `metis_neural_search` prompt directory advertises the capability without its argument schemas. Pi's native `tool_search` can activate the entry for direct calls; codemode remains optional. Discovery must never auto-activate `neural_search` on every session or turn.
- Global `[neuralSearch]` in `metis-pi.toml` is the only preference source. No legacy JSON/env/flags, native tool-name override modes or old active aliases. `mentions` controls editor completion independently.
- State defaults to `<agentDir>/metis/neural-search/{frecency,history}`. Never automatically read, move, delete or migrate old plugin/editor databases. Explicit configured database paths are honored; initialization can fall back without persistence when database access fails.
- Preserve git/frecency order, path and exclusion semantics, smart case and regex fallback, bounded context/output, pagination and external-root lookup. Session/cwd changes and shutdown must not publish obsolete native finders or reuse another operation's cursor.
- Historical standalone tool names may still be rendered by Metis; that is not registration of executable aliases. When installing Neural Search, remove standalone `@ff-labs/pi-fff` to avoid duplicate tools/indexers.

## Cancellation and native-query boundary

Operation cancellation and scope lifetime are distinct. A private abortable wait lets one tool/command/autocomplete request stop waiting without aborting shared initialization. A lease arriving after its waiter is cancelled is released; shutdown/cwd/session changes still own actual finder destruction. Native synchronous grep itself is not interruptible by a JS signal.

The action adapter captures scan progress before querying and discloses incomplete initial indexing. Auxiliary results state the actual search root. Auxiliary reuse requires the exact scan root: hidden/ignore/git rules are root-relative, so physical containment cannot attest compatible coverage. Literal directories containing spaces can have their own finders; unrepresentable filename/glob filters are rejected explicitly. Dot segments are normalized before query encoding. Physical containment remains a separate routing policy.

`native/content.ts` owns the pinned content protocol: all literal searches, including native regex fallback, share one encoder. Newline-free arrays use structured multiGrep; arrays containing an embedded LF use escaped literal regex alternatives because native array transport itself splits on LF. Regex uses an escaped, whitespace-preserving text token. An internal literal-encoding failure is an explicit error, never an encoded-pattern fallback presented as literal evidence. Its immutable native batch plus unread-row offset supplies bounded intra-file pages before advancing the native file cursor. Reaching the 200-match per-file cap is disclosed as possible truncation, not a promise to retrieve further hits. Public page limits are enforced even without host validation.

The entry supplies a live ownership predicate: a conflicting provider disables auxiliary integration and disposes native resources. Managed children never regain a profile-excluded discovery builtin. Autocomplete delegates path navigation to the host before index initialization and gates stale wrappers by session ownership.

Autocomplete wraps the host's public provider contract, including writable triggerCharacters for the host's merged trigger assignment. Actual setup/editor tests cover both skill-mux/neural orders and earlier custom triggers. Do not remove numeric safety normalization merely because the dispatcher also validates/coerces schema inputs. The driver does not request unused definition classification that is discarded from both published text and details.

## Pinned-engine corrections

FFF 0.11.0 requires local integration corrections, verified against the real bindings:

- `fileSearch.pageIndex` is an item offset, but repeated offset requests have unstable tie boundaries. Find probes with at most100 rows, then captures the complete query once when continuation is needed. Every displayed page, including the first, comes from that snapshot. Refuse more than10,000 matches before a large native request; reject changing/incomplete capture rather than invent a cursor. Cursor storage retains at most20,000 unique find-snapshot rows and200 tokens, counting shared snapshots once; these are row bounds, not a heap-byte guarantee.
- The content-index prefilter can omit valid OR matches; owned finders disable content indexing, retaining mmap caching and native order. Correctness takes precedence over that optimization.
- Bun ABI v1 ignores `followSymlinks`; Bun uses the Node binding when following links is enabled, and Bun-with-Node-fallback otherwise. SDK caching is keyed by binding policy, not by the first session that happens to load it.
- Directory filters use explicit globs; `./` and absolute-path normalization preserve directory meaning. Basename globs in path/exclude gain a canonical `./` prefix, ensuring content and file queries both recognize them as filters. A file such as `stray/pkg.v1` must not redirect a request for `./pkg.v1/` away from `pkg.v1/inside.ts`.
- Native grep page size is a whole-file soft limit, not an output bound. Retain unread batch rows, cap displayed pages at50, and disclose per-file collection limits. Find pages are capped at100; exact glob filters bypass weak-fuzzy truncation. Grep text truncation preserves source indentation.

Engine packages are optional dependencies so an unsupported native platform does not prevent installation of unrelated Metis functionality. Missing bindings fail explicitly when an index is requested, not during tool discovery.

## Verification

New diagnosis, migration and acceptance fixtures belong under `.work/`, not in permanent test discovery. Verify the native SDK request surface before and after discovery, direct execution, source-gated rendering and readonly subagent policy, real native search over disposable files, input/cursor isolation and resource cleanup. Keep checks offline; use the final package contents to verify no runtime import points into `references/` or an installed standalone plugin.
