// Derived from pi-lsp 0.49.9 (55d7847); MIT copyright 2026 narumiruna.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, mock as mocks } from "node:test";
import { LspClient } from "../../src/pi-lsp/lsp-client.ts";
import { fixture } from "./lifecycle-support.ts";

for (const kind of ["diagnostics", "fix"] as const) {
  test(`${kind}: normal document scope, result, listeners and process exit`, async () => {
    const f = fixture();
    mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
    try {
      const result = await f.run(kind);
      assert.match(result.content[0].text, kind === "fix" ? /computed changes/ : /0 diagnostic\(s\)/);
      assert.equal(readFileSync(f.file, "utf8"), "package main\n");
      assert.deepEqual(
        f.events().map((event) => event.method),
        [
          "ready",
          "initialize",
          "initialized",
          "textDocument/didOpen",
          "textDocument/diagnostic",
          ...(kind === "fix" ? ["textDocument/codeAction", "codeAction/resolve"] : []),
          "textDocument/didClose",
          "shutdown",
          "exit",
          "exited",
        ],
      );
      assert.deepEqual(f.statuses, [`fixture ${kind}`, undefined]);
      assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
      f.exited();
    } finally {
      await f.dispose();
      mocks.restoreAll();
    }
  });

  for (const method of [
    "initialize",
    "textDocument/diagnostic",
    ...(kind === "fix" ? ["textDocument/codeAction", "codeAction/resolve"] : []),
  ]) {
    test(`${kind}: ${method} rejection preserves error and releases process`, async () => {
      const f = fixture(`lifecycle-error-${method}`);
      mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
      try {
        await assert.rejects(f.run(kind), /intentional operation failure/);
        assert.equal(f.statuses.at(-1), undefined);
        assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
        if (method === "initialize") assert.ok(!f.events().some((event) => event.method === "textDocument/didOpen"));
        else assert.ok(f.events().some((event) => event.method === "textDocument/didClose"));
        f.exited();
      } finally {
        await f.dispose();
        mocks.restoreAll();
      }
    });
    test(`${kind}: caller cancellation during ${method} drains the real child`, async () => {
      const f = fixture(`lifecycle-hang-${method}`);
      mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
      try {
        const task = f.run(kind, { write: true });
        await f.ready(method);
        f.controller.abort();
        await assert.rejects(task, /cancelled|aborted/);
        assert.equal(readFileSync(f.file, "utf8"), "package main\n");
        assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
        f.exited();
      } finally {
        await f.dispose();
        mocks.restoreAll();
      }
    });
  }

  for (const failure of ["missing", "spawn", "timeout", "initial-status"] as const) {
    test(`${kind}: ${failure} startup failure releases owned resources`, async () => {
      const f = fixture(failure === "timeout" ? "lifecycle-hang-initialize" : undefined);
      mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
      const shutdown = mocks.method(LspClient.prototype, "shutdown");
      if (failure === "missing") f.adapter.defaultCommand.command = path.join(f.root, "missing");
      if (failure === "spawn") {
        const command = path.join(f.root, "broken");
        writeFileSync(command, "#!/nonexistent-interpreter\n", { mode: 0o755 });
        f.adapter.defaultCommand.command = command;
      }
      try {
        await assert.rejects(
          f.run(kind, {
            timeoutMs: failure === "timeout" ? 300 : 1_000,
            context:
              failure === "initial-status"
                ? {
                    ui: {
                      setStatus() {
                        throw new Error("initial status failed");
                      },
                    },
                  }
                : undefined,
          }),
          /not found|failed to start|timed out|initial status failed/,
        );
        assert.equal(shutdown.mock.calls.length, 1);
        assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
        if (failure === "timeout") f.exited();
        assert.ok(!f.events().some((event) => event.method === "textDocument/didOpen"));
      } finally {
        await f.dispose();
        mocks.restoreAll();
      }
    });
  }

  for (const uiFailure of ["getter", "setter"] as const) {
    for (const operationFails of [false, true]) {
      test(`${kind}: cleanup ${uiFailure} failure cannot replace ${operationFails ? "operation error" : "result"}`, async () => {
        const f = fixture();
        mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
        const shutdown = mocks.method(LspClient.prototype, "shutdown");
        let stale = false;
        const original = LspClient.prototype.diagnostics;
        mocks.method(LspClient.prototype, "diagnostics").mock.mockImplementation(async function (this: LspClient, uri) {
          const result = await original.call(this, uri);
          stale = true;
          if (operationFails) throw new Error("original operation error");
          return result;
        });
        const context = {
          get ui() {
            if (stale && uiFailure === "getter") throw new Error("stale context");
            return {
              setStatus(_key: string, value: string | undefined) {
                if (value === undefined) throw new Error("status cleanup failed");
              },
            };
          },
        };
        try {
          const task = f.run(kind, { context });
          if (operationFails) await assert.rejects(task, /original operation error/);
          else await task;
          assert.equal(shutdown.mock.calls.length, 1);
          assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
          f.exited();
        } finally {
          await f.dispose();
          mocks.restoreAll();
        }
      });
    }
  }

  test(`${kind}: cancellation interrupts a pending shutdown and removes its subscription`, async () => {
    const f = fixture("lifecycle-hang-shutdown");
    mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
    try {
      const task = f.run(kind);
      await f.ready("shutdown");
      assert.equal(getEventListeners(f.controller.signal, "abort").length, 1);
      f.controller.abort();
      await assert.rejects(task, /aborted|cancelled/);
      assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
      f.exited();
    } finally {
      await f.dispose();
      mocks.restoreAll();
    }
  });

  for (const operationFails of [false, true]) {
    test(`${kind}: resource cleanup error is ${operationFails ? "secondary" : "observable"}`, async () => {
      const f = fixture(operationFails ? "lifecycle-error-initialize" : undefined);
      mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
      const shutdown = LspClient.prototype.shutdown;
      const spy = mocks.method(LspClient.prototype, "shutdown");
  spy.mock.mockImplementation(async function (this: LspClient) {
        await shutdown.call(this);
        throw new Error("shutdown failure");
      });
      try {
        await assert.rejects(f.run(kind), operationFails ? /intentional operation failure/ : /shutdown failure/);
        f.exited();
      } finally {
        spy.mock.restore();
        await f.dispose();
        mocks.restoreAll();
      }
    });
  }

  for (const method of [
    "start",
    "initialize",
    "diagnostics",
    ...(kind === "fix" ? (["codeActions", "resolveActions"] as const) : []),
  ] as const) {
    test(`${kind}: cancellation after ${method} response prevents next work`, async () => {
      const f = fixture();
      mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
      const original = method === "start" ? f.start : LspClient.prototype[method];
      mocks.method(LspClient.prototype, method).mock.mockImplementation(async function (this: LspClient, ...args: unknown[]) {
        const result = await (original as (...args: unknown[]) => Promise<unknown>).apply(this, args);
        f.controller.abort();
        return result;
      } as never);
      try {
        await assert.rejects(f.run(kind, { write: true }), /aborted|cancelled/);
        assert.equal(readFileSync(f.file, "utf8"), "package main\n");
        const next = {
          start: "initialize",
          initialize: "textDocument/didOpen",
          diagnostics: "textDocument/codeAction",
          codeActions: "codeAction/resolve",
          resolveActions: "never",
        }[method];
        assert.ok(!f.events().some((event) => event.method === next));
        if (method !== "start") f.exited();
      } finally {
        await f.dispose();
        mocks.restoreAll();
      }
    });
  }
}

