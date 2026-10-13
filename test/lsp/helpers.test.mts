// Derived from pi-lsp 0.49.9 (55d7847); MIT copyright 2026 narumiruna.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadRuntime } from "../../src/pi-lsp/adapters.ts";
import { commandExists, commandPathValue, mergeEnvironment, resolveCommandPath, resolveSpawnCommand } from "../../src/pi-lsp/command.ts";
import { collectSupportedFiles, directoryUri, resolveSupportedFile } from "../../src/pi-lsp/files.ts";
import { selectDiagnosticRoutes, selectFixRoute } from "../../src/pi-lsp/routes.ts";
import { applyTextEdits, collectWorkspaceEdits, hasOverlappingTextEdits, positionAt } from "../../src/pi-lsp/text-edits.ts";
import type { LspServerAdapter } from "../../src/pi-lsp/types.ts";

test("default catalog routes common languages and skips generated trees", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-defaults-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(path.join(project, "target"));
  mkdirSync(path.join(project, "vendor"));
  writeFileSync(path.join(project, "src", "main.rs"), "fn main() {}\n");
  writeFileSync(path.join(project, "src", "main.go"), "package main\n");
  writeFileSync(path.join(project, "target", "generated.rs"), "fn generated() {}\n");
  writeFileSync(path.join(project, "vendor", "dependency.go"), "package dependency\n");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const { adapters } = loadRuntime();
    const rustAnalyzer = adapters.find((adapter) => adapter.name === "rust-analyzer");
    const gopls = adapters.find((adapter) => adapter.name === "gopls");
    assert.ok(rustAnalyzer);
    assert.ok(gopls);
    assert.deepEqual(rustAnalyzer.defaultCommand, { command: "rust-analyzer", args: [] });
    assert.deepEqual(rustAnalyzer.extensions, [".rs"]);
    assert.equal(rustAnalyzer.pullDiagnosticsGraceMs, 5_000);
    assert.equal(rustAnalyzer.languageIdFor("src/main.rs"), "rust");
    assert.deepEqual(collectSupportedFiles(rustAnalyzer, project, undefined, 50), [
      path.join(project, "src", "main.rs"),
    ]);
    assert.deepEqual(collectSupportedFiles(rustAnalyzer, project, ["target"], 50), [
      path.join(project, "target", "generated.rs"),
    ]);
    assert.deepEqual(gopls.defaultCommand, { command: "gopls", args: [] });
    assert.deepEqual(gopls.extensions, [".go"]);
    assert.equal(gopls.languageIdFor("main.go"), "go");
    assert.deepEqual(collectSupportedFiles(gopls, project, undefined, 50), [path.join(project, "src", "main.go")]);
    assert.deepEqual(collectSupportedFiles(gopls, project, ["vendor"], 50), [
      path.join(project, "vendor", "dependency.go"),
    ]);

    const catalog: Array<{
      name: string;
      command: string[];
      extensions: string[];
      sample: string;
      languageId: string;
      skipDirectories?: string[];
      initialization?: Record<string, unknown>;
      diagnosticsSettleMs?: number;
      pushDiagnosticsGraceMs?: number;
      pullDiagnosticsGraceMs?: number;
    }> = [
      {
        name: "rubocop",
        command: ["rubocop", "--lsp"],
        extensions: [".rb", ".rake", ".gemspec", ".ru"],
        sample: "Rakefile.rake",
        languageId: "ruby",
      },
      {
        name: "elixir-ls",
        command: [process.platform === "win32" ? "language_server.bat" : "language_server.sh"],
        extensions: [".ex", ".exs"],
        sample: "lib/app.exs",
        languageId: "elixir",
        skipDirectories: ["_build", "deps"],
      },
      {
        name: "zls",
        command: ["zls"],
        extensions: [".zig", ".zon"],
        sample: "build.zig.zon",
        languageId: "zig",
        skipDirectories: [".zig-cache", "zig-out"],
      },
      {
        name: "csharp",
        command: ["roslyn-language-server", "--stdio", "--autoLoadProjects"],
        extensions: [".cs", ".csx"],
        sample: "Program.csx",
        languageId: "csharp",
        skipDirectories: ["bin", "obj"],
      },
      {
        name: "fsharp",
        command: ["fsautocomplete"],
        extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
        sample: "Program.fsx",
        languageId: "fsharp",
        skipDirectories: ["bin", "obj"],
        initialization: { AutomaticWorkspaceInit: true },
      },
      {
        name: "sourcekit-lsp",
        command: ["sourcekit-lsp"],
        extensions: [".swift", ".mm"],
        sample: "Sources/App.swift",
        languageId: "swift",
        skipDirectories: [".build", "DerivedData"],
      },
      {
        name: "clangd",
        command: ["clangd", "--background-index", "--clang-tidy"],
        extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
        sample: "include/app.hpp",
        languageId: "cpp",
        skipDirectories: ["build"],
      },
      {
        name: "jdtls",
        command: ["jdtls"],
        extensions: [".java"],
        sample: "src/App.java",
        languageId: "java",
        skipDirectories: [".gradle", "build"],
      },
      {
        name: "kotlin-lsp",
        command: ["kotlin-lsp", "--stdio"],
        extensions: [".kt", ".kts"],
        sample: "src/App.kts",
        languageId: "kotlin",
        skipDirectories: [".gradle", "build"],
      },
      {
        name: "yaml-language-server",
        command: ["yaml-language-server", "--stdio"],
        extensions: [".yaml", ".yml"],
        sample: "config.yml",
        languageId: "yaml",
      },
      {
        name: "lua-language-server",
        command: ["lua-language-server"],
        extensions: [".lua"],
        sample: "init.lua",
        languageId: "lua",
        pushDiagnosticsGraceMs: 3_000,
      },
      {
        name: "intelephense",
        command: ["intelephense", "--stdio"],
        extensions: [".php"],
        sample: "index.php",
        languageId: "php",
        initialization: { intelephense: { telemetry: { enabled: false } } },
        diagnosticsSettleMs: 4000,
      },
      {
        name: "prisma",
        command: ["prisma-language-server", "--stdio"],
        extensions: [".prisma"],
        sample: "schema.prisma",
        languageId: "prisma",
      },
      {
        name: "dart",
        command: ["dart", "language-server"],
        extensions: [".dart"],
        sample: "lib/main.dart",
        languageId: "dart",
        skipDirectories: [".dart_tool", "build"],
        pushDiagnosticsGraceMs: 2_000,
      },
      {
        name: "ocaml-lsp",
        command: ["ocamllsp"],
        extensions: [".ml", ".mli"],
        sample: "lib/app.mli",
        languageId: "ocaml.interface",
        skipDirectories: ["_build", "_opam"],
      },
      {
        name: "bash-language-server",
        command: ["bash-language-server", "start"],
        extensions: [".sh", ".bash"],
        sample: "scripts/build.zsh",
        languageId: "shellscript",
      },
      {
        name: "terraform-ls",
        command: ["terraform-ls", "serve"],
        extensions: [".tf", ".tfvars"],
        sample: "prod.tfvars",
        languageId: "terraform-vars",
        skipDirectories: [".terraform"],
        initialization: {
          experimentalFeatures: { prefillRequiredFields: true },
        },
        pushDiagnosticsGraceMs: 2_000,
      },
      {
        name: "texlab",
        command: ["texlab"],
        extensions: [".tex", ".bib"],
        sample: "references.bib",
        languageId: "bibtex",
      },
      {
        name: "gleam",
        command: ["gleam", "lsp"],
        extensions: [".gleam"],
        sample: "src/app.gleam",
        languageId: "gleam",
        skipDirectories: ["build"],
        pushDiagnosticsGraceMs: 2_000,
      },
      {
        name: "clojure-lsp",
        command: ["clojure-lsp", "listen"],
        extensions: [".clj", ".cljs", ".cljc", ".edn"],
        sample: "deps.edn",
        languageId: "clojure",
        skipDirectories: [".cpcache"],
      },
      {
        name: "nixd",
        command: ["nixd"],
        extensions: [".nix"],
        sample: "flake.nix",
        languageId: "nix",
      },
      {
        name: "tinymist",
        command: ["tinymist"],
        extensions: [".typ", ".typc"],
        sample: "main.typc",
        languageId: "typst-code",
        pushDiagnosticsGraceMs: 2_000,
      },
      {
        name: "haskell-language-server",
        command: ["haskell-language-server-wrapper", "--lsp"],
        extensions: [".hs", ".lhs"],
        sample: "src/Main.lhs",
        languageId: "lhaskell",
        skipDirectories: [".stack-work", "dist-newstyle"],
        pushDiagnosticsGraceMs: 3_000,
      },
    ];
    assert.equal(
      adapters.some((adapter) => adapter.name === "julia-language-server"),
      false,
    );

    for (const expected of catalog) {
      const adapter = adapters.find((candidate) => candidate.name === expected.name);
      assert.ok(adapter, `missing default adapter: ${expected.name}`);
      assert.equal(adapter.isDefault, true);
      assert.deepEqual(adapter.defaultCommand, {
        command: expected.command[0],
        args: expected.command.slice(1),
      });
      assert.deepEqual(adapter.extensions, expected.extensions);
      assert.equal(adapter.languageIdFor(expected.sample), expected.languageId);
      assert.deepEqual(adapter.initialization, expected.initialization);
      assert.equal(adapter.diagnosticsSettleMs, expected.diagnosticsSettleMs);
      assert.equal(adapter.pushDiagnosticsGraceMs, expected.pushDiagnosticsGraceMs);
      assert.equal(adapter.pullDiagnosticsGraceMs, expected.pullDiagnosticsGraceMs);
      for (const directory of expected.skipDirectories ?? []) {
        assert.equal(adapter.skipDirectories.has(directory), true, `${expected.name} skips ${directory}`);
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("command helpers honor server environments and platform wrappers", () => {
  const windowsBin = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-windows-bin-"));
  const commandShim = path.join(windowsBin, "language-server.cmd");
  writeFileSync(commandShim, "@echo off\r\n");
  assert.equal(commandPathValue({ Path: windowsBin }, "win32"), windowsBin);
  assert.deepEqual(
    Object.entries(mergeEnvironment({ Path: windowsBin }, "win32")).filter(([key]) => key.toLowerCase() === "path"),
    [["Path", windowsBin]],
  );
  const resolvedShim = resolveCommandPath("language-server", windowsBin, "win32", windowsBin);
  assert.ok(resolvedShim);
  assert.equal(resolvedShim, commandShim);
  assert.deepEqual(
    resolveSpawnCommand({ command: resolvedShim, args: ["--stdio"] }, "win32", "C:\\Windows\\System32\\cmd.exe"),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", commandShim, "--stdio"],
    },
  );
  assert.deepEqual(resolveSpawnCommand({ command: "language_server.sh", args: [] }, "linux"), {
    command: "language_server.sh",
    args: [],
  });
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-command-"));
  const executable = path.join(root, "tool");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  assert.equal(commandExists("./tool", root), true);
  assert.equal(resolveCommandPath("tool", root, process.platform, ""), executable);
  const relativeBin = path.join(root, "bin");
  const relativeExecutable = path.join(relativeBin, "relative-tool");
  mkdirSync(relativeBin);
  writeFileSync(relativeExecutable, "#!/bin/sh\nexit 0\n");
  chmodSync(relativeExecutable, 0o755);
  assert.equal(resolveCommandPath("relative-tool", root, process.platform, "bin"), relativeExecutable);
  rmSync(windowsBin, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("text edit helpers apply reverse-sorted edits and detect overlaps", () => {
  const text = "one\ntwo\nthree";
  assert.deepEqual(positionAt(text, 5), { line: 1, character: 1 });
  assert.equal(
    applyTextEdits(text, [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: "ONE",
      },
      { range: { start: { line: 2, character: 5 }, end: { line: 2, character: 5 } }, newText: "!" },
    ]),
    "ONE\ntwo\nthree!",
  );
  assert.equal(
    hasOverlappingTextEdits(text, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "" },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "" },
    ]),
    true,
  );
  assert.deepEqual(
    collectWorkspaceEdits(
      {
        changes: {
          "file:///a.ts": [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "x",
            },
          ],
        },
      },
      "file:///a.ts",
    ),
    [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }],
  );
});

