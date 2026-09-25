import type { Model } from "@earendil-works/pi-ai";
import { CODEX_RESERVE_MODEL } from "../../codex-usage/reserve-policy.ts";

const GPT_56_PRODUCTION_CONTEXT_WINDOW = 272_000;

const UNKNOWN_SUBSCRIPTION_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

export function withCodexReserveModel(models: readonly Model<"openai-codex-responses">[]): Model<"openai-codex-responses">[] {
	const result = [...models];
	const luna = models.find(({ id }) => id === "gpt-5.6-luna");
	// Reserve is the backend-authorized Luna route, not an ordinary selectable model.
	// Keep it resolvable for session resume; provider availability hides it from the picker.
	if (luna && !models.some(({ id }) => id === CODEX_RESERVE_MODEL)) {
		result.push({ ...luna, id: CODEX_RESERVE_MODEL, name: "Luna Reserve", cost: UNKNOWN_SUBSCRIPTION_COST, contextWindow: GPT_56_PRODUCTION_CONTEXT_WINDOW });
	}
	return result.map((model) =>
		/^gpt-5\.6-(?:luna|terra|sol)$/i.test(model.id) && model.contextWindow > GPT_56_PRODUCTION_CONTEXT_WINDOW
			? { ...model, contextWindow: GPT_56_PRODUCTION_CONTEXT_WINDOW }
			: model,
	);
}
