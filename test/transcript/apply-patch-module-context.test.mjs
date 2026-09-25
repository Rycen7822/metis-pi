import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = hostRequire("jiti");
const statePath = fileURLToPath(new URL("../../vendor/pi-codex-conversion/src/tools/apply-patch/render-state.ts", import.meta.url));

test("separate extension module contexts share patch snapshots and cleanup", async () => {
  // Force the normal-install path, not native ESM's incidental shared cache in
  // a development checkout with Pi peer dependencies available locally.
  const load = () => createJiti(import.meta.url, { moduleCache: false, tryNative: false }).import(statePath);
  const tool = await load();
  const appearance = await load();
  assert.notEqual(tool.setApplyPatchRenderState, appearance.setApplyPatchRenderState);
  try {
    tool.setApplyPatchRenderState("contexts", "*** Begin Patch\n*** Add File: context.txt\n+shared\n*** End Patch", process.cwd(), "pending", undefined, true);
    assert.equal(appearance.getApplyPatchRenderSnapshot("contexts"), tool.getApplyPatchRenderSnapshot("contexts"));
    assert.equal(appearance.getApplyPatchRenderSnapshot("contexts").files[0].lines[0].text, "shared");
    tool.markApplyPatchFailure("contexts", "failed");
    assert.equal(appearance.getApplyPatchRenderSnapshot("contexts").status, "failed");
    tool.clearApplyPatchRenderState();
    assert.equal(appearance.getApplyPatchRenderSnapshot("contexts"), undefined);
  } finally {
    tool.clearApplyPatchRenderState();
  }
});

test("separate extension contexts share compact policy and broker shutdown", async () => {
  const brokerPath = fileURLToPath(new URL("../../vendor/pi-codex-conversion/src/tools/apply-patch/display-broker.ts", import.meta.url));
  const load = () => createJiti(import.meta.url, { moduleCache: false, tryNative: false }).import(brokerPath);
  const tool = await load();
  const appearance = await load();
  assert.notEqual(tool.registerApplyPatchDisplayBroker, appearance.registerApplyPatchDisplayBroker);
  const handlers = new Map();
  let broker;
  tool.registerApplyPatchDisplayBroker({
    on(name, handler) { handlers.set(name, handler); },
    events: { on() {}, emit(_name, value) { broker = value; } },
  });
  try {
    const unregister = broker.register("test.patch");
    tool.recordApplyPatchDisplayInput("compact", "patch");
    assert.equal(appearance.shouldCompactApplyPatchDisplay("compact", true), true);
    assert.equal(appearance.shouldCompactApplyPatchDisplay("compact", false), false);
    unregister();
    assert.equal(appearance.shouldCompactApplyPatchDisplay("compact", true), false);
  } finally {
    handlers.get("session_shutdown")();
  }
  assert.equal(appearance.shouldCompactApplyPatchDisplay("compact", true), false);
});
