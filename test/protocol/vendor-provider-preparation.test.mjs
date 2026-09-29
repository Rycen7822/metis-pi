import assert from "node:assert/strict";
import test from "node:test";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { disableNetwork, modelNamed } from "../helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM } from "../helpers/vendor-codex-sessions.mjs";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../../vendor/pi-codex-conversion/src/adapter/activation/config-contract.ts";
import { resolveCodexRuntimePlanForState } from "../../vendor/pi-codex-conversion/src/adapter/activation/runtime-plan.ts";
import { CodexDeveloperMessageBridge } from "../../vendor/pi-codex-conversion/src/adapter/developer-messages.ts";
import {
	rewriteCodexProviderRequest,
	rewriteCodexPrewarmProviderRequest,
} from "../../vendor/pi-codex-conversion/src/adapter/provider-request.ts";
import { createHistoryNotesTools } from "../../vendor/pi-codex-conversion/src/context-management/history-notes.ts";
import { rewriteWindowPayload } from "../../vendor/pi-codex-conversion/src/context-management/window-request.ts";
import { createNativeFusionTool } from "../../extensions/action-fusion.ts";
import { createApplyPatchTool } from "../../vendor/pi-codex-conversion/src/tools/apply-patch/tool.ts";
import { normalizeCodexConfigurationUpdates, supportsCodexReasoningUpdates } from "../../vendor/pi-codex-conversion/src/adapter/reasoning-updates.ts";

test.beforeEach(disableNetwork);

for (const fusionEnabled of [true, false]) test(`native and patch schemas retain fusion enabled=${fusionEnabled} across live/prewarm mode changes`, async () => {
  const definitions = [
    fusionEnabled ? createNativeFusionTool("edit", "/tmp") : createEditToolDefinition("/tmp"),
    fusionEnabled ? createNativeFusionTool("write", "/tmp") : createWriteToolDefinition("/tmp"),
    createApplyPatchTool(fusionEnabled ? { runThenRun: () => async () => { throw new Error("schema-only test must not execute commands"); } } : {}),
  ];
  const tools = definitions.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));
  const original = JSON.stringify(tools);
  for (const executionMode of ["normal", "code", "notebook", "normal"]) {
    const { ctx, state, payload } = fixture({ executionMode });
    payload.tools = tools; payload.input = [{ role: "user", content: "Apply and check" }];
    const warm = rewriteCodexPrewarmProviderRequest(payload, ctx, state);
    const live = await rewriteCodexProviderRequest(payload, ctx, state);
    assert.deepEqual(live, warm);
    assert.equal(JSON.stringify(tools), original);
    const placed = live.tools ?? live.input.find(item => item.type === "additional_tools")?.tools;
    const functions = placed.flatMap(tool => tool.type === "namespace" ? tool.tools : [tool]);
    assert.deepEqual(functions.map(tool => tool.name), ["edit", "write", "apply_patch"]);
    for (const tool of functions) {
      const schema = tool.parameters.properties.then_run;
      if (!fusionEnabled) { assert.equal(schema, undefined); continue; }
      assert.equal(schema.type, "object");
      assert.equal(schema.properties.command.type, "string");
      assert.equal(schema.properties.timeout.type, "number");
      assert.equal(tool.parameters.required.includes("then_run"), false);
    }
  }
});

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
	{ label: "Responses Lite Tree Sol", modelId: "gpt-6-sol", mode: "tree", executionMode: "notebook", lite: true, namespace: false },
	{ label: "Responses Lite Remote Luna", modelId: "gpt-6-luna", mode: "remote", executionMode: "code", lite: true, namespace: true, remote: true },
];

function fixture(options = {}) {
	const model = { ...modelNamed("gpt-6-astra"), ...(options.modelId ? { id: options.modelId } : {}), ...(options.provider ? { provider: options.provider } : {}), ...(options.api ? { api: options.api } : {}) };
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
		assert.equal(state.activeProviderSystemPrompt, "ORIGINAL_INSTRUCTIONS");
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
			assert.equal(supportsCodexReasoningUpdates(ctx.model), true);
			const update = { type: "configuration_update", reasoning: { effort: "high" } };
			assert.deepEqual(normalizeCodexConfigurationUpdates({ model: ctx.model.id, input: [update] }).input, [update]);
			const proxyState = { ...state, config: structuredClone(state.config) };
			proxyState.config.scope.additionalProviders = ["monitored"];
			proxyState.config.openai.proxyResponsesLite = true;
			assert.equal(resolveCodexRuntimePlanForState({ ...ctx, model: {
				...ctx.model, api: "openai-responses", provider: "monitored",
			} }, proxyState).transport, "responses-lite");
			assert.equal(live.instructions, undefined);
			assert.equal(live.tools, undefined);
			assert.equal(live.input[0].type, "additional_tools");
			assert.deepEqual(live.input[1], { type: "message", role: "developer", content: [{ type: "input_text", text: "ORIGINAL_INSTRUCTIONS" }] });
			assert.equal(live.parallel_tool_calls, false);
			assert.equal(live.reasoning.context, "all_turns");
		} else assert.equal(live.instructions, "ORIGINAL_INSTRUCTIONS");
		if (scenario.label.includes("mismatch")) {
			assert.equal(resolveCodexRuntimePlanForState(ctx, state).codexTransport, true);
			assert.equal(ctx.model.api, "openai-responses", "ordinary namespace rewriting must not use the broader compaction predicate");
		}
	});
}

test("inactive and unsupported requests do no preparation or final work", async () => {
	for (const reason of ["missing-tools", "unconfigured", "unsupported-api", "extras"]) {
		const { ctx, state, payload } = fixture();
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
