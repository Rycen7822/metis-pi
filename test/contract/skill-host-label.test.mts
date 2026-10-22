import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SkillInvocationMessageComponent,
  discoverAndLoadExtensions, initTheme,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { installSkillLabelNames } from "../../src/skills/label.ts";
import { patchHostPrototype, type SkillPatch } from "../../src/skills/host-patch.ts";
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
const rendered = (entry: SkillInvocationMessageComponent) => strip(entry.render(160).join("\n"));
const mouse = (type: TuiMouseEvent["type"], extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type, button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 160, height: 10,
  shift: false, alt: false, ctrl: false, ...extra,
});
const descriptor = (target: object, method: string) => Object.getOwnPropertyDescriptor(target, method);

test("skill labels survive native rebuilds without taking ownership of mouse gestures", (t) => {
  class Entry extends SkillInvocationMessageComponent {}
  const forwarded = { handled: true as const };
  const prior = t.mock.method(Entry.prototype, "handleMouse", () => forwarded);
  const priorMouse = descriptor(Entry.prototype, "handleMouse");
  const leases: SkillPatch[] = [];
  const label = installSkillLabelNames(Entry);
  leases.push(label);
  assert.equal(label.state, "patched");
  const display = Reflect.get(Entry.prototype, "updateDisplay");
  const again = installSkillLabelNames(Entry);
  leases.push(again);
  assert.equal(again.state, "already");
  assert.equal(Reflect.get(Entry.prototype, "updateDisplay"), display);
  assert.deepEqual(descriptor(Entry.prototype, "handleMouse"), priorMouse);
  const baseline = new SkillInvocationMessageComponent({ ...block, name: "skill + other" });
  const entry = new Entry(block);
  assert.deepEqual(entry.render(160), baseline.render(160), "names join without changing native ANSI or hints");
  assert.deepEqual(new Entry({ ...block, name: " skill " }).render(160), baseline.render(160), "outer names are trimmed");
  const single = { ...block, content: "single skill body" };
  assert.deepEqual(new Entry(single).render(160), new SkillInvocationMessageComponent(single).render(160), "single skills stay native");
  for (const expanded of [true, false]) {
    entry.setExpanded(expanded);
    baseline.setExpanded(expanded);
    assert.ok(entry.children[0] instanceof MouseRegion, "the native pointer region remains intact");
    assert.deepEqual(entry.render(160), baseline.render(160), "rebuilt labels and body retain native rendering");
    assert.equal(rendered(entry).includes("body of other"), expanded);
  }
  const before = entry.render(160);
  const events = [
    mouse("press"), mouse("click"), mouse("press", { shift: true }), mouse("click", { ctrl: true }),
    mouse("click", { alt: true }), mouse("press", { button: "right" }),
    mouse("wheel", { button: "none" }), mouse("release"), undefined,
  ];
  for (const event of events) {
    assert.equal(Reflect.apply(entry.handleMouse, entry, [event]), forwarded, "prior return identity survives");
    assert.equal(prior.mock.calls.at(-1)?.this, entry, "prior handler keeps its receiver");
  }
  assert.deepEqual(prior.mock.calls.map((call) => call.arguments), events.map((event) => [event]));
  assert.deepEqual(entry.render(160), before, "delegated events leave rendering intact");
  for (const patch of leases) patch.release();
  assert.deepEqual(descriptor(Entry.prototype, "handleMouse"), priorMouse);
  assert.equal(Object.hasOwn(Entry.prototype, "updateDisplay"), false);
});

