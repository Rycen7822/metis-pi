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
import { installSkillFoldClick } from "../../src/skills/fold.ts";
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

test("native skill labels and gestures survive rebuilds without stealing selection", (t) => {
  class Entry extends SkillInvocationMessageComponent {}
  const forwarded = { handled: true as const };
  // A prior plugin owns unclaimed events; native construction and toggles stay real.
  const prior = t.mock.method(Entry.prototype, "handleMouse", () => forwarded);
  const priorMouse = descriptor(Entry.prototype, "handleMouse");
  const leases: SkillPatch[] = [];
  const label = installSkillLabelNames(Entry);
  const fold = installSkillFoldClick(Entry);
  leases.push(label, fold);
  assert.equal(label.state, "patched");
  assert.equal(fold.state, "patched");
  const display = Reflect.get(Entry.prototype, "updateDisplay");
  const handler = Entry.prototype.handleMouse;
  // A second install by the same extension joins the shared wrapper: one toggle,
  // and that second owner can still release its own claim independently.
  const again = [installSkillLabelNames(Entry), installSkillFoldClick(Entry)];
  leases.push(...again);
  assert.deepEqual(again.map((patch) => patch.state), ["already", "already"]);
  assert.equal(Reflect.get(Entry.prototype, "updateDisplay"), display);
  assert.equal(Entry.prototype.handleMouse, handler);
  // Only Entry is patched; the native class renders the literal expected name.
  const baseline = new SkillInvocationMessageComponent({ ...block, name: "skill + other" });
  const entry = new Entry(block);
  assert.deepEqual(entry.render(160), baseline.render(160), "names join without changing native ANSI or hints");
  assert.deepEqual(new Entry({ ...block, name: " skill " }).render(160), baseline.render(160), "outer names are trimmed");
  const single = { ...block, content: "single skill body" };
  assert.deepEqual(new Entry(single).render(160), new SkillInvocationMessageComponent(single).render(160), "single skills stay native");
  assert.doesNotMatch(rendered(entry), /body of other/);
  for (const expanded of [true, false]) {
    const region = entry.children[0];
    assert.ok(region instanceof MouseRegion);
    const nativeHandler = t.mock.method(region, "handleMouse");
    assert.deepEqual(entry.handleMouse(mouse("press")), { handled: true });
    assert.equal(rendered(entry).includes("body of other"), !expanded, "press never toggles");
    assert.deepEqual(entry.handleMouse(mouse("click")), { handled: true });
    baseline.setExpanded(expanded);
    assert.deepEqual(entry.render(160), baseline.render(160), "rebuilt labels and the entire body retain native rendering");
    assert.equal(rendered(entry).includes("body of other"), expanded);
    assert.equal(nativeHandler.mock.callCount(), 0, "the nested native handler must not toggle again");
  }
  assert.equal(prior.mock.callCount(), 0, "accepted gestures never reach the prior handler");
  const before = entry.render(160);
  const events = [
    mouse("press", { shift: true }), mouse("click", { ctrl: true }), mouse("click", { alt: true }),
    mouse("press", { button: "right" }), mouse("wheel", { button: "none" }), mouse("release"), undefined,
  ];
  for (const event of events) {
    assert.equal(Reflect.apply(entry.handleMouse, entry, [event]), forwarded, "prior return identity survives");
    assert.equal(prior.mock.calls.at(-1)?.this, entry, "prior handler keeps its receiver");
  }
  assert.deepEqual(prior.mock.calls.map((call) => call.arguments), events.map((event) => [event]));
  assert.doesNotMatch(rendered(entry), /body of other/);
  assert.deepEqual(entry.render(160), before, "selection and delegated events leave rendering intact");
  // Releasing every owner hands the class back to the wrappers it had before us.
  for (const patch of leases) patch.release();
  assert.deepEqual(descriptor(Entry.prototype, "handleMouse"), priorMouse, "the prior plugin's descriptor is restored verbatim");
  assert.equal(Object.hasOwn(Entry.prototype, "updateDisplay"), false, "our own method is removed again");
});

