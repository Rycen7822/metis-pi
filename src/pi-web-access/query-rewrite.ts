import type { Api, Model } from "@earendil-works/pi-ai";
import type { SummaryGenerationContext } from "./summary-review.ts";
import { AmbiguousModelError, findModelWithProviderRouting, isModelInScope } from "./summary-model-scope.ts";

function resolveFirstAvailableModel(
	ctx: SummaryGenerationContext,
	candidates: Array<{ provider: string; id: string }>,
): Model<Api> {
	const available = ctx.modelRegistry.getAvailable();
	for (const { provider, id } of candidates) {
		try {
			const model = findModelWithProviderRouting(ctx.modelRegistry, provider, id, ctx.scopedModels);
			if (!model || !isModelInScope(model, ctx.scopedModels)) continue;
			if (available.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return model;
		} catch (error) {
			if (!(error instanceof AmbiguousModelError)) throw error;
		}
	}
	throw new Error(`No enabled model available: ${candidates.map(candidate => `${candidate.provider}/${candidate.id}`).join(", ")}`);
}

export async function rewriteSearchQuery(
	query: string,
	ctx: SummaryGenerationContext,
	signal: AbortSignal,
): Promise<string> {
	if (signal.aborted) throw new Error("Aborted");
	const model = resolveFirstAvailableModel(ctx, [
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "google", id: "gemini-3.6-flash" },
		{ provider: "openai", id: "gpt-5-mini" },
	]);
	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [{
				role: "user",
				content: [{ type: "text", text: `Rewrite this web search query to get better, more specific results. Add relevant year qualifiers, precise technical terms, and specificity. Return ONLY the improved query text, nothing else.\n\nQuery: ${query}` }],
				timestamp: Date.now(),
			}],
		},
		{ signal },
	);
	if (signal.aborted || response.stopReason === "aborted") throw new Error("Aborted");
	if (response.stopReason === "error") throw new Error(response.errorMessage || "Query rewrite failed");
	const contentParts = Array.isArray(response.content) ? response.content : [];
	const text = contentParts
		.map((part: unknown) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
		.join("")
		.trim();
	if (!text) throw new Error("Rewrite returned empty response");
	return text;
}
