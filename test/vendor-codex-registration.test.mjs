import test from "node:test";
import assert from "node:assert/strict";
import { registrationHarness } from "./helpers/vendor-codex-provider.mjs";

test("native Codex registration follows Pi's catalog and reuses one provider", async () => {
  const { registration, calls, hostModels, hostProvider, installProvider, refreshCount } = await registrationHarness();
  const initial = calls.providers.find(([name]) => name === "openai-codex");
  assert.ok(initial, "vendored entry overlays Pi's openai-codex provider");
  assert.equal(initial[1].models, undefined, "the overlay inherits Pi's catalog");
  await installProvider({}, { modelRegistry: { getProvider: () => hostProvider } });
  assert.equal(calls.providers.filter(([first]) => first?.id === "openai-codex").length, 1);
  await registration.refreshModels({});
  assert.equal((await registrationHarness()).refreshCount, refreshCount + 1);
  const futureModel = { ...hostModels[0], id: "future-codex-model" };
  hostModels.push(futureModel);
  assert.ok(registration.getModels().some(({ id }) => id === futureModel.id));
  const reserve = registration.getModels().find(({ id }) => id === "gpt-reserve");
  assert.ok(reserve, "Reserve stays resolvable");
  assert.ok(!registration.filterModels(registration.getModels(), {}).some(({ id }) => id === reserve.id), "Reserve stays hidden in the picker");
});
