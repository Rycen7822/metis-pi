import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SkillInvocationMessageComponent,
  discoverAndLoadExtensions, getMarkdownTheme, initTheme, type MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { installSkillLabelNames } from "../../src/skills/label.ts";
import { patchHostPrototype } from "../../src/presentation/host-patch.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";

initTheme("dark", false);
const block = {
  name: "skill", location: "/skills/skill/SKILL.md", userMessage: undefined,
  content: `<skill name=" other " location="/skills/other/SKILL.md">
body of other
</skill>
<skill name="skill" location="/skills/skill/SKILL.md">
repeated body
</skill>`,
};
const method = "getDisplayName";
const capable = typeof Reflect.get(SkillInvocationMessageComponent.prototype, method) === "function";
const rendered = (entry: SkillInvocationMessageComponent) => strip(entry.render(160).join("\n"));
const descriptor = (target: object, key: string) => Object.getOwnPropertyDescriptor(target, key);
const mouse = (type: TuiMouseEvent["type"], extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type, button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 160, height: 10,
  shift: false, alt: false, ctrl: false, ...extra,
});

test("skill labels use native presentation without owning layouts or mouse gestures", t => {
  class Entry extends SkillInvocationMessageComponent {}
  const forwarded = { handled: true as const };
  const prior = t.mock.method(Entry.prototype, "handleMouse", () => forwarded);
  const priorMouse = descriptor(Entry.prototype, "handleMouse");
  const display = Reflect.get(Entry.prototype, "updateDisplay");
  const first = installSkillLabelNames(Entry), second = installSkillLabelNames(Entry);
  t.after(() => { first.release(); second.release(); });
  assert.deepEqual([first.state, second.state], capable ? ["patched", "already"] : ["missing", "missing"]);
  assert.equal(Reflect.get(Entry.prototype, "updateDisplay"), display, "rendering stays wholly native");
  assert.deepEqual(descriptor(Entry.prototype, "handleMouse"), priorMouse);
  const baseline = new SkillInvocationMessageComponent({ ...block, name: capable ? "skill + other" : block.name });
  const entry = new Entry(block);
  assert.deepEqual(entry.render(160), baseline.render(160), "ANSI, key hints and invocation order remain native");
  const spaced = { ...block, name: " skill " };
  const expectedSpaced = capable ? { ...block, name: "skill + other" } : spaced;
  assert.deepEqual(new Entry(spaced).render(160), new SkillInvocationMessageComponent(expectedSpaced).render(160));
  const single = { ...block, content: "single skill body" };
  assert.deepEqual(new Entry(single).render(160), new SkillInvocationMessageComponent(single).render(160));
  for (const expanded of [true, false]) {
    entry.setExpanded(expanded); baseline.setExpanded(expanded);
    assert.ok(entry.children[0] instanceof MouseRegion);
    assert.deepEqual(entry.render(160), baseline.render(160));
    assert.equal(rendered(entry).includes("body of other"), expanded);
  }
  const before = entry.render(160);
  const events = [mouse("press"), mouse("click"), mouse("press", { shift: true }),
    mouse("click", { ctrl: true }), mouse("click", { alt: true }), mouse("press", { button: "right" }),
    mouse("wheel", { button: "none" }), mouse("release"), undefined];
  for (const event of events) {
    assert.equal(Reflect.apply(entry.handleMouse, entry, [event]), forwarded);
    assert.equal(prior.mock.calls.at(-1)?.this, entry);
  }
  assert.deepEqual(prior.mock.calls.map(call => call.arguments), events.map(event => [event]));
  assert.deepEqual(entry.render(160), before);
  first.release(); second.release();
  assert.equal(Object.hasOwn(Entry.prototype, method), false);
});

test("skill display leases share ownership, restore descriptors and leave retained wrappers inert", () => {
  // A display-data boundary, not a replacement native renderer. Renderer identity is covered above.
  class Host { getDisplayName(value: typeof block) { return value.name; } }
  const native = descriptor(Host.prototype, method);
  assert.ok(native);
  const first = installSkillLabelNames(Host), second = installSkillLabelNames(Host);
  assert.deepEqual([first.state, second.state], ["patched", "already"]);
  const patched = Host.prototype.getDisplayName;
  assert.equal(new Host().getDisplayName(block), "skill + other");
  first.release(); first.release();
  assert.equal(Host.prototype.getDisplayName, patched);
  assert.equal(new Host().getDisplayName(block), "skill + other");
  second.release();
  assert.deepEqual(descriptor(Host.prototype, method), native);
  assert.equal(new Host().getDisplayName(block), "skill");

  const reinstall = installSkillLabelNames(Host);
  const retained = Host.prototype.getDisplayName;
  const later = function (this: Host, value: typeof block) { return retained.call(this, value); };
  Object.defineProperty(Host.prototype, method, { ...native, value: later });
  reinstall.release();
  assert.equal(Host.prototype.getDisplayName, later);
  assert.equal(new Host().getDisplayName(block), "skill", "released inner decoration is transparent");
  Object.defineProperty(Host.prototype, method, native);
  for (const unsupported of [undefined, {}, () => {}, class Empty {}]) {
    const missing = installSkillLabelNames(unsupported);
    assert.equal(missing.state, "missing");
    missing.release();
  }
});

