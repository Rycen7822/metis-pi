# Metis-owned Neural Search

## Source and ownership

Derived from `@ff-labs/pi-fff` 0.11.0 in <https://github.com/dmtrKovalenko/fff>, tag `v0.11.0`, commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5`, under the MIT license retained in `LICENSE`.

The pristine, sparse reference checkout is `references/pi-fff/packages/pi-fff/`. It is ignored by Git and is not a runtime dependency or package payload. The installed component is the locally maintained TypeScript in this directory, loaded by `extensions/neural-search.ts`.

Metis owns the Pi integration, configuration, native finder lifetime, bounded auxiliary finders and cursors, editor autocomplete, maintenance commands, tool schemas and display. Do not reinstall the standalone Pi wrapper to update this component. Compare upstream changes against the pinned source, port intentionally and verify affected behavior before updating this provenance.

Metis also maintains the necessary Rust engine closure in `native/neural-search/`, its reduced Linux `ffi-rs` binding in `native/binding/`, and the built library plus provenance/notices under `assets/neural-search/`. No upstream FFF npm package or binary download remains. The engine is a Metis-specialized Rust fork of 0.11.0, with the original zlob semantics and existing LMDB format. It retains AI search/ranking and live indexing, not upstream editor/SDK compatibility. Delivery targets Linux x64 glibc >=2.31 only; other platforms are out of scope. See `native/neural-search/README.md` at the repository root for builds and redistribution. The product name does not imply embeddings, vector indexing or model-assisted semantic search; searches run locally.

## Architecture

```text
index.ts          Pi composition, events/commands, action-map factory
config.ts         Global preferences and owned database-path resolution
session.ts        Session/cwd lifetime, indexes, leases and cursor invalidation
cursors.ts        Bounded continuation state and checked action/request identity
native/           Finder/pool, path/filter codec, content protocol/pages
native/binding/   Owned Linux C-ABI types, ffi-rs decoding and finder operations
tools/            Pi action schemas, execution/query orchestration and returned text
ui/               Autocomplete adaptation and native fallback widgets
```

The extension consumes the factory's readonly action map directly; there is no registration callback or second action registry. `index.ts` is the composition root, not a barrel for native internals. The bundled root TOML is the sole defaults source. The config boundary resolves database paths once; each scoped native factory captures shared scan policy and explicitly whitelists native fields. Main creation may use persistence and database-free fallback; auxiliary creation always bypasses both DB paths, warnings and sticky fallback state.

`session.ts` selects and leases an index and returns its root/relative constraint. It does not assemble queries: action execution owns initial, fuzzy-fallback and resumed queries together. Cursor lookup validates action/scope/request once and returns the corresponding typed variant; resource freshness is still checked after asynchronous acquisition.

Native path routing and root/home scan policy share one owner in `native/paths.ts`; database paths belong to configuration, not routing. Native resource code does not depend on tool execution or TUI presentation. The concrete Pi session/UI adaptation remains in the application session owner; no generic host port or resource framework is added.

SDK cache policy, database fallback/scan cancellation, auxiliary leases/eviction and cursor validation remain separate because they have distinct lifetimes and failure semantics. Versioned global binding promises survive jiti/Bun reevaluation, keyed by the module location; rejected imports remain retryable. Finder instances are still scoped and disposed independently. Within the auxiliary pool, one record owns a resource through pending and ready states; reservation counts are never copied between collections. Continuations lease the original live finder or fail immediately, never initialize a replacement. Find cursors retain the complete immutable result snapshot and next page; content cursors retain the effective query and native batch progress. Both retain the original request and derive page/context/case settings rather than storing duplicate projections. No compatibility re-export files preserve the former flat layout; private consumers are migrated together.

## Local contracts

- One public, deferred `neural_search` entry, using the existing Metis `action` / `params` / `describe` envelope. File lookup, single-pattern grep and literal multi-pattern grep are inner actions, not separately registered tools.
- A short `metis_neural_search` prompt directory advertises the capability without its argument schemas. Pi's native `tool_search` can activate the entry for direct calls; codemode remains optional. Discovery must never auto-activate `neural_search` on every session or turn.
- Global `[neuralSearch]` in `metis-pi.toml` is the only preference source. No legacy JSON/env/flags, native tool-name override modes or old active aliases. `mentions` controls editor completion independently.
- State defaults to `<agentDir>/metis/neural-search/{frecency,history}`. Never automatically read, move, delete or migrate old plugin/editor databases. Explicit configured database paths are honored; initialization can fall back without persistence when database access fails. Oversized databases are preserved and rejected, not automatically erased. The low-level reader-capacity override is `METIS_NEURAL_SEARCH_LMDB_MAX_READERS` (default 1024, valid >=126); the old FFF name is not an alias. It does not import preferences or introduce a second TOML schema.
- Preserve git/frecency order, path and exclusion semantics, smart case and regex fallback, bounded context/output, pagination and external-root lookup. Session/cwd changes and shutdown must not publish obsolete native finders or reuse another operation's cursor.
- Historical standalone tool names may still be rendered by Metis; that is not registration of executable aliases. When installing Neural Search, remove standalone `@ff-labs/pi-fff` to avoid duplicate tools/indexers.

