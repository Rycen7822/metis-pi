import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate as flush } from "node:timers/promises";
import { createWindowsClipboard } from "../../src/selection-copy/windows-clipboard.ts";

// Query settled values without adding a second mutable state machine to the fake.
const values = (promises) => Promise.all(promises.map((promise) => Promise.race([promise, "pending"])));

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = t.mock.method(globalThis, "setTimeout");
  const clears = t.mock.method(globalThis, "clearTimeout");
  // A kill records a request only. Tests, never kill(), decide when exit/close arrives.
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null, kill: t.mock.fn(() => true) });
  for (const name of ["stdin", "stdout"]) child[name] = Object.assign(new EventEmitter(), {
    destroyed: false, destroy() { this.destroyed = true; },
  });
  child.stdin.write = t.mock.fn(() => {
    assert.equal(child.stdin.destroyed, false, "nothing writes to a closed pipe");
    return true;
  });
  const spawn = t.mock.method(childProcess, "spawn", () => child);
  const clipboard = createWindowsClipboard();
  const output = (text) => child.stdout.emit("data", Buffer.from(text));
  const writes = () => child.stdin.write.mock.calls.map((call) => call.arguments[0]);
  const kills = () => child.kill.mock.calls.map((call) => call.arguments[0]);
  const exit = (code) => { child.exitCode = code; child.emit("exit", code); };
  const close = () => { exit(child.exitCode ?? 0); child.emit("close"); };
  t.after(() => {
    clipboard.dispose();
    close();
    assert.ok(child.stdin.destroyed && child.stdout.destroyed);
    for (const emitter of [child, child.stdin, child.stdout]) assert.deepEqual(emitter.eventNames(), []);
    const cleared = new Set(clears.mock.calls.map((call) => call.arguments[0]));
    for (const call of timers.mock.calls) assert.ok(cleared.has(call.result), "every deadline is cleared");
  });
  async function fail(copies, trigger, expectedKills = ["SIGKILL"]) {
    const sent = writes();
    trigger();
    await flush();
    assert.deepEqual(kills(), expectedKills);
    assert.ok(child.stdin.destroyed && child.stdout.destroyed);
    clipboard.dispose(); clipboard.dispose();
    t.mock.timers.tick(20_000);
    const pending = [...copies, clipboard.copy("must not be sent")];
    output("KK");
    output("RKK");
    await flush();
    assert.deepEqual(await values(pending), pending.map(() => "pending"), "failure and later requests wait for close, not kill/exit");
    assert.deepEqual(writes(), sent);
    close();
    assert.deepEqual(await Promise.all(pending), pending.map(() => false));
    assert.equal(await clipboard.copy("after close"), false);
    output("KR");
    clipboard.dispose(); clipboard.dispose();
    t.mock.timers.tick(20_000);
    assert.deepEqual(writes(), sent);
    assert.deepEqual(kills(), expectedKills);
  }
  return { child, clipboard, spawn, output, writes, kills, exit, fail };
}

test("one STA worker gates cold copies, preserves exact bytes and acknowledges cold/warm queues in order", async (t) => {
  const { child, clipboard, spawn, output, writes } = fixture(t);
  assert.equal(spawn.mock.callCount(), 1);
  const [command, args, options] = spawn.mock.calls[0].arguments;
  assert.equal(command, "powershell.exe");
  assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]);
  assert.deepEqual(options, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  for (const pattern of [
    /Add-Type -AssemblyName System\.Windows\.Forms[\s\S]*Write\('R'\)/,
    /\[Console\]::ReadLine\(\)/,
    /\[System\.Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\(\$line\)\)/,
    /if \(\$text\.Length -eq 0\)\s*\{\s*\[System\.Windows\.Forms\.Clipboard\]::Clear\(\)/,
    /Clipboard\]::SetText\(\$text, \[System\.Windows\.Forms\.TextDataFormat\]::UnicodeText\)[\s\S]*Write\('K'\)/,
    /catch\s*\{\s*exit 1/,
  ]) assert.match(script, pattern);
  assert.doesNotMatch(script, /clip\.exe|Trim\(|WriteAll|Write-Output|Write-Error|-Append/);
  const texts = ["\uFEFFleading BOM\nLF\r\nCRLF\rCR", "你好 e\u0301 👩‍👩‍👦", " \t\n\r\n  ", "", "no final newline"];
  const copies = texts.map((text) => clipboard.copy(text));
  await flush();
  assert.deepEqual(writes(), [], "cold copies wait for readiness");
  assert.deepEqual(await values([clipboard.ready, ...copies]), Array(6).fill("pending"));
  output("R");
  assert.equal(await clipboard.ready, true);
  await flush();
  assert.deepEqual(writes(), texts.map((text) => `${Buffer.from(text, "utf8").toString("base64")}\n`));
  output("K");
  await flush();
  assert.deepEqual(await values(copies), [true, "pending", "pending", "pending", "pending"]);
  copies.push(clipboard.copy("warm"));
  await flush();
  assert.deepEqual(writes(), [...texts, "warm"].map((text) => `${Buffer.from(text, "utf8").toString("base64")}\n`));
  output("KK");
  await flush();
  assert.deepEqual(await values(copies), [true, true, true, "pending", "pending", "pending"]);
  output("KKK");
  assert.deepEqual(await Promise.all(copies), Array(6).fill(true));
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 0, "successful copies keep the worker alive");
});