test("fresh module copies share host leases and restricted descriptors stay native", async () => {
  const fresh = await import(new URL("../../src/presentation/host-patch.ts?another-copy", import.meta.url).href);
  let decorations = 0;
  class Host { value() { return "native"; } }
  const native = descriptor(Host.prototype, "value");
  const decorate = (original: unknown) => function (this: unknown, ...args: never[]) {
    decorations++;
    return Reflect.apply(original as (...args: never[]) => unknown, this, args);
  };
  const first = patchHostPrototype(Host, "value", decorate);
  const second = fresh.patchHostPrototype(Host, "value", decorate);
  assert.equal(new Host().value(), "native");
  assert.equal(decorations, 1);
  first.release(); second.release();
  assert.deepEqual(descriptor(Host.prototype, "value"), native);
  Object.freeze(Host.prototype);
  const refused = patchHostPrototype(Host, "value", decorate);
  assert.equal(refused.state, "missing");
  refused.release();
  assert.deepEqual(descriptor(Host.prototype, "value"), { ...native, writable: false, configurable: false });
});

test("expanded skill transformers receive only unchanged content, including a leading name", t => {
  class Entry extends SkillInvocationMessageComponent {}
  const lease = installSkillLabelNames(Entry);
  t.after(() => lease.release());
  for (const name of ["alpha", "skill"]) {
    const content = `${name} is literal body text.\n\n<skill name="other">nested</skill>`;
    const input = { ...block, name, content };
    const calls: { text: string; context: MarkdownTransformContext }[] = [];
    const entry = new Entry(input, getMarkdownTheme(), 1, [(text, context) => {
      calls.push({ text, context }); return text;
    }], "skill-message", "2026-01-01T00:00:00.000Z");
    entry.setExpanded(true);
    const text = rendered(entry);
    assert.ok(text.includes(capable ? `${name} + other` : name));
    assert.ok(text.includes(`${name} is literal body text.`));
    assert.equal(input.content, content);
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.text, content);
      assert.equal(call.context.messageType, "custom");
      assert.equal(call.context.messageId, "skill-message");
      assert.equal(call.context.timestamp, "2026-01-01T00:00:00.000Z");
      assert.ok(call.context.availableWidth > 0);
    }
  }
});

const skillEntryPath = fileURLToPath(new URL("../../extensions/skill-entry.ts", import.meta.url));
async function loadSkillEntry(t: TestContext) {
  const root = temporaryDirectory(t, "metis-skill-entry-");
  const loaded = await discoverAndLoadExtensions([skillEntryPath], root, join(root, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const models = new ModelRegistry(await ModelRuntime.create({
    authPath: join(root, "agent", "auth.json"), modelsPath: join(root, "agent", "models.json"),
    modelsStorePath: join(root, "agent", "models-store.json"), refreshOnCreate: false,
  }));
  return new ExtensionRunner(loaded.extensions, loaded.runtime, root, SessionManager.inMemory(root), models);
}

test("the real skill entry leases only display data and restores it on unload/reload", async t => {
  const prototype = SkillInvocationMessageComponent.prototype;
  const native = { mouse: descriptor(prototype, "handleMouse"), display: descriptor(prototype, "updateDisplay"),
    name: descriptor(prototype, method) };
  const first = await loadSkillEntry(t);
  assert.equal(first.hasHandlers("session_shutdown"), true);
  assert.deepEqual(descriptor(prototype, "handleMouse"), native.mouse);
  assert.deepEqual(descriptor(prototype, "updateDisplay"), native.display);
  assert.equal(descriptor(prototype, method)?.value !== native.name?.value, capable);
  assert.equal(rendered(new SkillInvocationMessageComponent(block)).includes("skill + other"), capable);
  await first.emit({ type: "session_shutdown", reason: "reload" });
  assert.deepEqual(descriptor(prototype, method), native.name);
  assert.doesNotMatch(rendered(new SkillInvocationMessageComponent(block)), /skill \+ other/);
  const second = await loadSkillEntry(t);
  assert.equal(descriptor(prototype, method)?.value !== native.name?.value, capable);
  await second.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(descriptor(prototype, method), native.name);
  assert.deepEqual(descriptor(prototype, "handleMouse"), native.mouse);
  assert.deepEqual(descriptor(prototype, "updateDisplay"), native.display);
});
