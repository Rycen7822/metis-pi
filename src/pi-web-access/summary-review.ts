import type { Api, Message, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AmbiguousModelError, findModelWithProviderRouting, isModelInScope, splitThinkingSuffix, type SummaryThinkingLevel } from "./summary-model-scope.ts";
import type { QueryResultData } from "./search-types.ts";
import { loadWebAccessConfig } from "./utils.ts";

type ProviderHeaders = Record<string, string | null>;
type CompleteFunction = typeof complete;

const PREFERRED_SUMMARY_MODELS = [
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "openai-codex", id: "gpt-5.6-luna" },
	{ provider: "openai", id: "gpt-5.6-luna" },
	{ provider: "openai-codex", id: "gpt-5.6-terra" },
	{ provider: "openai", id: "gpt-5.6-terra" },
	{ provider: "google", id: "gemini-3.6-flash" },
	{ provider: "openai", id: "gpt-5-mini" },
	{ provider: "deepseek", id: "deepseek-v4-flash" },
] as const;

export const SUMMARY_GENERATION_DEADLINE_MS = 30_000;

export interface SummaryMeta {
	model: string | null;
	durationMs: number;
	tokenEstimate: number;
	fallbackUsed: boolean;
	fallbackReason?: string;
	phase?: "summary-model" | "deterministic-fallback";
	edited?: boolean;
}

export type SummaryGenerationContext = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "scopedModels">;

function estimateTokens(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return Math.max(1, Math.ceil(trimmed.length / 4));
}

function summarizeQueryResult(result: QueryResultData): string {
	if (result.error) {
		return `Query: ${result.query}\nStatus: Error\nError: ${result.error}`;
	}

	const lines = [
		`Query: ${result.query}`,
		`Provider: ${result.provider ?? "unknown"}`,
		`Answer: ${result.answer || "(no answer text returned)"}`,
	];

	if (result.results.length === 0) {
		lines.push("Sources: none");
		return lines.join("\n");
	}

	lines.push("Sources:");
	for (let i = 0; i < result.results.length; i++) {
		const source = result.results[i];
		lines.push(`${i + 1}. ${source.title} — ${source.url}`);
	}

	return lines.join("\n");
}

export function buildSummaryPrompt(results: QueryResultData[], feedback?: string, instructions?: string): string {
	const sections = [
		"You are writing the final web search summary for a coding assistant.",
		"Write a concise, factual summary using only the provided search results.",
		"Requirements:",
		"- Keep it readable and skimmable.",
		"- Include key findings and caveats.",
		"- Do not invent sources or claims.",
		"- If evidence is weak or conflicting, say so explicitly.",
		"- End with a short \"Sources\" section listing the most relevant URLs.",
	];

	const extraInstructions = typeof instructions === "string" ? instructions.trim() : "";
	if (extraInstructions) {
		sections.push(extraInstructions);
	}

	if (feedback) {
		sections.push("- Incorporate the user feedback provided below into the summary.");
	}

	sections.push("");
	sections.push("<search_results>");

	for (let i = 0; i < results.length; i++) {
		sections.push(`\n[Result ${i + 1}]`);
		sections.push(summarizeQueryResult(results[i]));
	}

	sections.push("\n</search_results>");

	if (feedback) {
		sections.push("");
		sections.push("<user_feedback>");
		sections.push(feedback);
		sections.push("</user_feedback>");
	}

	return sections.join("\n");
}

