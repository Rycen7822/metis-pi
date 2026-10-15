const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type SummaryThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelLike {
	provider: string;
	id: string;
}

export interface ModelRegistryLike<T extends ModelLike = ModelLike> {
	find(provider: string, id: string): T | undefined;
	getAvailable(): readonly T[];
}

export class AmbiguousModelError extends Error {
	name = "AmbiguousModelError";
}

/**
 * Resolve a model through its native provider or a provider that routes that model ID.
 *
 * The direct registry fallback preserves explicit/native model resolution when a
 * provider's availability snapshot does not include the configured model. Callers
 * continue to apply their existing enabled-model and authentication checks.
 */
export function findModelWithProviderRouting<T extends ModelLike>(
	registry: ModelRegistryLike<T>,
	provider: string,
	id: string,
	scopedModels: ReadonlyArray<{ model: ModelLike }> = [],
): T | undefined {
	const available = registry.getAvailable().filter(model => isModelInScope(model, scopedModels));
	const direct = available.find(model => model.provider === provider && model.id === id);
	if (direct) return direct;

	const routedId = `${provider}/${id}`;
	const routed = available.filter(model => model.id === routedId);
	if (routed.length > 1) {
		const choices = routed.map(model => `${model.provider}/${model.id}`).sort();
		throw new AmbiguousModelError(`Ambiguous model ${routedId}. Specify an explicit provider/model: ${choices.join(", ")}.`);
	}
	return routed[0] ?? registry.find(provider, id);
}

/**
 * Pi resolves `--models` and `enabledModels` against the available catalogue and exposes the
 * result as `ctx.scopedModels`; an empty scope means every available model is allowed.
 */
export function isModelInScope(model: ModelLike, scopedModels: ReadonlyArray<{ model: ModelLike }>): boolean {
	return scopedModels.length === 0 || scopedModels.some(scoped => scoped.model.provider === model.provider && scoped.model.id === model.id);
}

export function splitThinkingSuffix(value: string): { value: string; thinkingLevel?: SummaryThinkingLevel } {
	const index = value.lastIndexOf(":");
	if (index < 0) return { value };
	const suffix = value.slice(index + 1);
	return THINKING_LEVELS.has(suffix)
		? { value: value.slice(0, index), thinkingLevel: suffix as SummaryThinkingLevel }
		: { value };
}
