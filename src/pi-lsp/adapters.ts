import path from "node:path";
import { loadConfig } from "./config.ts";
import type { InternalLspServer, LspServerAdapter } from "./types.ts";

const COMMON_SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".output",
  ".ruff_cache",
  ".svelte-kit",
  ".tox",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

export function loadRuntime() {
  const config = loadConfig();
  return {
    adapters: config.servers.map(configToAdapter),
    timeoutMs: config.timeout ?? 20_000,
  };
}

function configToAdapter(config: InternalLspServer): LspServerAdapter {
  const extensionSet = new Set(config.extensions);
  const [command, ...args] = config.command;
  if (!command) throw new Error(`${config.name}.command must contain at least one string.`);
  return {
    name: config.name,
    isDefault: config.isDefault ?? false,
    defaultCommand: { command, args },
    missingCommandHint: `Install ${config.name} or update its command in metis-pi.toml [lsp.servers.${config.name}].`,
    extensions: config.extensions,
    env: config.env,
    initialization: config.initialization,
    skipDirectories: new Set([...COMMON_SKIP_DIRECTORIES, ...(config.skipDirectories ?? [])]),
    diagnosticsSettleMs: config.diagnosticsSettleMs,
    pushDiagnosticsGraceMs: config.pushDiagnosticsGraceMs,
    pullDiagnosticsGraceMs: config.pullDiagnosticsGraceMs,
    isSupportedFile: (filePath) => extensionSet.has(path.extname(filePath)),
    languageIdFor: (filePath) => languageIdFor(filePath),
  };
}

function languageIdFor(filePath: string) {
  const extension = path.extname(filePath);
  return LANGUAGE_IDS[extension] ?? extension.slice(1);
}

const LANGUAGE_IDS: Record<string, string> = {
  ".bash": "shellscript",
  ".bib": "bibtex",
  ".c": "c",
  ".c++": "cpp",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".clj": "clojure",
  ".cljc": "clojure",
  ".cljs": "clojure",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".csx": "csharp",
  ".cts": "typescript",
  ".cxx": "cpp",
  ".dart": "dart",
  ".edn": "clojure",
  ".ex": "elixir",
  ".exs": "elixir",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsscript": "fsharp",
  ".fsx": "fsharp",
  ".gemspec": "ruby",
  ".go": "go",
  ".gql": "graphql",
  ".h": "c",
  ".h++": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hs": "haskell",
  ".hxx": "cpp",
  ".jl": "julia",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".jsonc": "jsonc",
  ".ksh": "shellscript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".lhs": "lhaskell",
  ".m": "objective-c",
  ".mjs": "javascript",
  ".ml": "ocaml",
  ".mli": "ocaml.interface",
  ".mm": "objective-cpp",
  ".mts": "typescript",
  ".nix": "nix",
  ".php": "php",
  ".py": "python",
  ".pyi": "python",
  ".rake": "ruby",
  ".rb": "ruby",
  ".rs": "rust",
  ".ru": "ruby",
  ".sh": "shellscript",
  ".swift": "swift",
  ".tex": "latex",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".typ": "typst",
  ".typc": "typst-code",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
  ".zon": "zig",
  ".zsh": "shellscript",
};