function buildDeterministicAnswerPreview(answer: string): string {
	let text = answer.replace(/\s+/g, " ").trim();
	if (text.length === 0) return "";

	const sourceMarker = text.search(/\bSources?\s*:/i);
	if (sourceMarker >= 0) text = text.slice(0, sourceMarker).trim();
	if (text.length === 0) return "";

	return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function buildDeterministicSummaryLines(results: QueryResultData[]): string[] {
	if (results.length === 0) {
		return [
			"No completed search results were available when the curator session finished.",
			"",
			"Sources",
			"- None",
		];
	}

	const lines: string[] = [
		"Summary based on the currently selected search results.",
		"",
	];

	const sourceUrls: string[] = [];
	let successful = 0;
	let failed = 0;

	for (const result of results) {
		if (result.error) {
			failed += 1;
			lines.push(`- ${result.query}: failed (${result.error})`);
			continue;
		}

		successful += 1;
		const preview = buildDeterministicAnswerPreview(result.answer);
		if (preview.length > 0) {
			lines.push(`- ${result.query}: ${preview}`);
		} else {
			lines.push(`- ${result.query}: returned ${result.results.length} source${result.results.length === 1 ? "" : "s"} without answer text.`);
		}

		for (const source of result.results) {
			if (!sourceUrls.includes(source.url)) {
				sourceUrls.push(source.url);
			}
		}
	}

	lines.push("");
	lines.push(`Completed queries: ${results.length}`);
	lines.push(`Successful: ${successful}`);
	lines.push(`Failed: ${failed}`);
	lines.push("");
	lines.push("Sources");

	if (sourceUrls.length === 0) {
		lines.push("- None");
	} else {
		for (const url of sourceUrls.slice(0, 12)) {
			lines.push(`- ${url}`);
		}
		if (sourceUrls.length > 12) {
			lines.push(`- ... and ${sourceUrls.length - 12} more`);
		}
	}

	return lines;
}

export function buildDeterministicSummary(results: QueryResultData[]): { summary: string; meta: SummaryMeta } {
	const summary = buildDeterministicSummaryLines(results).join("\n").trim();
	const nonEmptySummary = summary.length > 0
		? summary
		: "No completed search results were available when the curator session finished.\n\nSources\n- None";

	return {
		summary: nonEmptySummary,
		meta: {
			model: null,
			durationMs: 0,
			tokenEstimate: estimateTokens(nonEmptySummary),
			fallbackUsed: true,
			fallbackReason: "deterministic-submit-fallback",
			phase: "deterministic-fallback",
			edited: false,
		},
	};
}

function parseModelSelector(value: string): { provider: string; id: string; thinkingLevel?: SummaryThinkingLevel } {
	const selector = splitThinkingSuffix(value);
	const slashIndex = selector.value.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= selector.value.length - 1) {
		throw new Error(`Invalid summary model: ${value}. Use provider/model-id.`);
	}
	return {
		provider: selector.value.slice(0, slashIndex),
		id: selector.value.slice(slashIndex + 1),
		thinkingLevel: selector.thinkingLevel,
	};
}

async function resolveThinkingLevel(model: Model<Api>, requested?: SummaryThinkingLevel): Promise<ModelThinkingLevel | undefined> {
	if (!requested) return undefined;
	const { clampThinkingLevel } = await import("@earendil-works/pi-ai");
	return clampThinkingLevel(model, requested as ModelThinkingLevel);
}

function findSummaryModel(ctx: SummaryGenerationContext, spec: { provider: string; id: string }) {
	try {
		return findModelWithProviderRouting(ctx.modelRegistry, spec.provider, spec.id, ctx.scopedModels);
	} catch (error) {
		if (error instanceof AmbiguousModelError) {
			throw new AmbiguousModelError(`${error.message} Set [webAccess].summaryModel in metis-pi.toml to one of these selectors.`);
		}
		throw error;
	}
}

function resolveSummaryModelCandidates(
	ctx: SummaryGenerationContext,
	modelOverride?: string,
): { candidates: Iterable<{ model: Model<Api>; thinkingLevel?: SummaryThinkingLevel }>; errors: string[] } {
	const selector = modelOverride ?? loadWebAccessConfig().summaryModel;
	const normalizedOverride = typeof selector === "string" ? selector.trim() : "";
	let selected: ReturnType<typeof parseModelSelector> | undefined;
	try {
		if (normalizedOverride) selected = parseModelSelector(normalizedOverride);
	} catch (error) {
		// Malformed TOML defaults use the same preferred candidates as the model choices.
		if (modelOverride != null) throw error;
	}
	const specs: readonly ReturnType<typeof parseModelSelector>[] = selected ? [selected] : PREFERRED_SUMMARY_MODELS;

	const errors: string[] = [];
	function* candidates() {
		for (const spec of specs) {
			const value = `${spec.provider}/${spec.id}`;
			const model = findSummaryModel(ctx, spec);
			if (!model) {
				errors.push(`Summary model not found: ${value}`);
				continue;
			}
			if (!isModelInScope(model, ctx.scopedModels)) {
				errors.push(`Summary model is not enabled: ${value}`);
				continue;
			}
			yield { model, thinkingLevel: spec.thinkingLevel };
		}
	}
	return { candidates: candidates(), errors };
}

