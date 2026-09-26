import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = hostRequire("jiti");
const statePath = fileURLToPath(new URL("../../vendor/pi-codex-conversion/src/tools/apply-patch/render-state.ts", import.meta.url));

test("independent extension modules share patch state, compact policy and cleanup", async (t) => {
  const tool = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const appearance = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const toolState = await tool.import(statePath);
  const viewState = await appearance.import(statePath);
  const brokerPath = fileURLToPath(new URL("../../vendor/pi-codex-conversion/src/tools/apply-patch/display-broker.ts", import.meta.url));
  const toolBroker = await tool.import(brokerPath);
  const viewBroker = await appearance.import(brokerPath);
  assert.notEqual(toolState.setApplyPatchRenderState, viewState.setApplyPatchRenderState);
  assert.notEqual(toolBroker.registerApplyPatchDisplayBroker, viewBroker.registerApplyPatchDisplayBroker);
  const handlers = new Map();
  let broker;
  t.after(() => {
    toolState.clearApplyPatchRenderState();
    handlers.get("session_shutdown")?.();
  });
  toolBroker.registerApplyPatchDisplayBroker({
    on(name, handler) { handlers.set(name, handler); },
    events: { on() {}, emit(_name, value) { broker = value; } },
  });
  const unregister = broker.register("test.patch");
  toolState.setApplyPatchRenderState("contexts", "*** Begin Patch\n*** Add File: context.txt\n+shared\n*** End Patch", process.cwd(), "pending", undefined, true);
  toolBroker.recordApplyPatchDisplayInput("contexts", "patch");
  assert.equal(viewState.getApplyPatchRenderSnapshot("contexts"), toolState.getApplyPatchRenderSnapshot("contexts"));
  assert.equal(viewState.getApplyPatchRenderSnapshot("contexts").files[0].lines[0].text, "shared");
  assert.equal(viewBroker.shouldCompactApplyPatchDisplay("contexts", true), true);
  assert.equal(viewBroker.shouldCompactApplyPatchDisplay("contexts", false), false);
  toolState.markApplyPatchFailure("contexts", "failed");
  assert.equal(viewState.getApplyPatchRenderSnapshot("contexts").status, "failed");
  unregister();
  assert.equal(viewBroker.shouldCompactApplyPatchDisplay("contexts", true), false);
  toolState.clearApplyPatchRenderState();
  assert.equal(viewState.getApplyPatchRenderSnapshot("contexts"), undefined);
  broker.register("test.patch");
  assert.equal(viewBroker.shouldCompactApplyPatchDisplay("contexts", true), true);
  handlers.get("session_shutdown")();
  assert.equal(viewBroker.shouldCompactApplyPatchDisplay("contexts", true), false);
});