test("file helpers collect supported files and reject root escapes", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-files-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");
  writeFileSync(path.join(root, "src", "b.txt"), "ignore\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = testAdapter("ts", [".ts"]);

  assert.equal(directoryUri(root).startsWith("file://"), true);
  assert.deepEqual(collectSupportedFiles(adapter, root, ["src"], 10), [path.join(root, "src", "a.ts")]);
  assert.equal(resolveSupportedFile(adapter, root, "src/a.ts"), path.join(root, "src", "a.ts"));
  assert.throws(() => collectSupportedFiles(adapter, root, ["../outside"], 10), /escapes workspace root/);
});

test("route selection handles server filters and ambiguous fix routes", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-routes-"));
  writeFileSync(path.join(root, "a.ts"), "const a = 1;\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ts = testAdapter("ts", [".ts"]);
  const alsoTs = testAdapter("also-ts", [".ts"]);

  const diagnostic = selectDiagnosticRoutes([ts, alsoTs], { root, server: ["ts"] }, 50);
  assert.deepEqual(
    diagnostic.routes.map((route) => route.adapter.name),
    ["ts"],
  );
  assert.throws(() => selectFixRoute([ts, alsoTs], { root, path: "a.ts" }), /Multiple LSP servers/);
  assert.equal(selectFixRoute([ts, alsoTs], { root, path: "a.ts", server: "also-ts" }).adapter.name, "also-ts");
  assert.throws(
    () => selectDiagnosticRoutes([ts, alsoTs], { root, server: "missing" }, 50),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Unknown LSP server(s): missing. Configured LSP servers: ts, also-ts. " +
          "Omit the server parameter to select matching servers automatically.",
  );
});