test("host labels are owned leases: release, shared owners, reinstall, own methods", () => {
  class Entry extends SkillInvocationMessageComponent {}
  const nativeDisplay = Reflect.get(SkillInvocationMessageComponent.prototype, "updateDisplay");
  const third = function (this: SkillInvocationMessageComponent) { return nativeDisplay.call(this); };
  Object.defineProperty(Entry.prototype, "updateDisplay", { value: third, writable: true, enumerable: false, configurable: true });
  const priorDisplay = descriptor(Entry.prototype, "updateDisplay");
  const nativeLabel = rendered(new SkillInvocationMessageComponent(block));
  const first = installSkillLabelNames(Entry);
  const second = installSkillLabelNames(Entry);
  assert.deepEqual([first.state, second.state], ["patched", "already"]);
  const patched = Reflect.get(Entry.prototype, "updateDisplay");
  first.release(); first.release();
  assert.equal(Reflect.get(Entry.prototype, "updateDisplay"), patched, "remaining owner keeps the decoration");
  assert.match(rendered(new Entry(block)), /skill \+ other/);
  second.release();
  assert.deepEqual(descriptor(Entry.prototype, "updateDisplay"), priorDisplay, "prior own descriptor returns");
  assert.equal(rendered(new Entry(block)), nativeLabel, "labels fall back to native text");

  const reinstall = installSkillLabelNames(Entry);
  assert.equal(reinstall.state, "patched");
  assert.notEqual(Reflect.get(Entry.prototype, "updateDisplay"), patched);
  const later = function (this: SkillInvocationMessageComponent) { return nativeDisplay.call(this); };
  Object.defineProperty(Entry.prototype, "updateDisplay", { ...priorDisplay, value: later });
  reinstall.release();
  assert.equal(Reflect.get(Entry.prototype, "updateDisplay"), later, "a later owner's method wins");
  Reflect.deleteProperty(Entry.prototype, "updateDisplay");
  const after = installSkillLabelNames(Entry);
  assert.equal(after.state, "patched", "no dangling lease");
  after.release();

  class OwnDisplay extends SkillInvocationMessageComponent {}
  Object.defineProperty(OwnDisplay.prototype, "updateDisplay", { value: third, writable: true, configurable: true });
  const own = descriptor(OwnDisplay.prototype, "updateDisplay");
  const owned = installSkillLabelNames(OwnDisplay);
  assert.equal(owned.state, "patched");
  owned.release();
  assert.deepEqual(descriptor(OwnDisplay.prototype, "updateDisplay"), own);
  for (const unsupported of [undefined, {}, () => {}, class Empty {}]) {
    const patch = installSkillLabelNames(unsupported);
    assert.equal(patch.state, "missing");
    patch.release();
  }
});

test("released skill labels are inert even when a later plugin retains the wrapper", () => {
  class Entry extends SkillInvocationMessageComponent {}
  const native = new SkillInvocationMessageComponent(block);
  const patch = installSkillLabelNames(Entry);
  const retained = Reflect.get(Entry.prototype, "updateDisplay");
  const later = function (this: SkillInvocationMessageComponent) { return retained.call(this); };
  Object.defineProperty(Entry.prototype, "updateDisplay", { value: later, writable: true, configurable: true });
  patch.release();
  assert.equal(Reflect.get(Entry.prototype, "updateDisplay"), later);
  assert.deepEqual(new Entry(block).render(160), native.render(160), "released labels cannot survive through another owner");
});

test("fresh module copies share the same host lease and restricted hosts stay native", async () => {
  const fresh = await import(new URL("../../src/skills/host-patch.ts?another-copy", import.meta.url).href);
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
  assert.equal(decorations, 1, "two copies must not stack the same decoration");
  first.release(); second.release();
  assert.deepEqual(descriptor(Host.prototype, "value"), native);
  Object.freeze(Host.prototype);
  const refused = patchHostPrototype(Host, "value", decorate);
  assert.equal(refused.state, "missing");
  refused.release();
  assert.deepEqual(descriptor(Host.prototype, "value"), { ...native, writable: false, configurable: false });
});

const skillEntryPath = fileURLToPath(new URL("../../extensions/skill-entry.ts", import.meta.url));

/** Load the real entry through Pi's own extension loader and give it a runner. */
async function loadSkillEntry(t: TestContext) {
  const root = temporaryDirectory(t, "metis-skill-entry-");
  const loaded = await discoverAndLoadExtensions([skillEntryPath], root, join(root, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const models = new ModelRegistry(await ModelRuntime.create({
    authPath: join(root, "agent", "auth.json"),
    modelsPath: join(root, "agent", "models.json"),
  }));
  return new ExtensionRunner(loaded.extensions, loaded.runtime, root, SessionManager.inMemory(root), models);
}

test("skill-entry owns its labels: unload/reload restores them without patching native mouse handling", async (t) => {
  const prototype = SkillInvocationMessageComponent.prototype;
  const native = {
    handleMouse: Object.getOwnPropertyDescriptor(prototype, "handleMouse"),
    updateDisplay: Object.getOwnPropertyDescriptor(prototype, "updateDisplay"),
  };
  assert.equal(native.handleMouse, undefined);
  assert.equal(typeof native.updateDisplay?.value, "function");
  const first = await loadSkillEntry(t);
  assert.equal(first.hasHandlers("session_shutdown"), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "handleMouse"), native.handleMouse);
  assert.notEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay")?.value, native.updateDisplay?.value,
    "label lease is acquired before any component is built");
  assert.match(rendered(new SkillInvocationMessageComponent(block)), /skill \+ other/);
  await first.emit({ type: "session_shutdown", reason: "reload" });
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "handleMouse"), native.handleMouse);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), native.updateDisplay);
  assert.doesNotMatch(rendered(new SkillInvocationMessageComponent(block)), /skill \+ other/);
  const second = await loadSkillEntry(t);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "handleMouse"), native.handleMouse);
  assert.notEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay")?.value, native.updateDisplay?.value);
  await second.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), native.updateDisplay);
});