## Cancellation and native-query boundary

Operation cancellation and scope lifetime are distinct. A private abortable wait lets one tool/command/autocomplete request stop waiting without aborting shared initialization. A lease arriving after its waiter is cancelled is released; shutdown/cwd/session changes still own actual finder destruction. Native synchronous grep itself is not interruptible by a JS signal.

The action adapter captures scan progress before querying and discloses incomplete initial indexing. Auxiliary results state the actual search root. Auxiliary reuse requires the exact scan root: hidden/ignore/git rules are root-relative, so physical containment cannot attest compatible coverage. Literal directories containing spaces can have their own finders; unrepresentable filename/glob filters are rejected explicitly. `pathConstraintText` owns native separator normalization, home expansion and absolute-whitespace preservation before both routing and query encoding; POSIX literal backslashes remain data. Dot segments are normalized before query encoding. Physical containment remains a separate routing policy.

`native/content.ts` owns one literal encoder, including regex fallback.
Newline-free arrays use structured multiGrep.
By explicit user decision, arrays containing any real LF fail with split-query guidance; a single LF literal uses escaped regex encoding, not extra OR items.
Needles and filters cross private ABI v6 separately: no token transport, whitespace split or second backslash+n decoder.
Literal backslashes/source whitespace remain data, invalid-regex fallback reuses the original literal, and NUL inputs fail explicitly.

One compiled native regex owns its matcher and LF capability, derived from the same native syntax and flags; no per-line secondary content scan is used.
By-line `nativeMultilineLimited` is conservative for LF-capable expressions, even when only an ordinary branch matches; coalesced blank-row coverage is retained before terminator trimming.
The emitted batch separately carries actual `nativeOutputTruncated` byte/context loss; the SDK does not guess these facts from JavaScript pattern syntax.
Both content actions disclose limited multiline/block counts and conservative outputTruncated, not complete per-occurrence pagination.
Ordinary single-line rows retain their count; byte clipping must be reported even if a multibyte line is below the JS character limit.

Immutable batches plus unread-row offsets provide bounded intra-file pages before advancing a native file cursor.
Matching/serialization captures the index revision under the same native read lock; continuations verify offset and revision there.
Buffered rows also require that saved revision, and optional fuzzy suggestions must match the exact no-match batch.
Never use external before/after probes or retag an older batch after a writer.
No-op shared mutable access conservatively advances the revision; rescan never resets it.
Find snapshots remain independent and immutable.

Live admission checks the captured symlink policy on leaf and root-relative ancestors; queued directory subscriptions revalidate it.
Empty directories revive rows independently of files; the root sentinel stays internal.
Moved ignore definitions retain a root-policy refresh.
Root removal/move invalidates monitoring; prolonged absence requires explicit rescan after recreation.
Neither initial nor second-stat non-missing IO failures imply deletion: retain the index and request coalesced/throttled recovery.
Non-working-repository hidden ancestors follow SKIP_HIDDEN even with rules; worktree hidden files remain supported.

The 200-match per-file cap is possible truncation, not a promise to fetch more.
Public limits apply without host validation.
Both content actions share notices and completeness projection, while acquisition/modes/cursor variants stay distinct.
Collection warnings remain on buffered pages; a fresh native batch supplies its own flags.
Resume the saved mode without reparsing the regex.
Only valid detected regexes reach the broad-pattern guard; invalid expressions stay literal and blank queries fail.

The entry supplies a live ownership predicate: a conflicting provider disables auxiliary integration and disposes native resources. Managed children never regain a profile-excluded discovery builtin. Autocomplete delegates path navigation to the host before index initialization and gates stale wrappers by session epoch, not the initial cwd scope. Same-session cwd rebinding remains active; replacement-session wrappers pass through.

Autocomplete wraps the host's public provider contract, including writable triggerCharacters for the host's merged trigger assignment. Actual setup/editor tests cover both skill-mux/neural orders, earlier custom triggers, cwd rebinding and quoted whitespace paths. Sanitize untrusted call/result text before adding theme ANSI; paint-only normalization must preserve raw arguments and copy metadata. Do not remove numeric safety normalization merely because the dispatcher also validates/coerces schema inputs. The driver does not request unused definition classification that is discarded from both published text and details.

## Pinned-engine corrections

FFF 0.11.0 requires local integration corrections, verified against the real bindings:

