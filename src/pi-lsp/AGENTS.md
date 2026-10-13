# Pi LSP Guidelines

## Protocol behavior

- Return one empty configuration object per `workspace/configuration` request item for ty and Ruff.
- Allow a bounded rust-analyzer-specific grace period for a newer push diagnostic after an initially empty pull result.
- On Windows, resolve extensionless commands against the adapter's effective `PATH` and child cwd, then launch `.cmd` or `.bat` shims through `%ComSpec%`.
- Preserve per-session cancellation ownership and await every owned call before shutdown. The shared status key can still be cleared by a sibling completion; do not mistake that UI limitation for completed cleanup.

## Configuration and catalog

- Read LSP preferences only from global metis-pi.toml [lsp], with explicit argv arrays. Do not restore project/global LSP JSON or implicit migration.
- Avoid extension-specific environment-variable settings, but retain `servers[].env` for child-process needs.
- Keep the built-in catalog limited to direct-command, non-overlapping routes for real standalone launchers, including required initialization, platform-wrapper behavior, and dialect-specific language IDs.
