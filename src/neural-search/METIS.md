# Metis-owned Neural Search

## Source and ownership

Derived from [FFF](https://github.com/dmtrKovalenko/fff) `@ff-labs/pi-fff` **0.11.0**, tag `v0.11.0`, commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5`; [MIT license](LICENSE) retained. `references/pi-fff/packages/pi-fff/` is ignored reference material, never a runtime/package input.

Metis owns this TS integration and the specialized Rust fork in `engine/`, not upstream editor/SDK compatibility. `extensions/neural-search.ts` is the host entry; root dependencies/builds own delivery. The engine source stays in Git; `native/`, bundled libraries/manifests/notices in `assets/` ship. No upstream FFF package/download is needed. Targets: Linux x64 glibc ≥2.31 and Windows x64, optional `ffi-rs` retained.

FFF owns find/grep/multi_grep ranking and frecency. [semantic/](semantic/README.md) separately owns CPU sgrep with Bekko 128D vectors / LateOn 48D token rows, complete-scope scoring and original ranking without FFF prefilter/frecency; Linux x64 runtime must be prepared separately. Both search locally. User API/limits belong in [the search guide](../../docs/features/neural-search.md), native contracts/builds in [engine/README](engine/README.md).

## Architecture

| Owner | Responsibility |
| --- | --- |
| `index.ts` | Pi composition/events/commands and one readonly action-map factory, not a native barrel. |
| `config.ts` | Global defaults/TOML validation and resolved database paths. |
| `session.ts` | cwd/session epochs, finder leases, scope selection and cursor invalidation, not query assembly. |
| `cursors.ts` | Typed continuation/request identity and bounded state. |
| `native/` | Finder/pool, path/filter codecs, content protocol/pages. |
| `native/binding/` | Private C ABI, ffi-rs decoding and operations. |
| `tools/` | Schemas, initial/fuzzy/resumed queries and formatted results; `semantic.ts` owns CLI/JSON/process cancellation. |
| `ui/` | Host autocomplete/provider adaptation and fallback widgets. |

Root TOML is the sole default source. Scoped factories capture scan policy and whitelist native fields: main creation may persist/fall back without DB, auxiliary creation bypasses both DBs, warnings and sticky fallback. `native/paths.ts` owns root/home policy and routing; DB paths stay configuration-owned. Native resources do not depend on tools/UI; concrete session adaptation stays in the application, not a generic framework.

## Local contracts

- One deferred action/params/describe tool and a short `metis_neural_search` directory. Discovery never auto-activates each turn; native tool_search enables direct use, codemode optional. `mentions` independently controls editor completion; historical tool-name rendering does not register aliases. Disable standalone `@ff-labs/pi-fff`.
- Global `[neuralSearch]` only, no legacy JSON/env/flags/name overrides. Default DB directories are `<agentDir>/metis/neural-search/{frecency,history}`; never import/move/delete editor/plugin DBs. Explicit paths are honored, access failure permits database-free search, oversized DBs are preserved/rejected. Reader-capacity override `METIS_NEURAL_SEARCH_LMDB_MAX_READERS` is separate (1024, minimum 126; no old alias).
- Semantic acquires no FFF finder. It runs absolute `bin/sgrep` with argv, shared service and protocol 1, not PATH/shell/query-time builds. Session/cancel/timeout terminates its own client group and confirms cleanup; the service cancels that request, not other clients. Errors never become empty hits/fallback actions. Ordinary CLI JSON is unchanged without host mode.
- Semantic integer tiers 256/512/1024 MiB (default 512) bind to a stable config-file stat snapshot and one HOME ledger; requested downgrade is not effective-policy proof. Display retains only complete ranked-prefix records; no FFF filters/cursors are accepted.
- Action lookup validates action/scope/request once; resource freshness is rechecked after awaits. Acquisition, DB fallback, request cancellation, auxiliary lifetime and cursor policy remain distinct.

## Native lifetime and autocomplete

Versioned binding promises survive jiti/Bun reevaluation, keyed by module location; rejected imports retry, scoped finders dispose independently. An auxiliary record owns pending/ready state and reservations; busy/pending leases are not evicted. One unref timer expires idle finders after five minutes; release restarts the deadline, returning later is cold. Continuations lease the original finder or fail, never substitute a replacement.

### Cancellation and native-query boundary

Cancelling a waiter does not abort shared initialization; a late lease is released. cwd/session/shutdown owns destruction, while synchronous native grep cannot be JS-interrupted. Full/subtree walkers cooperate with the owning shutdown token and discard cancelled partial candidates without reporting scan failures; they cannot abort an OS call.

A conflicting provider disables auxiliary integration and releases resources; managed children never regain excluded discovery tools. Autocomplete asks host navigation before index init, uses session epoch (not initial cwd) to invalidate wrappers, preserves same-session cwd rebinding and passes through replacement-session wrappers. Public writable triggerCharacters supports merged triggers and either skill-mux load order; quoted whitespace paths remain tested.

Sanitize untrusted display text before ANSI while retaining raw arguments/copy metadata. Keep numeric normalization even after schema validation; do not request discarded definition classification.

## Query encoding and pagination

### Paths and literals

`pathConstraintText` normalizes native separators/home/dot segments before routing/encoding while preserving existing absolute-file whitespace and POSIX literal backslashes. Physical containment is a separate policy; auxiliary reuse requires the **exact root**, since hidden/ignore/Git rules are root-relative. Space-containing directories may get separate finders, but unrepresentable filename/glob filters fail.

- Needles and filters cross ABI v7 separately: no token transport, whitespace split or second backslash-n decoding. One literal codec owns regex fallback; invalid regex retries once with original filters/LF encoding, NUL/blank inputs fail. Newline-free arrays use structured multiGrep; any real LF in arrays is rejected, single LF literals use escaped regex.
- Directory filters preserve `./`/absolute directory intent, basename globs get `./`; `stray/pkg.v1` cannot steal `./pkg.v1/`. Proven absolute files/exclusions take literal precedence before list scanning, even with glob syntax or commas; nonexisting paths stay patterns.
- Use native bracket literals for ordinary metacharacters. Brace paths need duplicated escaped alternatives: expansion decodes escapes before compilation, backslashes inside classes are data. Do not use singleton braces, UTF-8 bytes or `!` classes; use a safe ASCII class or duplicate UTF-only alternatives. Keep POSIX trailing backslashes.
- Split scalar lists only outside nested braces/classes (including initial literal `]`), honoring outside escapes. Array exclusions preserve internal whitespace until validation; existing scalar whitespace/comma/brace forms remain.

### Immutable results

Find's native offset is an item offset but ties are unstable across requests. Probe at most 100, then capture a complete immutable snapshot if needed; every page including first comes from it. Reject >10,000/changing/incomplete captures. Cursor storage caps 20,000 unique snapshot rows/200 tokens, shared snapshots counted once; row limits are not heap bounds. Fuzzy quality uses the original top score via action-owned `isWeakFind`, never a page-local score; exact globs bypass weak-fuzzy truncation, advertised hasMore requires a real cursor.

Content cursors retain the effective query/mode, immutable batch and unread-row offset before advancing whole-file native offsets. Matching and serialization share one revision/read lock; buffered/resumed rows and fuzzy suggestions verify that revision. Do not retag old batches after a writer or derive mode again from regex. Per-file cap facts are computed once, arrays not shared mutably; collection warnings persist until a fresh batch. Rescan does not reset revision, no-op mutable access conservatively advances it.

The native 200-match file cap may truncate, not promise further retrieval. Public pages cap at 50 content results / 100 find results; context rows merge with match precedence/indentation. Native LF capability and actual byte/context clipping independently report limitations; preserve blank-row coverage before terminator trimming. Do not infer them from JS regex syntax or claim per-occurrence multiline completeness. Report 500-character shortening and 2,000-line / 50 KiB body limits; paging cannot restore omitted display text. Fuzzy fallback retains all path/exclude filters.

## Pinned-engine corrections

[Engine maintenance](engine/README.md) owns scan readiness/failure, symlink/hidden/ignore policy, worktree identities, content-cache/owned-byte safety, regex revision and persistence contracts. Preserve these when porting from the pinned upstream; access/history storage and AI ranking/live indexing remain, unused SDK/editor/bigram machinery does not.

Native libraries are process-cached: update source/binding/manifest/library/notices together and **restart Pi**, not only reload. Missing library/ffi/ABI or unsupported platforms fail at index use, not discovery; ordinary install neither downloads nor builds.

## Verification

One-off diagnosis/migration/package probes belong in `.work/`. Verify real SDK discovery/direct calls/source-gated rendering/read-only policy, disposable native searches, input/cursor isolation and cleanup offline. Package checks must exclude references/standalone runtime imports; upstream updates preserve notices and intentionally port only still-needed behavior.
