import assert from "node:assert/strict";
import test from "node:test";
import { Container, MouseRegion, visibleWidth } from "@earendil-works/pi-tui";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_BASH_WIDGET_ID,
  renderBackgroundBashWidget,
  registerBackgroundBashWidgetShortcuts,
} from "../vendor/pi-codex-conversion/dist/ui/background-bash-widget.js";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../vendor/pi-codex-conversion/dist/adapter/activation/config-contract.js";

function fixture(mode = "tui") {
  let component;
  let updates = 0;
  let enabled = true;
  const snapshots = [20, 21].map(id => ({
    id, command: `printf '后台任务 ${id}'`, outputTail: `OUTPUT_${id}`, updatedAt: Date.now(), running: true,
  }));
  const state = { folded: true };
  const theme = { fg: (_role, text) => text };
  const terminated = [];
  const sessions = { listSessions: () => snapshots, terminateSession: id => terminated.push(id) };
  const shortcuts = new Map();
  const ctx = { mode, ui: { theme, setWidget(id, factory, options) {
    assert.equal(id, BACKGROUND_BASH_WIDGET_ID);
    if (factory) {
      assert.equal(options.placement, "aboveEditor");
      assert.equal(typeof factory, "function");
      component = factory({}, theme);
      assert.ok(component instanceof MouseRegion, "use the host's real mouse region, not raw terminal input");
    } else component = undefined;
    updates++;
  } } };
  const render = () => renderBackgroundBashWidget(ctx, state, sessions);
  registerBackgroundBashWidgetShortcuts({ registerShortcut: (key, handler) => shortcuts.set(key, handler) }, state, sessions, DEFAULT_CODEX_CONVERSION_CONFIG.ui, () => enabled);
  return {
    state, snapshots, terminated, ctx, render,
    get component() { return component; }, get updates() { return updates; },
    frame: (width = 80) => component?.render(width).join("\n") ?? "",
    mouse: (type = "click", button = "left") => component.handleMouse(mouseEvent(type, button)),
    key: key => shortcuts.get(key).handler(ctx), disable: () => { enabled = false; },
  };
}

function mouseEvent(type = "click", button = "left", y = 0) {
  return { type, button, x: 3, y, screenX: 3, screenY: y, width: 80, height: 20,
    shift: false, alt: false, ctrl: false, ...(type === "wheel" ? { wheelDelta: -1 } : {}) };
}

test("background shell left click expands and refolds using the same state as the shortcut", async () => {
  const f = fixture();
  f.render();
  assert.doesNotMatch(f.frame(), /OUTPUT_20/);
  assert.deepEqual(f.mouse(), { handled: true, requestRender: true });
  assert.equal(f.state.folded, false);
  assert.match(f.frame(), /OUTPUT_20/);
  assert.equal(f.state.activeSessionId, 20);
  for (const width of [12, 40, 80]) assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width));
  f.mouse();
  assert.equal(f.state.folded, true);
  assert.doesNotMatch(f.frame(), /OUTPUT_20/);
  await f.key("alt+w");
  assert.match(f.frame(), /OUTPUT_20/);
  f.mouse();
  assert.doesNotMatch(f.frame(), /OUTPUT_20/);
  assert.deepEqual(f.terminated, [], "folding must never affect process lifetime");
});

test("non-click gestures pass through; refresh, selection and close retain their behavior", async () => {
  const f = fixture();
  f.render();
  const before = f.updates;
  for (const [type, button] of [["click", "right"], ["click", "middle"], ["press", "left"], ["release", "left"], ["move", "none"], ["drag", "left"], ["wheel", "none"]]) {
    assert.equal(f.mouse(type, button), undefined);
    assert.equal(f.state.folded, true);
  }
  assert.equal(f.updates, before);
  f.mouse();
  f.snapshots[0].outputTail = "LATEST_OUTPUT";
  f.render();
  assert.match(f.frame(), /LATEST_OUTPUT/);
  assert.equal(f.state.folded, false, "output refresh must not reset the user's fold choice");
  await f.key("alt+e");
  assert.match(f.frame(), /OUTPUT_21/);
  f.mouse();
  await f.key("alt+q");
  assert.equal(f.state.activeSessionId, 20);
  assert.equal(f.state.folded, true);
  await f.key("alt+r");
  assert.deepEqual(f.terminated, [20]);
  f.disable();
  await f.key("alt+w");
  assert.equal(f.state.folded, true);
  f.snapshots.length = 0;
  f.render();
  assert.equal(f.component, undefined);
  assert.equal(f.state.activeSessionId, undefined);
});

test("no sessions and non-TUI contexts do not install an interactive widget", () => {
  const f = fixture();
  f.snapshots.length = 0;
  f.render();
  assert.equal(f.component, undefined);
  assert.equal(f.state.folded, true);
  for (const mode of ["rpc", "print", "json"]) {
    const headless = fixture(mode);
    headless.render();
    assert.equal(headless.updates, 0);
  }
});

test("real host widget assembly routes clicks through the above-editor container", () => {
  const f = fixture();
  let renders = 0;
  // Exercise real host slot installation, stacking, layout and hit routing;
  // no interactive terminal/session is needed to test these methods.
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
    ui: { requestRender() { renders++; } },
  });
  f.ctx.ui.setWidget = (...args) => host.setExtensionWidget(...args);
  const frame = () => host.widgetContainerAbove.render(80).join("\n");
  f.render();
  assert.doesNotMatch(frame(), /OUTPUT_20/);
  assert.equal(host.widgetContainerAbove.handleMouse(mouseEvent("click", "left", 1)).handled, true);
  assert.match(frame(), /OUTPUT_20/);
  assert.equal(host.widgetContainerAbove.handleMouse(mouseEvent("click", "left", 1)).handled, true);
  assert.doesNotMatch(frame(), /OUTPUT_20/);
  assert.equal(renders, 3);
  f.snapshots.length = 0;
  f.render();
  assert.equal(host.extensionWidgetsAbove.size, 0);
  assert.doesNotMatch(frame(), /codex shell/);
});
