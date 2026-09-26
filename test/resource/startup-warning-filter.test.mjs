import test from "node:test";
import assert from "node:assert/strict";
import { installStartupWarningFilter } from "../../src/startup-warning-filter.ts";
import { activate } from "../../src/extension.ts";
import { bindings } from "../helpers.mjs";

const warning = "[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.";

test("exact filtering, replacement ownership and foreign wrappers share one warning lifetime", () => {
  const calls = [];
  const target = { warn(...args) { calls.push({ receiver: this, args }); } };
  const original = target.warn;
  const handle = installStartupWarningFilter(target);
  try {
    target.warn(warning);
    assert.equal(calls.length, 0);
    const error = new Error("permission denied");
    for (const args of [["another warning"], [error], [warning, error], ["%s", warning], []]) {
      target.warn(...args);
      assert.deepEqual(calls.at(-1), { receiver: target, args });
    }
  } finally { handle.dispose(); }
  assert.equal(target.warn, original);
  target.warn(warning);
  assert.equal(calls.at(-1).args[0], warning);
  calls.length = 0;
  const first = installStartupWarningFilter(target);
  const second = installStartupWarningFilter(target);
  first.dispose();
  target.warn(warning);
  assert.equal(calls.length, 0);
  const wrapped = target.warn;
  const foreign = (...args) => wrapped(...args);
  target.warn = foreign;
  second.dispose();
  second.dispose();
  assert.equal(target.warn, foreign);
  target.warn(warning);
  assert.deepEqual(calls.map((call) => call.args), [[warning]], "a disposed filter in a foreign chain is inert");
  target.warn = original;
});

test("TUI lifecycle filters child startup output; headless/RPC children cannot remove the parent filter", async (t) => {
  const calls = [];
  t.mock.method(console, "warn", (...args) => calls.push(args));
  const baseline = console.warn;
  const error = console.error;
  function session() {
    const events = new Map();
    activate({ on: (name, fn) => events.set(name, fn), getAllTools: () => [] }, { ...bindings, prototype: {} });
    t.after(() => events.get("session_shutdown")());
    return events;
  }
  const parent = session();
  console.warn(warning);
  parent.get("session_start")({}, { mode: "tui", hasUI: true, ui: { notify() {} } });
  const wrapper = console.warn;
  for (const mode of ["json", "rpc"]) {
    const child = session();
    child.get("session_start")({}, { mode, hasUI: mode === "rpc", ui: { notify() {} } });
    await Promise.resolve();
    console.warn(warning);
    child.get("session_shutdown")();
    assert.equal(console.warn, wrapper);
  }
  assert.deepEqual(calls, [[warning]]);
  assert.equal(console.error, error);
  parent.get("session_shutdown")();
  assert.equal(console.warn, baseline);
  console.warn(warning);
  assert.deepEqual(calls, [[warning], [warning]]);

});
