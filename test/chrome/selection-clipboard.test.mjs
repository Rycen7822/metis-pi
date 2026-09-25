import test from "node:test";
import assert from "node:assert/strict";
import { createInteractiveTuiReference } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { createSelectionClipboard, needsWindowsClipboard } from "../../src/selection-copy/clipboard.ts";

function fixture(t, copy = async () => true) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const env = process.env;
  Object.defineProperty(process, "platform", { value: "linux" });
  process.env = { WSL_DISTRO_NAME: "test" };
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    process.env = env;
  });
  class Renderer {
    terminal = {};
    nativeCopies = [];
    flashes = [];
    copySelection = async (text) => { this.nativeCopies.push(text); return true; };
    async copyTextToClipboard(text) {
      const result = await this.copySelection(text);
      this.flashes.push(result === true ? "Copied!" : result);
      return result === true;
    }
  }
  const writes = [];
  const worker = { ready: Promise.resolve(true), copy: (text) => { writes.push(text); return copy(text); }, dispose() { this.disposed = true; } };
  const create = t.mock.fn(() => worker);
  const system = createSelectionClipboard(create);
  t.after(() => system.dispose());
  let current = new Renderer();
  const facade = createInteractiveTuiReference(() => current);
  return { Renderer, system, worker, writes, facade, current, created: () => create.mock.callCount(), retarget: (next) => { current = next; } };
}

test("only local WSL without the host's fast Windows Terminal route needs a worker", () => {
  assert.equal(needsWindowsClipboard("linux", { WSL_DISTRO_NAME: "Ubuntu" }), true);
  assert.equal(needsWindowsClipboard("linux", { WSL_INTEROP: "/run/WSL/1_interop" }), true);
  for (const platform of ["win32", "darwin"]) assert.equal(needsWindowsClipboard(platform, { WSL_DISTRO_NAME: "Ubuntu" }), false);
  assert.equal(needsWindowsClipboard("linux", {}), false);
  for (const remote of ["WT_SESSION", "SSH_TTY", "SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"]) {
    assert.equal(needsWindowsClipboard("linux", { WSL_DISTRO_NAME: "Ubuntu", [remote]: "present" }), false);
  }
});

for (const [outcome, acknowledgement, flash] of [
  ["copied", true, "Copied!"], ["fallback", false, "clipboard denied"], ["cancelled", false, false],
]) {
  test(`real facade: ${outcome} preserves callback identity, feedback and lease cleanup`, async (t) => {
    const pending = Promise.withResolvers();
    const f = fixture(t, () => pending.promise);
    const before = Object.getOwnPropertyDescriptors(f.Renderer.prototype);
    const callback = f.current.copySelection = async (text) => {
      f.current.nativeCopies.push(text);
      return "clipboard denied";
    };
    f.system.install(f.facade);
    f.system.install(f.facade);
    assert.equal(f.created(), 1, "repeated capture does not start another process");
    const value = "\uFEFF中文😀\n  indentation\r\n\t";
    const copying = f.facade.copyTextToClipboard(value);
    assert.equal(f.current.copySelection, callback, "callback restored before asynchronous completion");
    assert.deepEqual(f.writes, [value]);
    assert.deepEqual(f.current.flashes, [], "no feedback before acknowledgement");
    if (outcome === "cancelled") f.system.dispose();
    pending.resolve(acknowledgement);
    assert.equal(await copying, acknowledgement);
    assert.deepEqual(f.current.nativeCopies, outcome === "fallback" ? [value] : []);
    assert.deepEqual(f.current.flashes, [flash]);
    f.system.dispose();
    assert.equal(f.worker.disposed, true);
    assert.deepEqual(Object.getOwnPropertyDescriptors(f.Renderer.prototype), before);
  });
}

test("shared prototypes/terminals do not broaden ownership; facade retargeting drops the old receiver", async (t) => {
  const f = fixture(t);
  const other = new f.Renderer();
  other.terminal = f.current.terminal;
  f.system.install(f.facade);
  await other.copyTextToClipboard("other");
  assert.deepEqual(f.writes, []);
  f.retarget(other);
  await f.current.copyTextToClipboard("old");
  await f.facade.copyTextToClipboard("new");
  assert.deepEqual(f.writes, ["new"]);
  assert.deepEqual(f.current.nativeCopies, ["old"]);
  assert.deepEqual(other.nativeCopies, ["other"]);
});

test("failed installation rolls back the receiver getter and original method", (t) => {
  const f = fixture(t);
  const original = Object.getOwnPropertyDescriptor(f.Renderer.prototype, "copyTextToClipboard");
  Object.defineProperty(f.Renderer.prototype, "copyTextToClipboard", { ...original, configurable: false, writable: false });
  const symbols = Object.getOwnPropertySymbols(f.Renderer.prototype);
  f.system.install(f.facade);
  assert.deepEqual(Object.getOwnPropertySymbols(f.Renderer.prototype), symbols);
  assert.equal(f.Renderer.prototype.copyTextToClipboard, original.value);
  assert.equal(f.created(), 0);
});

test("disposal preserves foreign wrappers, and a buried lease stays inert after reinstall", async (t) => {
  const f = fixture(t);
  f.system.install(f.facade);
  const captured = f.Renderer.prototype.copyTextToClipboard;
  const foreign = function (text) { return captured.call(this, text); };
  f.Renderer.prototype.copyTextToClipboard = foreign;
  f.system.dispose();
  assert.equal(f.Renderer.prototype.copyTextToClipboard, foreign);
  await f.facade.copyTextToClipboard("native");
  assert.deepEqual(f.writes, []);
  f.system.install(f.facade);
  await f.facade.copyTextToClipboard("fast");
  assert.deepEqual(f.writes, ["fast"]);
  assert.deepEqual(f.current.nativeCopies, ["native"]);
});
