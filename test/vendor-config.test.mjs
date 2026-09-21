import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodexConversionConfig as normalize } from "../vendor/pi-codex-conversion/dist/adapter/activation/config.js";
import { buildDisplaySettings } from "../vendor/pi-codex-conversion/dist/ui/settings/config-items-display.js";
import { buildToolsSettings } from "../vendor/pi-codex-conversion/dist/ui/settings/config-items-tools.js";
import { buildOpenAISettings } from "../vendor/pi-codex-conversion/dist/ui/settings/config-items-openai.js";
import { buildVoiceSettings } from "../vendor/pi-codex-conversion/dist/ui/settings/config-items-voice.js";

test("vendor config retains legacy aliases, optional fields and dependent switches", () => {
  assert.ok(normalize(null).voice.contextModel, "non-object input returns the complete defaults");
  assert.equal(Object.hasOwn(normalize({}).voice, "contextModel"), false, "object input explicitly normalizes optional model selection");
  const config = normalize({
    ui: { toolRenaming: "invalid", toolRendering: false, backgroundShellPrevShortcut: " alt+u " },
    compaction: { contextManagement: "local", hybridCompaction: true, responsesCompaction: true, portableSummary: true },
    notebook: { maxHeapMiB: 255, plainCommandOutput: true, profile: "valid-name" },
    voice: { refreshRealtimeAfterCompaction: true, inputDevice: " mic ", contextModel: { provider: "p", modelId: "m" } },
  });
  assert.equal(config.ui.toolRenaming, false);
  assert.equal(config.ui.backgroundShellPrevShortcut, "alt+u");
  assert.deepEqual(config.compaction, { contextManagement: "local", hybridCompaction: true, responsesCompaction: false, portableSummary: false, v2UserMessageRetention: 64 });
  assert.equal(config.notebook.maxHeapMiB, normalize(null).notebook.maxHeapMiB);
  assert.equal(config.notebook.profile, "valid-name");
  assert.equal(config.voice.inputDevice, "mic");
  assert.equal(config.voice.refreshRealtimeAfterCompaction, true);
  assert.equal(normalize({ voice: { refreshRealtimeAfterCompaction: true } }).voice.refreshRealtimeAfterCompaction, false);
  assert.equal(normalize({ compaction: { portableSummary: true } }).compaction.portableSummary, false);
  const other = normalize(null);
  other.scope.additionalProviders.push("mutation");
  assert.deepEqual(normalize(null).scope.additionalProviders, []);
});

test("settings toggles preserve latest-draft siblings and do not mutate either snapshot", () => {
  const displayed = normalize(null);
  const settings = [buildDisplaySettings(displayed), buildToolsSettings(displayed), buildOpenAISettings(displayed), buildVoiceSettings(displayed, [])].flat();
  const fields = {
    statusLine: ["ui", "statusLine"], toolRenaming: ["ui", "toolRenaming"],
    codeModeDetails: ["ui", "codeModeDetails"], backgroundShellWidget: ["ui", "backgroundShellWidget"],
    autoReasoning: ["tools", "autoReasoning"], viewImageFallback: ["tools", "viewImageFallback"],
    notebookPlainCommandOutput: ["notebook", "plainCommandOutput"], applyPatchOnly: ["tools", "applyPatchOnly"],
    viewImageOnly: ["tools", "viewImageOnly"], fast: ["openai", "fast"], responsesLite: ["openai", "proxyResponsesLite"],
    forceCachedWebSockets: ["openai", "forceCachedWebSockets"], autoResumeRealtime: ["voice", "autoResumeRealtime"],
    delegationAcknowledgements: ["voice", "delegationAcknowledgements"], forwardReasoningSummaries: ["voice", "forwardReasoningSummaries"],
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
      assert.notEqual(result, draft);
      assert.notEqual(result[section], draft[section]);
    }
  }
  assert.deepEqual(displayed, normalize(null));
});