/** UI choices and execution defaults share the summary domain's model policy. */
export async function loadSummaryModelChoices(
	ctx: SummaryGenerationContext,
): Promise<{
	summaryModels: Array<{ value: string; label: string }>;
	defaultSummaryModel: string | null;
	summaryModelError?: string;
}> {
	const summaryModels: Array<{ value: string; label: string }> = [];
	const seen = new Set<string>();
	const availableValues = new Set<string>();
	const add = (value: string) => {
		if (seen.has(value)) return;
		seen.add(value);
		summaryModels.push({ value, label: value });
	};
	for (const model of ctx.modelRegistry.getAvailable()) {
		if (!isModelInScope(model, ctx.scopedModels)) continue;
		const value = `${model.provider}/${model.id}`;
		availableValues.add(value);
		add(value);
	}
	if (ctx.model && isModelInScope(ctx.model, ctx.scopedModels)) add(`${ctx.model.provider}/${ctx.model.id}`);

	const configured = loadWebAccessConfig().summaryModel;
	const selector = typeof configured === "string" ? configured.trim() : "";
	let defaultSummaryModel: string | null = availableValues.has(selector) ? selector : null;
	try {
		if (!defaultSummaryModel && selector) {
			let spec: ReturnType<typeof parseModelSelector> | undefined;
			try { spec = parseModelSelector(selector); } catch { /* Malformed UI defaults use the preferred available model. */ }
			if (spec) {
				const model = findSummaryModel(ctx, spec);
				if (!model || !availableValues.has(`${model.provider}/${model.id}`)) {
					return {
						summaryModels, defaultSummaryModel: null,
						summaryModelError: `Summary model is not available or enabled: ${selector}. Check [webAccess].summaryModel in metis-pi.toml.`,
					};
				}
				add(selector);
				defaultSummaryModel = selector;
			}
		}
		if (!defaultSummaryModel) {
			for (const preferred of PREFERRED_SUMMARY_MODELS) {
				const model = findSummaryModel(ctx, preferred);
				if (model && availableValues.has(`${model.provider}/${model.id}`)) {
					defaultSummaryModel = `${model.provider}/${model.id}`;
					break;
				}
			}
		}
	} catch (error) {
		if (!(error instanceof AmbiguousModelError)) throw error;
		return { summaryModels, defaultSummaryModel: null, summaryModelError: error.message };
	}
	return { summaryModels, defaultSummaryModel };
}

function buildFallbackSummary(
	results: QueryResultData[],
	fallbackReason: string,
	durationMs = 0,
): { summary: string; meta: SummaryMeta } {
	const deterministic = buildDeterministicSummary(results);
	return {
		summary: deterministic.summary,
		meta: {
			...deterministic.meta,
			durationMs,
			fallbackReason,
		},
	};
}