test("diagnostic route caches keep per-server skip policies isolated", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-route-cache-"));
  mkdirSync(path.join(root, "generated"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "generated", "output.foo"), "generated\n");
  writeFileSync(path.join(root, "src", "main.foo"), "source\n");
  const skipGenerated = testAdapter("skip-generated", [".foo"]);
  const includeGenerated = testAdapter("include-generated", [".foo"]);
  skipGenerated.skipDirectories.add("generated");

  try {
    const selection = selectDiagnosticRoutes([skipGenerated, includeGenerated], { root }, 50);
    const routes = new Map(selection.routes.map((route) => [route.adapter.name, route.files]));
    assert.deepEqual(routes.get("skip-generated"), [path.join(root, "src", "main.foo")]);
    assert.deepEqual(routes.get("include-generated"), [
      path.join(root, "generated", "output.foo"),
      path.join(root, "src", "main.foo"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic routes skip missing defaults but preserve explicit selection", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-route-availability-"));
  writeFileSync(path.join(root, "main.foo"), "source\n");
  const executable = path.join(root, "available-lsp");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const available = testAdapter("available", [".foo"]);
  available.defaultCommand = { command: "available-lsp", args: [] };
  available.env = { PATH: root };
  available.isDefault = true;
  const missing = testAdapter("missing", [".foo"]);
  missing.defaultCommand = { command: "./missing-lsp", args: [] };
  missing.isDefault = true;
  let missingFileChecks = 0;
  missing.isSupportedFile = (filePath) => {
    missingFileChecks += 1;
    return filePath.endsWith(".foo");
  };

  try {
    const selection = selectDiagnosticRoutes([available, missing], { root }, 50) as ReturnType<
      typeof selectDiagnosticRoutes
    > & { skipped?: Array<{ adapter: LspServerAdapter }> };
    assert.deepEqual(
      selection.routes.map((route) => route.adapter.name),
      ["available"],
    );
    assert.deepEqual(
      selection.skipped?.map((route) => route.adapter.name),
      ["missing"],
    );
    assert.equal(missingFileChecks, 0);
    assert.deepEqual(
      selectDiagnosticRoutes([missing], { root, server: "missing" }, 50).routes.map((route) => route.adapter.name),
      ["missing"],
    );
    assert.equal(missingFileChecks > 0, true);
    missingFileChecks = 0;
    const unrelated = testAdapter("unrelated", [".bar"]);
    unrelated.defaultCommand = { command: "available-lsp", args: [] };
    unrelated.env = { PATH: root };
    unrelated.isDefault = true;
    const partiallyUnavailable = selectDiagnosticRoutes([unrelated, missing], { root }, 50);
    assert.deepEqual(partiallyUnavailable.routes, []);
    assert.deepEqual(
      partiallyUnavailable.skipped.map((route) => route.adapter.name),
      ["missing"],
    );
    assert.equal(missingFileChecks, 0);

    const unavailable = selectDiagnosticRoutes([missing], { root }, 50);
    assert.deepEqual(unavailable.routes, []);
    assert.deepEqual(
      unavailable.skipped.map((route) => route.adapter.name),
      ["missing"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function testAdapter(name: string, extensions: string[]): LspServerAdapter {
  return {
    name,
    isDefault: false,
    extensions,
    skipDirectories: new Set(["node_modules"]),
    defaultCommand: { command: name, args: [] },
    missingCommandHint: `install ${name}`,
    languageIdFor() {
      return name;
    },
    isSupportedFile(filePath: string) {
      return extensions.some((extension) => filePath.endsWith(extension));
    },
  };
}
