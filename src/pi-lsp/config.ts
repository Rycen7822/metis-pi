import { readFileSync } from "node:fs";
import process from "node:process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultMetisConfig, parseMetisConfig, metisConfigPath, isMetisConfigTable as isRecord } from "../configuration/store.ts";
import type { InternalLspServer, LspConfig } from "./types.ts";

const BIOME_EXTENSIONS = [
  ".astro",
  ".css",
  ".cts",
  ".cjs",
  ".graphql",
  ".gql",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
];

export const DEFAULT_SERVER_CONFIGS: InternalLspServer[] = [
  {
    name: "biome",
    command: ["biome", "lsp-proxy"],
    extensions: BIOME_EXTENSIONS,
  },
  {
    name: "ty",
    command: ["ty", "server"],
    extensions: [".py", ".pyi"],
  },
  {
    name: "ruff",
    command: ["ruff", "server"],
    extensions: [".py", ".pyi"],
  },
  {
    name: "rust-analyzer",
    command: ["rust-analyzer"],
    extensions: [".rs"],
    // rust-analyzer can return an empty pull result before its initial analysis
    // publishes the real diagnostics.
    pullDiagnosticsGraceMs: 5_000,
  },
  {
    name: "gopls",
    command: ["gopls"],
    extensions: [".go"],
  },
  {
    name: "rubocop",
    command: ["rubocop", "--lsp"],
    extensions: [".rb", ".rake", ".gemspec", ".ru"],
  },
  {
    name: "elixir-ls",
    command: [process.platform === "win32" ? "language_server.bat" : "language_server.sh"],
    extensions: [".ex", ".exs"],
    skipDirectories: ["_build", "deps"],
  },
  {
    name: "zls",
    command: ["zls"],
    extensions: [".zig", ".zon"],
    skipDirectories: [".zig-cache", "zig-out"],
  },
  {
    name: "csharp",
    command: ["roslyn-language-server", "--stdio", "--autoLoadProjects"],
    extensions: [".cs", ".csx"],
    skipDirectories: ["bin", "obj"],
  },
  {
    name: "fsharp",
    command: ["fsautocomplete"],
    extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
    skipDirectories: ["bin", "obj"],
    initialization: { AutomaticWorkspaceInit: true },
  },
  {
    name: "sourcekit-lsp",
    command: ["sourcekit-lsp"],
    extensions: [".swift", ".mm"],
    skipDirectories: [".build", "DerivedData"],
  },
  {
    name: "clangd",
    command: ["clangd", "--background-index", "--clang-tidy"],
    extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
    skipDirectories: ["build"],
  },
  {
    name: "jdtls",
    command: ["jdtls"],
    extensions: [".java"],
    skipDirectories: [".gradle", "build"],
  },
  {
    name: "kotlin-lsp",
    command: ["kotlin-lsp", "--stdio"],
    extensions: [".kt", ".kts"],
    skipDirectories: [".gradle", "build"],
  },
  {
    name: "yaml-language-server",
    command: ["yaml-language-server", "--stdio"],
    extensions: [".yaml", ".yml"],
  },
  {
    name: "lua-language-server",
    command: ["lua-language-server"],
    extensions: [".lua"],
    // LuaLS does not publish an empty diagnostic set for a clean document.
    pushDiagnosticsGraceMs: 3_000,
  },
  {
    name: "intelephense",
    command: ["intelephense", "--stdio"],
    extensions: [".php"],
    initialization: { intelephense: { telemetry: { enabled: false } } },
    // Publishes empty on didOpen, then real diagnostics ~0.2-3s later.
    diagnosticsSettleMs: 4000,
  },
  {
    name: "prisma",
    command: ["prisma-language-server", "--stdio"],
    extensions: [".prisma"],
  },
  {
    name: "dart",
    command: ["dart", "language-server"],
    extensions: [".dart"],
    skipDirectories: [".dart_tool", "build"],
    // The analysis server can remain silent when a document is clean.
    pushDiagnosticsGraceMs: 2_000,
  },
  {
    name: "ocaml-lsp",
    command: ["ocamllsp"],
    extensions: [".ml", ".mli"],
    skipDirectories: ["_build", "_opam"],
  },
  {
    name: "bash-language-server",
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash"],
  },
  {
    name: "terraform-ls",
    command: ["terraform-ls", "serve"],
    extensions: [".tf", ".tfvars"],
    skipDirectories: [".terraform"],
    pushDiagnosticsGraceMs: 2_000,
    initialization: {
      experimentalFeatures: { prefillRequiredFields: true },
    },
  },
  {
    name: "texlab",
    command: ["texlab"],
    extensions: [".tex", ".bib"],
  },
  {
    name: "gleam",
    command: ["gleam", "lsp"],
    extensions: [".gleam"],
    skipDirectories: ["build"],
    pushDiagnosticsGraceMs: 2_000,
  },
  {
    name: "clojure-lsp",
    command: ["clojure-lsp", "listen"],
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    skipDirectories: [".cpcache"],
  },
  {
    name: "nixd",
    command: ["nixd"],
    extensions: [".nix"],
  },
  {
    name: "tinymist",
    command: ["tinymist"],
    extensions: [".typ", ".typc"],
    pushDiagnosticsGraceMs: 2_000,
  },
  {
    name: "haskell-language-server",
    command: ["haskell-language-server-wrapper", "--lsp"],
    extensions: [".hs", ".lhs"],
    skipDirectories: [".stack-work", "dist-newstyle"],
    pushDiagnosticsGraceMs: 3_000,
  },
];