test("empty diagnostics selection does not allocate, spawn or publish status", async () => {
  const f = fixture();
  const start = mocks.method(LspClient.prototype, "start");
  start.mock.mockImplementation(f.start);
  try {
    const result = await f.run("diagnostics", { files: [] });
    assert.match(result.content[0].text, /no supported files/);
    assert.equal(start.mock.calls.length, 0);
    assert.deepEqual(f.statuses, []);
  } finally {
    await f.dispose();
    mocks.restoreAll();
  }
});

for (const write of [false, true]) {
  for (const unchanged of [false, true]) {
    test(`fix: write=${write}, unchanged=${unchanged} preserves exact result and disk semantics`, async () => {
      const f = fixture(unchanged ? "lifecycle-unchanged" : undefined);
      mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
      try {
        const result = await f.run("fix", { write });
        const text = `${unchanged ? "" : "// fixed\n"}package main\n`;
        const details = result.details as {
          changed: boolean;
          text?: string;
          write: boolean;
          kind: string;
          actions: unknown[];
          appliedActions: unknown[];
        };
        assert.equal(details.changed, !unchanged);
        assert.equal(details.write, write);
        assert.equal(details.kind, "source.fixAll");
        assert.equal(details.text, write ? undefined : text);
        assert.deepEqual(details.actions, unchanged ? [] : [{ title: "fixture fix", kind: "source.fixAll" }]);
        assert.deepEqual(details.appliedActions, details.actions);
        assert.equal(readFileSync(f.file, "utf8"), write ? text : "package main\n");
        f.exited();
      } finally {
        await f.dispose();
        mocks.restoreAll();
      }
    });
  }
}

