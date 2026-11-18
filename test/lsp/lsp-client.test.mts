// Derived from pi-lsp 0.49.9 (55d7847); MIT copyright 2026 narumiruna.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { LspClient } from "../../src/pi-lsp/lsp-client.ts";
import { runDiagnostics } from "../../src/pi-lsp/runner.ts";
import type { LspServerAdapter } from "../../src/pi-lsp/types.ts";

const fixture = fileURLToPath(new URL("./fixtures/diagnostics-server.mjs", import.meta.url));

// Tie the workspace to the actual client: wait for the child before removing files.
function clientWorkspace(t: TestContext, prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  let client: LspClient | undefined;
  t.after(async () => {
    await client?.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  async function connect(adapter: LspServerAdapter) {
    assert.equal(client, undefined, "each workspace owns one client");
    client = new LspClient(adapter, root, 1_000);
    await client.start();
    await client.initialize();
    return client;
  }
  return { root, connect };
}

test("server environment overrides are forwarded to the LSP process", async t => {
  const { connect } = clientWorkspace(t, "pi-lsp-server-environment-");
  const adapter = fixtureAdapter("require-environment", 30);
  adapter.env = { PI_LSP_TEST_ENV: "forwarded" };
  await connect(adapter);
});

test("shutdown waits for the LSP process to exit", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-shutdown-");
  const marker = path.join(root, "exited.txt");
  const adapter = fixtureAdapter("delayed-exit", 30);
  adapter.env = { PI_LSP_TEST_EXIT_MARKER: marker };
  const client = await connect(adapter);
  await client.shutdown();
  assert.equal(readFileSync(marker, "utf8"), "exited\n");
});

test("shutdown waits for a process terminated by close", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-close-");
  const marker = path.join(root, "exited.txt");
  const pidFile = path.join(root, "pid.txt");
  const adapter = fixtureAdapter("delayed-sigterm", 30);
  adapter.env = { PI_LSP_TEST_EXIT_MARKER: marker, PI_LSP_TEST_PID_FILE: pidFile };
  const client = await connect(adapter);
  const pid = Number(readFileSync(pidFile, "utf8"));
  client.close();
  await client.shutdown();
  // Shutdown must have settled only once the child is really gone. Windows
  // terminates the process directly, so the SIGTERM handler that writes the
  // marker never runs there; OS liveness is the portable proof.
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  if (process.platform !== "win32") assert.equal(readFileSync(marker, "utf8"), "exited\n");
});

test("pull diagnostics omit optional params when no values are available", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-pull-strict-optional-params-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("pull-strict-optional-params", 30);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const diagnostics = await client.diagnostics(uri);
  assert.deepEqual(
    diagnostics.map(({ message }) => message),
    ["strict pull diagnostic"],
  );
  client.didClose(uri);
});

test("fragmented advertised pull diagnostic errors propagate", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-pull-error-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("pull-error", 30);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  await assert.rejects(client.diagnostics(uri), /intentional pull failure/);
  client.didClose(uri);
});

test("empty pull diagnostics wait for a late push publication", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-empty-pull-late-push-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("pull-empty-then-push", 30);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const diagnostics = await client.diagnostics(uri);
  assert.deepEqual(
    diagnostics.map(({ message }) => message),
    ["late pull-capable diagnostic"],
  );
  client.didClose(uri);
});

test("empty pull diagnostics preserve an already published diagnostic", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-empty-pull-existing-push-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("pull-empty-after-push", 30);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const diagnostics = await client.diagnostics(uri);
  assert.deepEqual(
    diagnostics.map(({ message }) => message),
    ["already published diagnostic"],
  );
  client.didClose(uri);
});

test("empty pull diagnostics fall back after the configured grace period", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-empty-pull-fallback-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("pull-empty-only", 30);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const startedAt = Date.now();
  assert.deepEqual(await client.diagnostics(uri), []);
  assert.ok(Date.now() - startedAt < 500, "empty pull should not wait for the global timeout");
  client.didClose(uri);
});

test("push-only diagnostics may treat no publication as clean after a configured grace", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-push-silent-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("push-silent", 30, undefined, 100);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const startedAt = Date.now();
  assert.deepEqual(await client.diagnostics(uri), []);
  assert.ok(Date.now() - startedAt < 500, "silent push server should not wait for timeout");
  client.didClose(uri);
});