test("host decorations are owned leases: release, shared owners, reinstall, host upgrades", () => {
  class Entry extends SkillInvocationMessageComponent {}
  // A non-enumerable own method proves release restores the descriptor, not just the value.
  const third = function (this: SkillInvocationMessageComponent, event?: TuiMouseEvent) {
    return event?.type === "press" ? { handled: true as const } : undefined;
  };
  Object.defineProperty(Entry.prototype, "handleMouse", { value: third, writable: true, enumerable: false, configurable: true });
  const priorMouse = descriptor(Entry.prototype, "handleMouse");
  const nativeLabel = strip(new SkillInvocationMessageComponent(block).render(160).join("\n"));

  const first = installSkillFoldClick(Entry);
  const labels = installSkillLabelNames(Entry);
  assert.deepEqual([first.state, labels.state], ["patched", "patched"]);
  assert.equal(rendered(new Entry(block)).includes("body of other"), false, "labels are joined while held");
  assert.match(rendered(new Entry({ ...block, name: "skill" })), /skill \+ other/);

  // A second owner (another enable path in the same process) shares the wrapper.
  const second = installSkillFoldClick(Entry);
  assert.equal(second.state, "already");
  const patched = Entry.prototype.handleMouse;
  first.release();
  first.release(); // idempotent: a repeated unload must not detach the remaining owner
  assert.equal(Entry.prototype.handleMouse, patched, "the remaining owner keeps the decoration");
  const entry = new Entry(block);
  assert.deepEqual(entry.handleMouse(mouse("click")), { handled: true }, "and it still toggles");
  second.release();
  assert.deepEqual(descriptor(Entry.prototype, "handleMouse"), priorMouse, "the pre-existing wrapper comes back");
  assert.equal(Reflect.apply(entry.handleMouse, entry, [mouse("click")]), undefined, "our gesture handler is gone");

  labels.release();
  assert.deepEqual(strip(new Entry(block).render(160).join("\n")), nativeLabel, "labels fall back to the host's own text");

  // A released install can be installed again, and a wrapper added after ours wins:
  // release must not overwrite the newer plugin's method.
  const reinstall = installSkillFoldClick(Entry);
  assert.equal(reinstall.state, "patched");
  assert.notEqual(Entry.prototype.handleMouse, patched);
  const later = function () { return undefined; };
  Entry.prototype.handleMouse = later as never;
  reinstall.release();
  assert.equal(Entry.prototype.handleMouse, later as never, "a later third-party wrapper is never overwritten");
  delete (Entry.prototype as { handleMouse?: unknown }).handleMouse;
  assert.equal(installSkillFoldClick(Entry).state, "patched", "the shared lease is not left dangling");

  // A newer host that ships its OWN method: release restores that method, not the base class one.
  class Upgraded extends SkillInvocationMessageComponent {
    override handleMouse(event: TuiMouseEvent) {
      return super.handleMouse(event);
    }
  }
  const own = descriptor(Upgraded.prototype, "handleMouse");
  const upgraded = installSkillFoldClick(Upgraded);
  assert.equal(upgraded.state, "patched");
  upgraded.release();
  assert.deepEqual(descriptor(Upgraded.prototype, "handleMouse"), own, "the upgraded implementation is restored");
  assert.equal(Object.hasOwn(Upgraded.prototype, "handleMouse"), true);
  // Degenerate hosts degrade instead of throwing, and still return a lease.
  for (const unsupported of [undefined, {}, () => {}]) {
    const patch = installSkillFoldClick(unsupported);
    assert.equal(patch.state, "missing");
    patch.release();
  }
  // A class without the method still gets the gesture (it inherits nothing to forward).
  class Empty {}
  const empty = installSkillFoldClick(Empty);
  assert.equal(empty.state, "patched");
  empty.release();
  assert.equal(Object.hasOwn(Empty.prototype, "handleMouse"), false);
});

test("released skill decorations are inert even when a later plugin retains the wrapper", () => {
  class Entry extends SkillInvocationMessageComponent {}
  const native = new SkillInvocationMessageComponent(block);
  const patch = installSkillFoldClick(Entry);
  const retained = Entry.prototype.handleMouse;
  const later = function (this: SkillInvocationMessageComponent, event: TuiMouseEvent) {
    return retained.call(this, event);
  };
  Entry.prototype.handleMouse = later;
  patch.release();
  const entry = new Entry(block);
  entry.handleMouse(mouse("click"));
  assert.equal(Entry.prototype.handleMouse, later);
  assert.deepEqual(entry.render(160), native.render(160), "released decoration cannot still toggle through another owner");
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

test("skill-entry owns its host decorations: unload/reload restores them, both stay independent", async (t) => {
  const prototype = SkillInvocationMessageComponent.prototype;
  // The host ships its own `updateDisplay`; `handleMouse` is inherited from Box.
  const native = {
    handleMouse: Object.getOwnPropertyDescriptor(prototype, "handleMouse"),
    updateDisplay: Object.getOwnPropertyDescriptor(prototype, "updateDisplay"),
  };
  assert.equal(native.handleMouse, undefined, "nothing patches the host class before the factory runs");
  assert.equal(typeof native.updateDisplay?.value, "function", "the host's own label method");

  const first = await loadSkillEntry(t);
  assert.equal(first.hasHandlers("session_shutdown"), true, "the factory owns a release hook");
  assert.deepEqual([Object.hasOwn(prototype, "handleMouse"), Object.hasOwn(prototype, "updateDisplay")], [true, true],
    "installed during the factory, before any component is built");
  const entry = new SkillInvocationMessageComponent(block);
  assert.match(rendered(entry), /skill \+ other/, "both decorations are live");

  // /reload emits session_shutdown on the old runner before the next generation loads.
  await first.emit({ type: "session_shutdown", reason: "reload" });
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "handleMouse"), native.handleMouse);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), native.updateDisplay,
    "the host's own descriptor is restored, not deleted");
  assert.doesNotMatch(rendered(new SkillInvocationMessageComponent(block)), /skill \+ other/, "labels are native again");

  const second = await loadSkillEntry(t);
  assert.equal(Object.hasOwn(prototype, "handleMouse"), true, "a later generation installs again");
  await second.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(Object.hasOwn(prototype, "handleMouse"), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), native.updateDisplay);
});