/** Server commands are trusted global preferences, never selected by workspace root. */
export function loadConfig(): LspConfig {
  const agentDir = getAgentDir();
  const path = metisConfigPath(agentDir);
  let text: string | undefined;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value = (text === undefined ? defaultMetisConfig() : parseMetisConfig(text, path))["lsp"] ?? defaultMetisConfig()["lsp"];
  const label = `${path} [lsp]`;
  if (!isRecord(value)) throw new Error(`${label} must be a table.`);
  const timeout = optionalPositiveNumberField(value, "timeout", label);
  if (value.servers === undefined) {
    return { timeout, servers: DEFAULT_SERVER_CONFIGS.map(server => ({ ...server, isDefault: true })) };
  }
  if (!isRecord(value.servers)) throw new Error(`${label}.servers must be a table.`);
  return { timeout, servers: normalizeServerMap(value.servers, `${label}.servers`) };
}

function normalizeServerMap(value: Record<string, unknown>, label: string) {
  return Object.entries(value).map(([name, server]) => normalizeServer(name, server, `${label}.${name}`));
}

function normalizeServer(name: string, value: unknown, label: string): InternalLspServer {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const command = stringArrayField(value, "command", label);
  const extensions = stringArrayField(value, "extensions", label).map(normalizeExtension);
  return {
    name,
    command,
    extensions,
    env: optionalStringRecordField(value, "env", label),
    initialization: optionalRecordField(value, "initialization", label),
    skipDirectories: optionalDirectoryNamesField(value, "skipDirectories", label),
    diagnosticsSettleMs: optionalPositiveNumberField(value, "diagnosticsSettleMs", label),
    pushDiagnosticsGraceMs: optionalPositiveNumberField(value, "pushDiagnosticsGraceMs", label),
    pullDiagnosticsGraceMs: optionalPositiveNumberField(value, "pullDiagnosticsGraceMs", label),
  };
}

function normalizeExtension(extension: string) {
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function stringArrayField(value: Record<string, unknown>, field: string, label: string) {
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue) || !fieldValue.every((item) => typeof item === "string")) {
    throw new Error(`${label}.${field} must be an array of strings.`);
  }
  return fieldValue;
}

function optionalPositiveNumberField(value: Record<string, unknown>, field: string, label: string) {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue <= 0) {
    throw new Error(`${label}.${field} must be a positive number.`);
  }
  return fieldValue;
}

function optionalStringRecordField(value: Record<string, unknown>, field: string, label: string) {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (!isRecord(fieldValue)) {
    throw new Error(`${label}.${field} must be an object with string values.`);
  }
  if (!Object.values(fieldValue).every((item) => typeof item === "string")) {
    throw new Error(`${label}.${field} must be an object with string values.`);
  }
  return fieldValue as Record<string, string>;
}

function optionalRecordField(value: Record<string, unknown>, field: string, label: string) {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (!isRecord(fieldValue)) {
    throw new Error(`${label}.${field} must be an object.`);
  }
  return fieldValue;
}

function optionalDirectoryNamesField(value: Record<string, unknown>, field: string, label: string) {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (!Array.isArray(fieldValue) || !fieldValue.every((item) => typeof item === "string")) {
    throw new Error(`${label}.${field} must be an array of directory names.`);
  }
  const names = fieldValue.map((item) => item.trim());
  if (names.some((name) => !name || name === "." || name === ".." || name.includes("/") || name.includes("\\"))) {
    throw new Error(`${label}.${field} must contain non-empty directory names without path separators.`);
  }
  return [...new Set(names)];
}
