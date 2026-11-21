import type { Api, Model } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import modelEncodings from "tiktoken/model_to_encoding.json" with { type: "json" };

const encodings = new Map(Object.entries(modelEncodings));
const MAX_BPE_RUN = 8192;
type CounterName = "cl100k_base" | "o200k_base" | "pi-estimate";

export interface QueryInputBudget {
	name: CounterName;
	limit: number;
	unitsPerToken: number;
	/** Exact size in this counter's units, or a partial sum already above stopAfter. */
	measure(text: string, stopAfter?: number): number;
	close?(): void;
}

/** Budget Recall's single system and user messages. No tools, provider wrappers or billable usage. */
export async function queryInputBudget(model: Model<Api>, system: string, inputTokens: number): Promise<QueryInputBudget> {
	const isOpenAI = model.provider === "openai" && (model.api === "openai-completions" || model.api === "openai-responses");
	const chatModel = /^(gpt-|chatgpt-|o[134]\b)/.test(model.id) && !model.id.includes("-instruct");
	const name = isOpenAI && chatModel ? encodings.get(model.id) : undefined;
	if (name !== "cl100k_base" && name !== "o200k_base") {
		const fixed = estimateTokens({ role: "system", content: system, timestamp: 0 });
		// Pi rounds each message's UTF-16 length up to a whole token at 4 units per token.
		return { name: "pi-estimate", limit: 4 * (inputTokens - fixed), unitsPerToken: 4, measure: text => text.length };
	}

	const { get_encoding } = await import("tiktoken");
	const encoder = get_encoding(name);
	const length = (text: string) => {
		// WASM BPE on one giant run can take quadratic time on the host thread. UTF-8 bytes
		// upper-bound ordinary BPE tokens, so the exceptional case can underfill but never overfill.
		if (text.length > MAX_BPE_RUN) {
			for (const [run] of text.matchAll(/\S+|\s+/gu)) {
				if (run.length > MAX_BPE_RUN) return Buffer.byteLength(text, "utf8");
			}
		}
		return encoder.encode_ordinary(text).length;
	};
	// Plain chat framing reference, not a server usage receipt.
	const perMessage = model.id === "gpt-3.5-turbo-0301" ? 4 : 3;
	const fixed = 3 + 2 * perMessage + length("system") + length("user") + length(system);
	return {
		name,
		limit: inputTokens - fixed,
		unitsPerToken: 1,
		measure(text, stopAfter = Infinity) {
			let tokens = 0;
			// Neither pre-tokenizer can join a newline to a following '[' or '#'. Keep trailing newlines on the left.
			for (const piece of text.split(/(?<=\n\n)(?=\[|#)/u)) {
				tokens += length(piece);
				if (tokens > stopAfter) break;
			}
			return tokens;
		},
		close: () => encoder.free(),
	};
}
