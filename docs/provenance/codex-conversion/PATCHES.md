# Current locally maintained differences

Public composition is `extensions/execution.ts`; retained code is under
`src/execution/`. Check it with `npm run check:execution`. Historical provider,
context, V8 and patch changes remain in Git, not in the current runtime.

## Pi ownership

Pi 0.99.1 owns providers/OAuth/catalog, default tools, native codemode, permissions,
prepared arguments, branch store and ordinary compaction. metis never chooses
tools by model name or maintains a second JS engine.

## Process and image supplements

`exec_command`, `write_stdin` and `view_image` use deferred registration, preserving
Pi defaults and allowing tool discovery. Exec bridge/session/manager owners retain
framing, incremental UTF-8 decoding, bounded display, full archives, interactive
input, cancellation, retention and shutdown. Helpers use canonical absolute paths.

Native codemode receives structured process/image output. Image hints preserve
original bytes in session blobs, match request images by call and ordinal, and
retain source-session identity across forks. Ambiguous identical bytes with
different detail fail explicitly. Optional text descriptions use Pi ModelRegistry
and its existing authentication.

## Native editing and output capture

Action Fusion extends Pi edit/write with then_run, shared canonical path queues,
mutation snapshots and versioned receipts. Commands use native Pi bash and archive
exact output before truncation. Source guards respect foreign same-name tools.
No patch DSL or V8 fused entry remains.

## Native nested evidence

Condense subscribes to Pi execution start/end and prepared arguments, archiving
full children with the existing indexer/spill and parentToolCallId. Failed or
blocked calls are retained, and protected/error/pending/archive-failure state
propagates to parent results before cleanup. OCC still checks execution busy
state and archive availability. Ordinary persisted archives remain readable.

## Delivery

The root package ships TS, shell WASM and Linux x64 PTY/image helpers. V8 host
workspace, installer, release build and direct downloader/TOML dependencies have
retired. The remaining Rust workspace excludes patch and its path/fs crates.
There are no compatibility facades, source-removal tests or install-time builds.