for (const [warm, faults] of [[true, [
  ["child error", ({ child }) => child.emit("error", new Error("worker failed"))],
  ["stdin EPIPE", ({ child }) => child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }))],
  ["stdout error", ({ child }) => child.stdout.emit("error", new Error("read failed"))],
  ["stdout EOF", ({ child }) => child.stdout.emit("end")],
  ["write callback error", ({ child }) => child.stdin.write.mock.calls[0].arguments[1](new Error("EPIPE"))],
  ["malformed protocol", ({ output }) => output("unexpected")],
  ["duplicate ready", ({ output }) => output("R")],
  ["oversized response", ({ output }) => { output("x".repeat(32)); output("x".repeat(65_536)); }],
  ["unexpected exit 0", ({ exit }) => exit(0), []],
  ["native clipboard failure", ({ exit }) => exit(1), []],
]], [false, [
  ["ENOENT", ({ child }) => { child.pid = undefined; child.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" })); }, []],
  ["startup failure", ({ exit }) => exit(1), []],
  ["unsolicited acknowledgement", ({ output }) => output("K")],
]]]) for (const [name, trigger, kills] of [...faults, ["disposal", ({ clipboard }) => clipboard.dispose()]]) {
  test(`${warm ? "warm" : "cold"} ${name}: stop, await close, ignore late acknowledgements`, async (t) => {
    const f = fixture(t);
    if (warm) f.output("R");
    const copies = [f.clipboard.copy("first"), f.clipboard.copy("second")];
    if (!warm) copies.unshift(f.clipboard.ready);
    await flush();
    await f.fail(copies, () => trigger(f), kills);
    assert.equal(await f.clipboard.ready, warm);
  });
}

test("synchronous write exceptions close the worker without rejecting copies", async (t) => {
  const { child, clipboard, output, fail } = fixture(t);
  output("R");
  child.stdin.write.mock.mockImplementation(() => { throw new Error("pipe closed"); });
  const copy = clipboard.copy("text");
  await flush();
  await fail([copy], () => {});
});

test("synchronous spawn exceptions produce an inert worker", async (t) => {
  const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("spawn failed"); });
  const clipboard = createWindowsClipboard();
  assert.equal(spawn.mock.callCount(), 1);
  assert.deepEqual(await Promise.all([clipboard.ready, clipboard.copy("text")]), [false, false]);
  clipboard.dispose(); clipboard.dispose();
});

test("startup has a five-second deadline without sending queued text", async (t) => {
  const { clipboard, kills, fail } = fixture(t);
  const copy = clipboard.copy("text");
  t.mock.timers.tick(4_999);
  assert.deepEqual(kills(), []);
  await fail([clipboard.ready, copy], () => t.mock.timers.tick(1));
});

test("each copy gets five seconds; acknowledged requests cannot time out later", async (t) => {
  const { clipboard, output, kills, fail } = fixture(t);
  output("R");
  const first = clipboard.copy("first");
  await flush();
  t.mock.timers.tick(2_000);
  const second = clipboard.copy("second");
  await flush();
  output("K");
  assert.equal(await first, true);
  t.mock.timers.tick(4_999);
  assert.deepEqual(kills(), []);
  await fail([second], () => t.mock.timers.tick(1));
});
