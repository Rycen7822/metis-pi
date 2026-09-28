import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { openPrunerSettings } from "../../vendor/pi-condense/dist/src/settings.js";
import { DEFAULT_CONFIG } from "../../vendor/pi-condense/dist/src/types.js";

test("pruner settings keeps item order, saves changes, and ignores display-only rows", async () => {
  initTheme("dark", false);
  const current = { value: structuredClone(DEFAULT_CONFIG) };
  const saved = [];
  const refreshed = [];
  let list;
  const ctx = {
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: () => {},
      custom: async (factory) => { list = factory(null, null, null, () => {}).children[2]; },
    },
  };
  await openPrunerSettings(ctx, current, async (config) => { saved.push(config); }, (config) => { refreshed.push(config); });
  assert.deepEqual(list.items.slice(0, 4).map((item) => item.id), ["enabled", "showPruneStatusLine", "showOccStatusLine", "pruneOn"]);

  list.selectItem("showOccStatusLine");
  list.handleInput(" ");
  assert.equal(current.value.showOccStatusLine, !DEFAULT_CONFIG.showOccStatusLine);
  assert.equal(refreshed.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].showOccStatusLine, current.value.showOccStatusLine);

  list.selectItem("protectedTools");
  list.handleInput(" ");
  assert.equal(saved.length, 1);
  assert.equal(refreshed.length, 1);
});
