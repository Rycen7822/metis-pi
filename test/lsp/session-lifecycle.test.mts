// Derived from pi-lsp 0.49.9 (55d7847); MIT copyright 2026 narumiruna.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, mock as mocks } from "node:test";
import { createMockContext, createMockPi } from "./host.ts";
import type { LspClient } from "../../src/pi-lsp/lsp-client.ts";
import { deferred, fixture } from "./lifecycle-support.ts";

async function harness(scenario = "lifecycle-normal") {
  const f = fixture(scenario);
  const agentDir = path.join(f.root, "agent");
  mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { default: lsp } = await import("../../src/pi-lsp/pi-lsp.ts");
  // The factory owns a fresh session map; the backend module identity is shared.
  const { LspClient: Client } = await import("../../src/pi-lsp/lsp-client.ts");
  const mock = createMockPi();
  lsp(mock.pi);
  writeFileSync(
    path.join(agentDir, "metis-pi.toml"),
    stringify({ lsp: {
      timeout: 1_000,
      servers: {
        fixture: {
          command: [f.adapter.defaultCommand.command, ...f.adapter.defaultCommand.args],
          extensions: [".go"],
          env: f.adapter.env,
        },
      },
    } }),
  );
  const context = createMockContext({ cwd: f.root }) as Omit<ReturnType<typeof createMockContext>, "ctx"> & {
    ctx: ExtensionContext;
  };
  let stale = false;
  let staleAccesses = 0;
  const ctx = Object.create(context.ctx, {
    ui: {
      get() {
        if (stale) {
          staleAccesses++;
          throw new Error("stale context");
        }
        return context.ctx.ui;
      },
    },
  });
  async function emit(name: string, reason = "quit", target = ctx) {
    for (const handler of mock.events.get(name) ?? []) await handler({ type: name, reason }, target);
  }
  function execute(kind: "diagnostics" | "fix", target = ctx, params = {}) {
    const tool = mock.tools.find((tool) => tool.name === "lsp");
    assert.ok(tool);
    return f.track(
      (tool.execute as (...args: unknown[]) => Promise<unknown>)(
        "test",
        { action: kind, root: f.root, path: "main.go", paths: ["main.go"], write: true, ...params },
        f.controller.signal,
        undefined,
        target,
      ),
    );
  }
  return {
    ...f,
    Client,
    mock,
    context,
    ctx,
    emit,
    execute,
    invalidate() {
      stale = true;
    },
    staleAccesses: () => staleAccesses,
    async dispose() {
      await f.dispose();
      mocks.restoreAll();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  };
}

for (const kind of ["diagnostics", "fix"] as const) {
  for (const method of [
    "initialize",
    "textDocument/diagnostic",
    ...(kind === "fix" ? ["textDocument/codeAction", "codeAction/resolve"] : []),
  ]) {
    for (const reason of ["quit", "reload"] as const) {
      test(`${kind}: active ${reason} drains pending ${method} before invalidation`, async () => {
        const h = await harness(`lifecycle-hang-${method}`);
        try {
          await h.emit("session_start", "startup");
          const task = h.execute(kind);
          await h.ready(method);
          const shutdown = h.emit("session_shutdown", reason);
          const repeated = h.emit("session_shutdown", reason);
          await assert.rejects(h.execute(kind, h.ctx, { server: "missing" }), /closing|aborted/);
          await Promise.all([shutdown, repeated]);
          h.exited();
          h.invalidate();
          await assert.rejects(task, /cancelled|aborted/);
          assert.equal(h.staleAccesses(), 0);
          assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
          assert.equal(readFileSync(h.file, "utf8"), "package main\n");
        } finally {
          await h.dispose();
        }
      });
    }
  }
}

test("shutdown waits for every sibling, even after one operation fails; restart waits for drain", async () => {
  const h = await harness();
  const ready = [deferred(), deferred()];
  const gates = [deferred(), deferred()];
  let index = 0;
  const diagnostics = h.Client.prototype.diagnostics;
  mocks.method(h.Client.prototype, "diagnostics").mock.mockImplementation(async function (this: LspClient, uri) {
    const id = index++;
    const result = await diagnostics.call(this, uri);
    if (id < 2) {
      ready[id].resolve();
      await gates[id].promise;
    }
    if (id === 0) throw new Error("original operation failure");
    return result;
  });
  try {
    const first = h.execute("diagnostics");
    await ready[0].promise;
    const second = h.execute("diagnostics");
    await ready[1].promise;
    let settled = false;
    const closing = h.emit("session_shutdown").then(() => {
      settled = true;
    });
    const restarting = h.emit("session_start", "reload");
    gates[0].resolve();
    await assert.rejects(first, /original operation failure/);
    assert.equal(settled, false);
    await assert.rejects(h.execute("diagnostics", h.ctx, { server: "missing" }), /closing|aborted/);
    gates[1].resolve();
    await assert.rejects(second, /aborted|cancelled/);
    await Promise.all([closing, restarting]);
    await h.execute("diagnostics");
    h.exited();
  } finally {
    for (const gate of gates) gate.resolve();
    await h.dispose();
  }
});

test("session managers sharing one headless UI have independent cancellation scopes", async () => {
  const h = await harness();
  const gate = deferred();
  const ready = deferred();
  const diagnostics = h.Client.prototype.diagnostics;
  let count = 0;
  mocks.method(h.Client.prototype, "diagnostics").mock.mockImplementation(async function (this: LspClient, uri) {
    const result = await diagnostics.call(this, uri);
    if (++count === 2) ready.resolve();
    await gate.promise;
    return result;
  });
  const other = createMockContext({ cwd: h.root, ui: h.context.ctx.ui });
  // The mock helper owns its UI; explicitly reuse exactly the same object.
  const otherCtx = Object.create(other.ctx, { ui: { value: h.context.ctx.ui } });
  try {
    const first = h.execute("diagnostics");
    const second = h.execute("diagnostics", otherCtx);
    await ready.promise;
    const shutdown = h.emit("session_shutdown");
    gate.resolve();
    await assert.rejects(first, /aborted|cancelled/);
    await second;
    await shutdown;
    h.exited();
  } finally {
    gate.resolve();
    await h.dispose();
  }
});

test("shutdown after first route response prevents a later diagnostics route from starting", async () => {
  const h = await harness();
  const agentDir = path.join(h.root, "agent");
  const config = parse(readFileSync(path.join(agentDir, "metis-pi.toml"), "utf8")) as any;
  config.lsp.servers.second = { ...config.lsp.servers.fixture };
  writeFileSync(path.join(agentDir, "metis-pi.toml"), stringify(config));
  const ready = deferred();
  const gate = deferred();
  const shutdown = h.Client.prototype.shutdown;
  mocks.method(h.Client.prototype, "shutdown").mock.mockImplementation(async function (this: LspClient) {
    await shutdown.call(this);
    ready.resolve();
    await gate.promise;
  });
  try {
    const task = h.execute("diagnostics");
    await ready.promise;
    const closing = h.emit("session_shutdown");
    gate.resolve();
    await assert.rejects(task, /aborted|cancelled/);
    await closing;
    assert.equal(h.events().filter((event) => event.method === "ready").length, 1);
    h.exited();
  } finally {
    gate.resolve();
    await h.dispose();
  }
});

test("scope closure after a fix response prevents a late disk write", async () => {
  const h = await harness();
  let closing: Promise<void> | undefined;
  const resolve = h.Client.prototype.resolveActions;
  mocks.method(h.Client.prototype, "resolveActions").mock.mockImplementation(async function (this: LspClient, actions) {
    const result = await resolve.call(this, actions);
    closing = h.emit("session_shutdown");
    return result;
  });
  try {
    await assert.rejects(h.execute("fix"), /aborted|cancelled/);
    await closing;
    assert.equal(readFileSync(h.file, "utf8"), "package main\n");
    h.exited();
  } finally {
    await h.dispose();
  }
});

test("shutdown supersedes an awaiting session start without reopening its scope", async () => {
  const h = await harness();
  const ready = deferred();
  const gate = deferred();
  const diagnostics = h.Client.prototype.diagnostics;
  mocks.method(h.Client.prototype, "diagnostics").mock.mockImplementation(async function (this: LspClient, uri) {
    const result = await diagnostics.call(this, uri);
    ready.resolve();
    await gate.promise;
    return result;
  });
  try {
    const task = h.execute("diagnostics");
    await ready.promise;
    const starting = h.emit("session_start", "reload");
    const closing = h.emit("session_shutdown");
    gate.resolve();
    await assert.rejects(task, /aborted|cancelled/);
    await Promise.all([starting, closing]);
    await assert.rejects(h.execute("diagnostics", h.ctx, { server: "missing" }), /closing/);
    h.exited();
  } finally {
    gate.resolve();
    await h.dispose();
  }
});

test("throwing shutdown UI cannot prevent cancellation or settlement", async () => {
  const h = await harness("lifecycle-hang-initialize");
  try {
    const task = h.execute("fix");
    await h.ready("initialize");
    const context = Object.create(h.ctx, {
      ui: {
        get() {
          throw new Error("UI unavailable");
        },
      },
    });
    await h.emit("session_shutdown", "quit", context);
    await assert.rejects(task, /aborted|cancelled/);
    h.exited();
  } finally {
    await h.dispose();
  }
});

test("abort-and-idle replacement and repeated idle lifecycle events leave no old work", async () => {
  const h = await harness("lifecycle-hang-textDocument/diagnostic");
  try {
    await h.emit("session_start", "startup");
    const task = h.execute("diagnostics");
    await h.ready("textDocument/diagnostic");
    h.controller.abort();
    await assert.rejects(task, /cancelled|aborted/);
    await h.emit("session_shutdown", "resume");
    h.exited();
    await h.emit("session_shutdown", "resume");
    await h.emit("session_start", "resume");
    await h.emit("session_shutdown");
  } finally {
    await h.dispose();
  }
});