- Private `fileSearch.offset` is a zero-based item offset, not a page number; but repeated offset requests have unstable tie boundaries. Find probes with at most100 rows, then captures the complete query once when continuation is needed. Every displayed page, including the first, comes from that snapshot. Refuse more than10,000 matches before a large native request; reject changing/incomplete capture rather than invent a cursor. Cursor storage retains at most20,000 unique find-snapshot rows and200 tokens, counting shared snapshots once; these are row bounds, not a heap-byte guarantee.
- The content-bigram optimization is removed, including its candidate/overlay maintenance; real filtering, binary classification and ordinary matcher order remain. All workspace-content reads now produce bounded owned byte snapshots, with the existing cache caps and small-file admission cutoff; neither cached nor uncached search maps mutable workspace files. Truncation may cause a skipped short read, not SIGBUS; cached snapshots refresh on managed invalidation. Heap/scratch memory costs remain bounded per cache/worker, not by a process-wide RSS ceiling. Literal OR keeps per-pattern smart-case behavior with one automaton, verifying case-sensitive candidates only in mixed queries. Metadata updates accept older mtimes while still advancing content revisions. Directory scoring and actual filesystem watchers are retained; only unused external client subscriptions are retired.
- Linux Node and Bun share private ABI v6, including followSymlinks and native output-limit flags.
  Each envelope owns payloads through detached JS decoding and error paths; only creation transfers a finder.
  No upstream binding fallback or general SDK/highlight/rank wire layout remains.
- Roots canonicalize to the physical identity used by Git caches and watcher paths.
  One discovery boundary preserves .git-file workdirs for scans, watcher identity and index-lock lookup, without guessing the gitdir parent.
  Config/config.worktree changes refresh status; distinct common directories are watched non-recursively without dropping nested worktree data.
  Other-worktree indexes, FETCH_HEAD and config.lock remain filtered; only successful full status refresh clears degradation.
- Readiness includes subscriptions, initial Git refresh and reconciled filesystem coverage.
  A narrow filesystem epoch catches old-snapshot updates; newly installed coverage earns reconciliation after subscription.
  One immediate automatic follow-up per job is bounded; further debt stays incomplete on the existing owner/cooldown.
  Classification/Git/no-op writes do not dirty that epoch.
  Walk/commit errors are fatal; monitoring/metadata failures keep committed snapshots searchable with warnings and false readiness.
  Database initialization becomes healthy only after successful maintenance; failures stay degraded, not automatically diagnosed as permanent data loss.
  Progress owns its errors and exact revision; unsafe JS integer values fail closed.
- Classification uses copied inputs and index/revision validation, not a shared mutable post-scan alias. Live unknown-extension binary-to-text updates are reclassified; GC re-reads in its write transaction, and old combo associations compare normalized exact paths. Multi-part scores accumulate before averaging. Explicit content filters cannot be removed on zero candidates, and native fuzzy continuation resumes at the earliest unreturned file.
- Directory filters use explicit globs; `./` and absolute-path normalization preserve directory meaning. Basename globs in path/exclude gain a canonical `./` prefix, ensuring content and file queries both recognize them as filters. A file such as `stray/pkg.v1` must not redirect a request for `./pkg.v1/` away from `pkg.v1/inside.ts`.
- Native grep page size is a whole-file soft limit, not an output bound. Retain unread batch rows, cap pages at50 matches, and disclose per-file collection limits. Formatting merges physical context rows with match precedence, preserves indentation, and reports both 500-character source-line shortening and Pi's default 2,000-line/50KiB body budget through an omission notice and outputTruncated details. Omitted display text is not recovered by the next cursor; lower context/limit or read source.
- Find pages are capped at100; exact glob filters bypass weak-fuzzy truncation. Classify fuzzy quality from the snapshot's original top score, never the current page's lower scores. The action owns `isWeakFind` for snapshot probing and continuation; formatting receives only page items and the quality decision, not a native-shaped partial result, sliced scores or an override of the original top score. Advertised hasMore requires an actual continuation. Content fuzzy fallback keeps the same path/exclude filters, including concrete filenames.
- Proven existing absolute files take literal precedence in both main and auxiliary indexes, even when their names contain glob syntax. The shared query codec also recognizes absolute exclusions before list tokenization, preserving filename commas. Use native bracket literals for ordinary metacharacters. Brace-containing paths require a real duplicated alternative group of escaped literals: expansion decodes escapes before glob compilation, whereas backslash inside a class is data and admits extra files. Force an ASCII class for otherwise plain names, or duplicate UTF-only alternatives when no safe ASCII class exists. Do not wrap escaped metaclasses in singleton braces or put UTF-8 bytes/! into a class. Keep POSIX trailing backslashes; nonexisting absolute patterns still route as globs. Native controls cover punctuation, Unicode, nested-name exclusion and root identity. Array exclusions retain internal whitespace until validation instead of silently splitting filename paths; scalar whitespace lists and existing comma/brace syntax remain supported. A scanner, not a flat regex, splits lists outside nested braces and bracket classes, including class-initial literal `]`; outside-class escapes protect the following character. Existing absolute files are recognized before this scan.

`ffi-rs` is an optional dependency; the owned library is bundled, not downloaded or compiled during ordinary installation. Unsupported platforms or missing bindings fail explicitly when an index is requested, not during tool discovery. Builds and prepack verify source/library/ABI/notice hashes. Native modules remain cached: updating engine bytes requires a Pi restart, not just `/reload`.

## Verification

New diagnosis, migration and acceptance fixtures belong under `.work/`, not in permanent test discovery. Verify the native SDK request surface before and after discovery, direct execution, source-gated rendering and readonly subagent policy, real native search over disposable files, input/cursor isolation and resource cleanup. Keep checks offline; use the final package contents to verify no runtime import points into `references/` or an installed standalone plugin.
