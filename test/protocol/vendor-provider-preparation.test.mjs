import assert from "node:assert/strict";
import test from "node:test";
import { disableNetwork, modelNamed } from "../helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM } from "../helpers/vendor-codex-sessions.mjs";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../../vendor/pi-codex-conversion/dist/adapter/activation/config-contract.js";
import { resolveCodexRuntimePlanForState } from "../../vendor/pi-codex-conversion/dist/adapter/activation/runtime-plan.js";
import { CodexDeveloperMessageBridge } from "../../vendor/pi-codex-conversion/dist/adapter/developer-messages.js";
import {
	rewriteCodexProviderRequest,
	rewriteCodexPrewarmProviderRequest,
} from "../../vendor/pi-codex-conversion/dist/adapter/provider-request.js";
import { createHistoryNotesTools } from "../../vendor/pi-codex-conversion/dist/context-management/history-notes.js";
import { rewriteWindowPayload } from "../../vendor/pi-codex-conversion/dist/context-management/window-request.js";

test.beforeEach(disableNetwork);

// These cases were run on 312bc5d before merging the preparation paths. In
// particular, provider-name transport detection is not the API-only predicate
// that decides whether ordinary requests expose flat or namespace tools.
const cases = [
	{ label: "Local Codex", mode: "local", namespace: false },
	{ label: "Tree Codex", mode: "tree", namespace: false },
	{ label: "Remote Codex", mode: "remote", namespace: true, remote: true },
	{ label: "Local Responses", mode: "local", provider: "openai", api: "openai-responses", namespace: true },
	{ label: "Tree Responses", mode: "tree", provider: "openai", api: "openai-responses", namespace: true },
	{ label: "Remote on non-Codex is inactive", mode: "remote", provider: "openai", api: "openai-responses", namespace: false },
	{ label: "Local provider/API mismatch", mode: "local", api: "openai-responses", namespace: true },
	{ label: "Tree provider/API mismatch", mode: "tree", api: "openai-responses", namespace: true },
	{ label: "Remote provider/API mismatch", mode: "remote", api: "openai-responses", namespace: true },
	{ label: "Remote custom Codex API", mode: "remote", provider: "custom-codex", namespace: true, remote: true },
	{ label: "Responses Lite Local", mode: "local", executionMode: "code", lite: true, namespace: false },
	{ label: "Responses Lite Tree", mode: "tree", executionMode: "notebook", lite: true, namespace: false },
	{ label: "Responses Lite Remote", mode: "remote", executionMode: "code", lite: true, namespace: true, remote: true },
];

function fixture(options = {}) {
	const model = { ...modelNamed("gpt-6-astra"), ...(options.provider ? { provider: options.provider } : {}), ...(options.api ? { api: options.api } : {}) };
	const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
	config.compaction.contextManagement = options.mode ?? "off";
	config.openai.fast = true;
	config.openai.verbosity = "high";
	const ctx = { model, sessionManager: { getSessionId: () => "preparation-session" } };
	const bridge = new CodexDeveloperMessageBridge();
	const [carrier] = bridge.prepare([{
		role: "custom", customType: "codex-developer-message", content: "DEVELOPER_TEXT",
		details: { protocol: 1, id: "prepared-developer" }, display: false, timestamp: 0,
	}], true, model);
	const state = {
		config, executionMode: options.executionMode ?? "normal",
		voiceSystemPromptOverride: "VOICE_INSTRUCTIONS",
		activeProviderSystemPrompt: "BEFORE_CAPTURE", pendingActiveProviderPromptCapture: true,
		developerMessages: bridge,
		contextWindows: {
			rewritePayload: (payload, context) => rewriteWindowPayload(payload, context, {
				firstWindowId: "window-0", currentWindowId: "window-1", windowNumber: 1,
			}),
		},
	};
	const tools = createHistoryNotesTools().map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));
	const payload = {
		model: model.id, instructions: "ORIGINAL_INSTRUCTIONS", text: { format: { type: "text" } },
		tools, input: [{ role: "user", content: [{ type: "input_text", text: carrier.content }] }, { type: "additional_tools", tools }],
		client_metadata: { retained: "metadata" },
	};
	return { ctx, state, payload };
}

