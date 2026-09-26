import assert from "node:assert/strict";
import test from "node:test";
import { Container, MouseRegion, visibleWidth } from "@earendil-works/pi-tui";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_BASH_WIDGET_ID,
  renderBackgroundBashWidget,
  registerBackgroundBashWidgetShortcuts,
} from "../../vendor/pi-codex-conversion/dist/ui/background-bash-widget.js";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../../vendor/pi-codex-conversion/dist/adapter/activation/config-contract.js";

function mouseEvent(type = "click", button = "left", y = 0) {
  return { type, button, x: 3, y, screenX: 3, screenY: y, width: 80, height: 20,
    shift: false, alt: false, ctrl: false, ...(type === "wheel" ? { wheelDelta: -1 } : {}) };
}

test("native widget gestures and shortcuts preserve selection, folding and cleanup in Pi's actual slot", async () => {
  let updates = 0;
  // Use Pi's slot registration, stacking and hit routing for every widget lifecycle.
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
    ui: { requestRender() { updates++; } },
  });
  const component = () => host.extensionWidgetsAbove.get(BACKGROUND_BASH_WIDGET_ID);
  let enabled = true;
  const snapshots = [20, 21].map(id => ({
    id, command: `printf '后台任务 ${id}'`, outputTail: `OUTPUT_${id}`, updatedAt: Date.now(), running: true,
  }));
  const state = { folded: true };
  const theme = { fg: (_role, text) => text };
  const terminated = [];
  const sessions = { listSessions: () => snapshots, terminateSession: id => terminated.push(id) };
  const shortcuts = new Map();
  const ctx = { mode: "rpc", ui: { theme, setWidget(id, factory, options) {
    assert.equal(id, BACKGROUND_BASH_WIDGET_ID);
    if (factory) {
      assert.equal(options.placement, "aboveEditor");
      assert.equal(typeof factory, "function");
    }
    host.setExtensionWidget(id, factory, options);
    if (factory) assert.ok(component() instanceof MouseRegion);
    assert.equal(host.extensionWidgetsBelow.size, 0, "background sessions occupy only the above-editor slot");
  } } };
  const render = () => renderBackgroundBashWidget(ctx, state, sessions);
  registerBackgroundBashWidgetShortcuts({ registerShortcut: (key, handler) => shortcuts.set(key, handler) }, state, sessions, DEFAULT_CODEX_CONVERSION_CONFIG.ui, () => enabled);
  const frame = (width = 80) => host.widgetContainerAbove.render(width).join("\n");
  const click = () => host.widgetContainerAbove.handleMouse(mouseEvent("click", "left", 1));
  const key = key => shortcuts.get(key).handler(ctx);
  render();
  assert.equal(updates, 0, "RPC mode never installs a widget, even with active sessions");
  assert.equal(component(), undefined);
  ctx.mode = "tui";
  render();
  assert.doesNotMatch(frame(), /OUTPUT_20/);
  for (const [type, button] of [["click", "right"], ["press", "left"]]) {
    assert.equal(component().handleMouse(mouseEvent(type, button)), undefined);
  }
  assert.equal(updates, 1, "unclaimed gestures do not replace the widget or request another frame");
  for (const [action, folded, active, output] of [
    [() => click(), false, 20, "OUTPUT_20"],
    [() => { snapshots[0].outputTail = "LATEST_OUTPUT"; render(); }, false, 20, "LATEST_OUTPUT"],
    [() => key("alt+e"), false, 21, "OUTPUT_21"],
    [() => key("alt+w"), true, 21, undefined],
    [() => key("alt+q"), true, 20, undefined],
    [() => click(), false, 20, "LATEST_OUTPUT"],
  ]) {
    await action();
    assert.deepEqual([state.folded, state.activeSessionId], [folded, active]);
    if (output) assert.ok(frame().includes(output), `expected current output ${output}`);
    else assert.doesNotMatch(frame(), /OUTPUT_|LATEST_OUTPUT/);
  }
  for (const width of [12, 40, 80]) assert.ok(component().render(width).every(line => visibleWidth(line) <= width));
  assert.deepEqual(terminated, [], "folding and selection never terminate a process");
  await key("alt+r");
  assert.deepEqual(terminated, [20]);
  enabled = false;
  await key("alt+w");
  assert.equal(state.folded, false);
  snapshots.length = 0;
  render();
  assert.equal(component(), undefined);
  assert.equal(state.activeSessionId, undefined);
  assert.doesNotMatch(frame(), /codex shell/, "removing the final session clears Pi's actual widget container");
});