test("closing a client rejects its publication waiter rather than waiting for a grace/timeout result", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-push-cancel-");
  const file = path.join(root, "main.go"); writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("push-silent", 30);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const pending = client.diagnostics(uri);
  client.close();
  await assert.rejects(pending, /request cancelled/);
  await client.shutdown();
});

test("push-only diagnostics preserve a publication within the configured grace", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-push-silent-late-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("push-silent-then-diagnostic", 30, undefined, 100);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const diagnostics = await client.diagnostics(uri);
  assert.deepEqual(
    diagnostics.map(({ message }) => message),
    ["late push-only diagnostic"],
  );
  client.didClose(uri);
});

test("push diagnostics match a re-encoded publication uri", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-push-alternate-uri-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("push-alternate-uri-encoding", 30, undefined, 100);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const diagnostics = await client.diagnostics(uri);
  assert.deepEqual(
    diagnostics.map(({ message }) => message),
    ["alternate uri encoding diagnostic"],
  );
  client.didClose(uri);
});

test("push diagnostics settle on the latest publication", async t => {
  const { root, connect } = clientWorkspace(t, "pi-lsp-push-sequence-");
  const file = path.join(root, "main.go");
  writeFileSync(file, "package main\n");
  const adapter = fixtureAdapter("push-sequence", 80);
  const client = await connect(adapter);
  const uri = pathToFileURL(file).href;
  client.didOpen(uri, "package main\n", "go");
  const diagnostics = await client.diagnostics(uri);
  assert.deepEqual(
    diagnostics.map(({ message }) => message),
    ["first", "second"],
  );
  client.didClose(uri);
});

test("code-action resolution follows the advertised server capability", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-resolve-capability-"));
  const action = { title: "fixture action", data: { id: 1 } };

  try {
    for (const [scenario, expectedTitle] of [
      ["resolve-disabled", "fixture action"],
      ["resolve-enabled", "fixture action:resolved"],
    ] as const) {
      const adapter = fixtureAdapter(scenario, 30);
      const client = new LspClient(adapter, root, 1_000);
      try {
        await client.start();
        await client.initialize();
        const [resolved] = await client.resolveActions([action]);
        assert.equal(resolved?.title, expectedTitle);
      } finally {
        await client.shutdown();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics open all files before awaiting fragmented/coalesced UTF-8 publications", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-batch-push-"));
  mkdirSync(path.join(root, "pkg"));
  const files = ["a.go", "b.go", "c.go"].map((name) => path.join(root, "pkg", name));
  for (const file of files) writeFileSync(file, "package pkg\n");
  const adapter = fixtureAdapter("batch-push", 30, files.length);

  try {
    const result = await runDiagnostics(adapter, { root, files }, 1_000, undefined, { ui: { setStatus() {} } }, "test");
    const details = result.details as {
      files: Array<{ path: string; diagnostics: Array<{ message: string }> }>;
    };
    assert.deepEqual(
      details.files.map(({ diagnostics }) => diagnostics.length),
      [1, 1, 1],
    );
    assert.ok(details.files.every(({ diagnostics }) =>
      diagnostics.every(({ message }) => message.endsWith("🙂 é ✓"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureAdapter(
  scenario: string,
  diagnosticsSettleMs: number,
  expectedFiles?: number,
  pushDiagnosticsGraceMs?: number,
): LspServerAdapter {
  return {
    name: `fixture-${scenario}`,
    isDefault: false,
    defaultCommand: {
      command: process.execPath,
      args: [fixture, scenario, ...(expectedFiles === undefined ? [] : [String(expectedFiles)])],
    },
    missingCommandHint: "Node is required for the test fixture.",
    extensions: [".go"],
    skipDirectories: new Set(),
    diagnosticsSettleMs,
    pushDiagnosticsGraceMs,
    pullDiagnosticsGraceMs:
      scenario === "pull-empty-then-push" || scenario === "pull-empty-after-push" || scenario === "pull-empty-only"
        ? 200
        : undefined,
    isSupportedFile: (filePath) => filePath.endsWith(".go"),
    languageIdFor: () => "go",
  };
}