for (const scenario of cases) {
	test(`${scenario.label}: live and prewarm produce the same request while final effects stay live-only`, async () => {
		const { ctx, state, payload } = fixture(scenario);
		const original = structuredClone(payload);
		const prewarm = rewriteCodexPrewarmProviderRequest(payload, ctx, state);
		assert.equal(state.activeProviderSystemPrompt, "BEFORE_CAPTURE", "ordinary prewarm must not capture a prompt");
		const live = await rewriteCodexProviderRequest(payload, ctx, state);
		assert.deepEqual(live, prewarm);
		assert.deepEqual(payload, original, "preparation must not mutate the original payload");
		assert.equal(state.activeProviderSystemPrompt, "VOICE_INSTRUCTIONS");
		assert.equal(live.text.verbosity, "high");
		assert.deepEqual(live.text.format, { type: "text" });
		assert.equal(live.service_tier, scenario.provider === "openai" ? undefined : "priority");
		const tools = scenario.lite ? live.input[0].tools : live.tools;
		const contextTools = scenario.lite && !scenario.namespace ? tools[0].tools : tools;
		assert.deepEqual(contextTools.map(({ name, type }) => [name, type]), [["history", scenario.namespace ? "namespace" : "function"], ["notes", scenario.namespace ? "namespace" : "function"]]);
		assert.equal(JSON.stringify(live).includes("DEVELOPER_TEXT"), true);
		assert.equal(JSON.stringify(live).includes("pi-codex-developer-carrier"), false);
		if (scenario.namespace) {
			const search = contextTools[0].tools.find((tool) => tool.name === "search_contents");
			assert.equal(search.parameters.properties.query.encrypted, scenario.remote ? true : undefined);
			assert.equal(Object.hasOwn(search.parameters, "additionalProperties"), !scenario.remote);
			assert.equal(Object.hasOwn(search.parameters.properties.limit, "minimum"), !scenario.remote);
		}
		assert.equal(live.client_metadata.retained, "metadata");
		if (scenario.remote) {
			assert.equal(live.client_metadata["x-codex-window-id"], "preparation-session:1");
			assert.deepEqual(JSON.parse(live.client_metadata["x-codex-turn-metadata"]), {
				session_id: "preparation-session", thread_id: "preparation-session", agent_name: "/root",
				window_id: "preparation-session:1", window_number: 1, context_window_id: "window-1",
				request_kind: "turn", history_ingest_requested: true,
			});
		} else assert.deepEqual(live.client_metadata, { retained: "metadata" });
		if (scenario.lite) {
			assert.equal(live.instructions, undefined);
			assert.equal(live.tools, undefined);
			assert.equal(live.input[0].type, "additional_tools");
			assert.deepEqual(live.input[1], { type: "message", role: "developer", content: [{ type: "input_text", text: "VOICE_INSTRUCTIONS" }] });
			assert.equal(live.parallel_tool_calls, false);
			assert.equal(live.reasoning.context, "all_turns");
		} else assert.equal(live.instructions, "VOICE_INSTRUCTIONS");
		if (scenario.label.includes("mismatch")) {
			assert.equal(resolveCodexRuntimePlanForState(ctx, state).codexTransport, true);
			assert.equal(ctx.model.api, "openai-responses", "ordinary namespace rewriting must not use the broader compaction predicate");
		}
	});
}

test("inactive and unsupported requests do no preparation or final work", async () => {
	for (const reason of ["voice-only", "missing-tools", "unconfigured", "unsupported-api", "extras"]) {
		const { ctx, state, payload } = fixture();
		if (reason === "voice-only") state.config.voiceFeaturesOnly = true;
		if (reason === "missing-tools") state.availableToolNames = [];
		if (reason === "unconfigured") ctx.model = { ...ctx.model, provider: "unconfigured", api: "other-api", id: "other-model" };
		if (reason === "unsupported-api") {
			state.config.scope.allProviders = "on";
			ctx.model = { ...ctx.model, provider: "unconfigured", api: "other-api", id: "other-model" };
		}
		if (reason === "extras") state.config.tools.applyPatchOnly = true;
		assert.equal(rewriteCodexPrewarmProviderRequest(payload, ctx, state), undefined, reason);
		assert.equal(await rewriteCodexProviderRequest(payload, ctx, state), undefined, reason);
		assert.equal(state.activeProviderSystemPrompt, "BEFORE_CAPTURE", reason);
	}
});

test("failed common preparation stops before prompt capture and pending-window consumption", async () => {
	for (const boundary of ["developerMessages", "contextWindows"]) {
		for (const rewrite of [rewriteCodexPrewarmProviderRequest, rewriteCodexProviderRequest]) {
			const { ctx, state, payload } = fixture({ mode: "remote" });
			const pending = { window: [SEALED_WINDOW_ITEM] };
			state.pendingPiCompactionNativeWindow = pending;
			state[boundary].rewritePayload = () => { throw new Error(`FAIL_${boundary}`); };
			await assert.rejects(async () => rewrite(payload, ctx, state), { message: `FAIL_${boundary}` });
			assert.equal(state.activeProviderSystemPrompt, "BEFORE_CAPTURE");
			assert.equal(state.pendingPiCompactionNativeWindow, pending);
		}
	}
});
