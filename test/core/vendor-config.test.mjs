import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CODEX_CONVERSION_CONFIG, normalizeCodexConversionConfig as normalize } from "../../src/codex/config/config.ts";
import { buildDisplaySettings } from "../../src/codex/ui/settings/config-items-display.ts";
import { buildToolsSettings } from "../../src/codex/ui/settings/config-items-tools.ts";
import { buildOpenAISettings } from "../../src/codex/ui/settings/config-items-openai.ts";

test("vendor config normalizes optional fields and dependent switches", () => {
  const config = normalize({
    ui: { toolRenaming: "invalid", backgroundShellPrevShortcut: " alt+u " },
    compaction: { contextManagement: "local", hybridCompaction: true, responsesCompaction: true, portableSummary: true },
    tools: { plainCommandOutput: true },
  });
  assert.equal(config.ui.toolRenaming, DEFAULT_CODEX_CONVERSION_CONFIG.ui.toolRenaming);
  assert.equal(config.ui.backgroundShellPrevShortcut, "alt+u");
  assert.deepEqual(config.compaction, { contextManagement: "local", hybridCompaction: true, responsesCompaction: false, portableSummary: false, v2UserMessageRetention: 64 });
  assert.equal(config.tools.plainCommandOutput, true);
  assert.equal(normalize({ compaction: { portableSummary: true } }).compaction.portableSummary, false);
  const other = normalize(null);
  other.scope.additionalProviders.push("mutation");
  assert.deepEqual(normalize(null).scope.additionalProviders, []);
});

test("settings toggles preserve latest-draft siblings and do not mutate either snapshot", () => {
  const displayed = normalize(null);
  const displayedBefore = structuredClone(displayed);
  const settings = [buildDisplaySettings(displayed), buildToolsSettings(displayed), buildOpenAISettings(displayed)].flat();
  const fields = {
    statusLine: ["ui", "statusLine"], toolRenaming: ["ui", "toolRenaming"],
    codeModeDetails: ["ui", "codeModeDetails"], backgroundShellWidget: ["ui", "backgroundShellWidget"],
    autoReasoning: ["tools", "autoReasoning"], viewImageFallback: ["tools", "viewImageFallback"],
    plainCommandOutput: ["tools", "plainCommandOutput"], applyPatchOnly: ["tools", "applyPatchOnly"],
    viewImageOnly: ["tools", "viewImageOnly"], fast: ["openai", "fast"], responsesLite: ["openai", "proxyResponsesLite"],
    forceCachedWebSockets: ["openai", "forceCachedWebSockets"],
  };
  for (const [id, [section, key]] of Object.entries(fields)) {
    const setting = settings.find(({ item }) => item.id === id);
    assert.equal(setting.item.currentValue, displayed[section][key] ? "on" : "off");
    for (const value of ["on", "off", "invalid"]) {
      const draft = structuredClone(displayed);
      draft[section].futureOption = "preserve";
      const before = structuredClone(draft);
      const result = setting.update(value, draft);
      assert.deepEqual(result, { ...draft, [section]: { ...draft[section], [key]: value === "on" } });
      assert.deepEqual(draft, before);
    }
  }
  assert.deepEqual(displayed, displayedBefore);
});
