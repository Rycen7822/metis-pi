import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { isResponsesContext } from "./prompt/codex-model.ts";
import { applyCodexRequestOptions } from "./request-options.ts";
import type { AdapterState } from "./activation/state.ts";
import { isAdapterRuntime, resolveCodexRuntimePlanForState } from "./activation/runtime-plan.ts";
import { injectNativeWindowIntoPiCompactionRequest, rewriteCodexCompactedProviderRequest } from "./compaction/compaction.ts";
import { applyResponsesLiteRequest, RESPONSES_LITE_HEADER, type ResponsesLiteCompatibleBody } from "../providers/openai-codex/responses-lite.ts";
import { usesRemoteHistoryNotes } from "../context-management/history-notes.ts";
import { rewriteContextNamespaceTools } from "../context-management/namespace-tools.ts";

// Shared wire preparation only: ordinary prewarm must not consume pending
// compaction windows or capture the active prompt from a speculative request.
function prepareCodexProviderRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState) {
	if (state.config.voiceFeaturesOnly) return undefined;
	const plan = resolveCodexRuntimePlanForState(ctx, state);
	if (!isAdapterRuntime(plan) || (!plan.effectiveOpenAICodex && !isResponsesContext(ctx))) {
		return undefined;
	}
	let preparedPayload = applyCodexRequestOptions(applyVoiceSystemPrompt(payload, state.voiceSystemPromptOverride), state.config, {
		serviceTier: plan.effectiveOpenAICodex,
		verbosity: true,
	});
	preparedPayload = state.developerMessages.rewritePayload(preparedPayload, ctx.model);
	if (plan.contextManagement) {
		const remote = plan.contextManagementRemote && usesRemoteHistoryNotes(ctx, plan.contextManagementMode);
		preparedPayload = rewriteContextTools(preparedPayload, ctx, remote);
		if (remote) preparedPayload = state.contextWindows.rewritePayload(preparedPayload, ctx);
	}
	return { plan, preparedPayload };
}

export function supportsCodexDeveloperMessages(
	ctx: Pick<ExtensionContext, "model">,
	state: AdapterState,
): boolean {
	if (state.config.voiceFeaturesOnly) return false;
	const plan = resolveCodexRuntimePlanForState(ctx, state);
	return isAdapterRuntime(plan) && isResponsesContext(ctx);
}

function applyVoiceSystemPrompt(payload: unknown, systemPrompt: string | undefined): unknown {
	if (!systemPrompt || !isRecord(payload)) return payload;
	return { ...payload, instructions: systemPrompt };
}

function applyCodexRuntimePayload(payload: unknown, responsesLite: boolean): unknown {
	return responsesLite && isCodeModeCompatibleBody(payload)
		? applyResponsesLiteRequest(payload)
		: payload;
}

export function rewriteCodexProviderHeaders(
	headers: ProviderHeaders,
	ctx: ExtensionContext,
	state: AdapterState,
): void {
	if (state.config.voiceFeaturesOnly) return;
	const plan = resolveCodexRuntimePlanForState(ctx, state);
	if (plan.transport === "responses-lite") {
		headers[RESPONSES_LITE_HEADER] = "true";
	}
	if (
		plan.contextManagementRemote &&
		usesRemoteHistoryNotes(ctx, plan.contextManagementMode)
	)
		state.contextWindows.rewriteHeaders(headers, ctx);
}

export function captureActiveProviderSystemPrompt(payload: unknown, state: AdapterState): void {
	if (!isRecord(payload)) return;
	const instructions = providerSystemPrompt(payload);
	if (instructions !== undefined) state.activeProviderSystemPrompt = instructions;
}

export async function rewriteCodexProviderRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState): Promise<unknown | undefined> {
	const prepared = prepareCodexProviderRequest(payload, ctx, state);
	if (!prepared) return undefined;
	const { plan } = prepared;
	let rewrittenPayload = prepared.preparedPayload;
	if (plan.nativeCompaction || state.pendingPiCompactionNativeWindow) {
		// The pending window is the caller's state: hand the snapshot to the injection and decide its
		// fate from the returned status, not from whether the field happens to be empty afterwards.
		const pending = state.pendingPiCompactionNativeWindow;
		const injection = await injectNativeWindowIntoPiCompactionRequest(rewrittenPayload, ctx, state, pending);
		if (pending && injection.status !== "not-applicable") state.pendingPiCompactionNativeWindow = undefined;
		rewrittenPayload = injection.status === "injected"
			? injection.payload
			: (await rewriteCodexCompactedProviderRequest(rewrittenPayload, ctx, state)) ?? rewrittenPayload;
	}
	const finalPayload = applyCodexRuntimePayload(
		rewrittenPayload,
		plan.transport === "responses-lite",
	);
	// Stock Responses providers and configured Code Mode overlays have no
	// post-serialization callback. Keep native replay on the instructions that
	// reached this final hook boundary; the custom Codex provider captures again
	// after its transport-specific transforms.
	if (state.pendingActiveProviderPromptCapture) captureActiveProviderSystemPrompt(finalPayload, state);
	return finalPayload;
}

export function rewriteCodexPrewarmProviderRequest(
	payload: unknown,
	ctx: ExtensionContext,
	state: AdapterState,
): unknown | undefined {
	const prepared = prepareCodexProviderRequest(payload, ctx, state);
	if (!prepared) return undefined;
	return applyCodexRuntimePayload(
		prepared.preparedPayload,
		prepared.plan.transport === "responses-lite",
	);
}

function isCodeModeCompatibleBody(value: unknown): value is ResponsesLiteCompatibleBody {
	return typeof value === "object" && value !== null
		&& typeof (value as { model?: unknown }).model === "string"
		&& Array.isArray((value as { input?: unknown }).input);
}

function rewriteContextTools(
	payload: unknown,
	ctx: Pick<ExtensionContext, "model">,
	remote: boolean,
): unknown {
	// Deliberately API-only, unlike the compaction plan's provider-or-API predicate.
	const codexTransport = (ctx.model?.api ?? "").trim().toLowerCase() ===
		"openai-codex-responses";
	return !codexTransport || remote
		? rewriteContextNamespaceTools(payload, { encrypted: remote })
		: payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerSystemPrompt(payload: Record<string, unknown>): string | undefined {
	if (typeof payload["instructions"] === "string") return payload["instructions"];
	if (!Array.isArray(payload["input"])) return undefined;
	for (const item of payload["input"]) {
		if (!isRecord(item) || item["role"] !== "developer" || !Array.isArray(item["content"])) continue;
		const text = item["content"]
			.filter((part): part is Record<string, unknown> => isRecord(part) && part["type"] === "input_text" && typeof part["text"] === "string")
			.map((part) => part["text"] as string)
			.join("\n");
		if (text !== "") return text;
	}
	return undefined;
}