export async function generateSummaryDraft(
	results: QueryResultData[],
	ctx: SummaryGenerationContext,
	signal?: AbortSignal,
	modelOverride?: string,
	feedback?: string,
	completeFn?: CompleteFunction,
	deadlineMs = SUMMARY_GENERATION_DEADLINE_MS,
	instructions?: string,
): Promise<{ summary: string; meta: SummaryMeta }> {
	if (!ctx || !ctx.modelRegistry) {
		throw new Error("Summary generation context unavailable");
	}
	if (signal?.aborted) throw new Error("Aborted");

	const registry = ctx.modelRegistry;
	const customCompleteFn = completeFn !== undefined;

	const generationStartedAt = Date.now();
	const deadlineController = new AbortController();
	const deadlineMarker = Symbol("summary-generation-deadline");
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadlinePromise = new Promise<typeof deadlineMarker>(resolve => {
		deadlineTimer = setTimeout(() => {
			deadlineController.abort();
			resolve(deadlineMarker);
		}, deadlineMs);
	});

	let callerAbortListener: (() => void) | undefined;
	const callerAbortPromise = signal
		? new Promise<never>((_, reject) => {
			callerAbortListener = () => reject(new Error("Aborted"));
			if (signal.aborted) callerAbortListener();
			else signal.addEventListener("abort", callerAbortListener, { once: true });
		})
		: undefined;
	const completionSignal = signal
		? AbortSignal.any([signal, deadlineController.signal])
		: deadlineController.signal;

	function checkSummaryDeadline(): void {
		if (signal?.aborted) throw new Error("Aborted");
		// Imports or synchronous providers can finish before an overdue timer runs.
		if (deadlineController.signal.aborted || Date.now() - generationStartedAt >= deadlineMs) {
			deadlineController.abort();
			throw deadlineMarker;
		}
	}

	async function raceSummaryOperation<T>(operation: Promise<T>): Promise<T> {
		// A provider may ignore AbortSignal and never settle; observe it before racing so
		// its eventual rejection cannot become an unhandled promise rejection.
		void operation.then(() => undefined, () => undefined);
		checkSummaryDeadline();
		const contenders: Promise<unknown>[] = [operation, deadlinePromise];
		if (callerAbortPromise) contenders.push(callerAbortPromise);
		const result = await Promise.race(contenders);
		checkSummaryDeadline();
		return result as T;
	}

	try {
		if (signal?.aborted) throw new Error("Aborted");
		const prompt = buildSummaryPrompt(results, feedback, instructions);
		let lastError: string | undefined;
		let lastFailure: "empty" | "error" | undefined;
		try {
			checkSummaryDeadline();
			const resolved = resolveSummaryModelCandidates(ctx, modelOverride);
			for (const { model, thinkingLevel } of resolved.candidates) {
				const startedAt = Date.now();
				try {
					// sessionId lets pi-ai's OpenCode providers add x-opencode-session. cacheRetention "none" keeps this
					// one-off call out of the session's prompt cache and Codex continuation, as Pi does for compaction.
					const sessionId = ctx.sessionManager?.getSessionId?.();
					const userMessage: Message = {
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					};
					const requestedThinkingLevel = await raceSummaryOperation(resolveThinkingLevel(model, thinkingLevel));
					const enabledThinkingLevel = requestedThinkingLevel && requestedThinkingLevel !== "off"
						? requestedThinkingLevel as ThinkingLevel
						: undefined;
					const completionOptions = {
						sessionId,
						cacheRetention: "none" as const,
						signal: completionSignal,
						...(requestedThinkingLevel ? { reasoning: requestedThinkingLevel } : {}),
						...(enabledThinkingLevel ? { reasoningEffort: enabledThinkingLevel } : {}),
					};
					let authOptions: { apiKey?: string; headers?: ProviderHeaders } = {};
					// Only the explicitly injected low-level seam needs auth options. Production
					// requests authenticate once, at the native ModelRegistry completion boundary.
					if (customCompleteFn) {
						const auth = await raceSummaryOperation(registry.getApiKeyAndHeaders(model));
						if (!auth.ok) throw new Error(`No API key available for summary model ${model.provider}/${model.id}`);
						authOptions = { apiKey: auth.apiKey, headers: auth.headers };
					}
					checkSummaryDeadline();
					const completion = customCompleteFn
						? completeFn!(model, { messages: [userMessage] }, { ...completionOptions, ...authOptions })
						: registry.complete(model, { messages: [userMessage] }, completionOptions);

					const response = await raceSummaryOperation(Promise.resolve(completion));
					if (response.stopReason === "aborted") throw new DOMException("Aborted", "AbortError");
					if (response.stopReason === "error") throw new Error(response.errorMessage || "Summary model failed");

					const summary = response.content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.filter(text => text.trim().length > 0)
						.join("\n")
						.trim();
					if (summary.length === 0) {
						lastFailure = "empty";
						continue;
					}

					return {
						summary,
						meta: {
							model: `${model.provider}/${model.id}`,
							durationMs: Math.max(0, Date.now() - startedAt),
							tokenEstimate: estimateTokens(summary),
							fallbackUsed: false,
							phase: "summary-model",
							edited: false,
						},
					};
				} catch (err) {
					checkSummaryDeadline();
					if (err instanceof Error && err.name === "AbortError") throw err;
					lastError = err instanceof Error ? err.message : String(err);
					lastFailure = "error";
				}
			}

			lastError ??= resolved.errors.at(-1);
		} catch (err) {
			checkSummaryDeadline();
			if (err instanceof AmbiguousModelError || (err instanceof Error && err.name === "AbortError")) throw err;
			const message = err instanceof Error ? err.message : String(err);
			return buildFallbackSummary(results, `summary-model-settings-error: ${message}`, Date.now() - generationStartedAt);
		}

		return buildFallbackSummary(
			results,
			lastFailure === "empty" ? "summary-model-empty-response" : lastError ? `summary-model-unavailable: ${lastError}` : "summary-model-unavailable",
			Date.now() - generationStartedAt,
		);
	} catch (err) {
		if (signal?.aborted) throw new Error("Aborted");
		if (err === deadlineMarker) {
			return buildFallbackSummary(results, "summary-generation-timeout", Date.now() - generationStartedAt);
		}
		throw err;
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		if (signal && callerAbortListener) signal.removeEventListener("abort", callerAbortListener);
	}
}
