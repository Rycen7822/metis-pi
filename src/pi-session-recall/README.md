# Metis Session Recall

This module is maintained and shipped by **metis-pi**, not installed as a separate
Pi package. Install Metis using the [root README](../../README.md); disable the
standalone `@ogulcancelik/pi-session-recall` entry to avoid duplicate tools.
Upstream version, commit and license attribution are retained in [METIS.md](METIS.md)
and [LICENSE](LICENSE).

Metis exposes one deferred `session_recall` tool with `search`, `query` and
`describe` actions. Search finds literal text in saved session JSONL files;
query reads a selected session branch using the current Pi model runtime.
There is no background indexing or vector database. Ripgrep is recommended;
search can fall back to grep or Node's streaming scan.

The optional query model is selected by `[sessionRecall].queryModel` in the global
`metis-pi.toml`; `"default"` follows the current session. Pi owns model definitions
and authentication. See the [tool and configuration guide](../../docs/features/managed-plugins.md)
for the current interface and examples.

Development dependencies and checks are owned by the root project. This module
loads TypeScript directly and does not need an independent manifest or build.
