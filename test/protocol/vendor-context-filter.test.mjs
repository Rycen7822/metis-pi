import assert from "node:assert/strict";
import test from "node:test";
import { isProviderContextExcludedMessage } from "../../vendor/pi-codex-conversion/dist/adapter/prompt/context-filter.js";

test("retired session metadata stays out of provider context", () => {
	assert.equal(isProviderContextExcludedMessage({ role: "custom", customType: "codex-realtime-voice" }), true);
	assert.equal(isProviderContextExcludedMessage({ role: "custom", customType: "codex-voice-mode", content: {} }), true);
	assert.equal(isProviderContextExcludedMessage({ role: "custom", customType: "codex-voice-mode", content: '<realtime_voice_session state="ended">' }), false);
	assert.equal(isProviderContextExcludedMessage({ role: "custom", customType: "other", content: "keep" }), false);
});