for (const write of [false, true]) {
  test(`fix: disabled actions and legacy commands stay informational (write=${write})`, async () => {
    const f = fixture("lifecycle-action-variants");
    mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
    try {
      const result = await f.run("fix", { write });
      const details = result.details as { actions: Array<{ title: string }>; appliedActions: Array<{ title: string }>; text?: string };
      assert.deepEqual(details.actions.map(action => action.title), ["disabled inline", "legacy command", "disabled unresolved", "fixture fix"]);
      assert.deepEqual(details.appliedActions.map(action => action.title), ["fixture fix"]);
      const fixed = "// fixed\npackage main\n";
      assert.equal(readFileSync(f.file, "utf8"), write ? fixed : "package main\n");
      assert.equal(details.text, write ? undefined : fixed);
      assert.equal(f.events().filter(event => event.method === "codeAction/resolve").length, 1);
      f.exited();
    } finally { await f.dispose(); mocks.restoreAll(); }
  });
}

test("diagnostics: partial file open closes all previously opened documents", async () => {
  const f = fixture();
  mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
  try {
    await assert.rejects(f.run("diagnostics", { files: [f.file, path.join(f.root, "missing.go")] }), /ENOENT/);
    assert.deepEqual(
      f
        .events()
        .filter((event) => /didOpen|didClose/.test(event.method))
        .map((event) => event.method),
      ["textDocument/didOpen", "textDocument/didClose"],
    );
    f.exited();
  } finally {
    await f.dispose();
    mocks.restoreAll();
  }
});

test("fix: write failure still closes document and drains process", async () => {
  const f = fixture();
  mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
  const resolve = LspClient.prototype.resolveActions;
  mocks.method(LspClient.prototype, "resolveActions").mock.mockImplementation(async function (this: LspClient, actions) {
    const result = await resolve.call(this, actions);
    unlinkSync(f.file);
    mkdirSync(f.file);
    return result;
  });
  try {
    await assert.rejects(f.run("fix", { write: true }), /EISDIR/);
    assert.ok(f.events().some((event) => event.method === "textDocument/didClose"));
    f.exited();
  } finally {
    await f.dispose();
    mocks.restoreAll();
  }
});

for (const kind of ["diagnostics", "fix"] as const) {
  test(`${kind}: oversized output remains complete`, async () => {
    const f = fixture("lifecycle-large");
    mocks.method(LspClient.prototype, "start").mock.mockImplementation(f.start);
    try {
      assert.ok((await f.run(kind)).content[0].text.includes("x".repeat(60_000)));
    } finally {
      await f.dispose();
      mocks.restoreAll();
    }
  });
}
