import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { setImmediate } from "node:timers/promises";
import { queryInputBudget, type QueryInputBudget } from "./input-budget.ts";
import { createWindow, WINDOW_SEPARATOR as SEP } from "./window.ts";

const SYSTEM_PROMPT = "You are a session context assistant. " +
	`Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

const WINDOW_NOTE = "\n\n**Note:** This is a large session. The conversation has been windowed to focus on sections " +
	"most relevant to your question. Some messages were omitted or truncated (marked with [...]).";
const HEADER = "## Session Conversation";
const TRUNCATION_MARKER = "[... message truncated ...]";
const TRUNCATED = "\n" + TRUNCATION_MARKER;
const BOOKEND_CHARS = 100;
const STOP_WORDS = new Set(`a an the is was were are be been being have has had do does did will would could should may might can shall
	to of in for on with at by from as into about like through after over between out against during without before under around among and but or nor
	not so yet both either neither each every all any few more most other some such no only own same than too very just because if when where how what
	which who whom this that these those it its they them their we us our you your he him his she her i me my`.split(/\s+/));

function prepareMessages(messages: Message[]): Message[] {
	return messages.flatMap<Message>(message => {
		if (message.role === "toolResult") return [];
		if (message.role !== "assistant") return [message];
		const content = message.content.filter(block => block.type !== "thinking");
		return content.length ? [{ ...message, content }] : [];
	});
}

function queryTerms(question: string): string[] {
	const words = question.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/)
		.filter(word => word.length > 2 && !STOP_WORDS.has(word));
	const han = new Set<string>();
	for (const [run] of question.matchAll(/\p{Script=Han}+/gu)) {
		const chars = [...run];
		if (chars.length === 1) han.add(run);
		for (let i = 1; i < chars.length; i++) han.add(chars[i - 1] + chars[i]);
	}
	return words.concat([...han]);
}

function safePrefix(text: string, length: number): string {
	const end = length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1]!) ? length - 1 : length;
	return text.slice(0, end);
}

function tailStart(text: string): number {
	const start = Math.max(0, text.length - BOOKEND_CHARS);
	return start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) ? start - 1 : start;
}

async function selectPrompt(messages: Message[], question: string, counter: QueryInputBudget, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const { limit, measure } = counter;
	const prepared = prepareMessages(messages);
	const footer = `## Question${SEP}${question}`;
	const full = HEADER + SEP + serializeConversation(prepared) + SEP + footer;
	if (measure(full, limit) <= limit) return { text: full, wasWindowed: false };
	const prefix = HEADER + WINDOW_NOTE + SEP;
	const instructionsLimit = limit - counter.unitsPerToken;
	if (measure(prefix + SEP + footer, instructionsLimit) > instructionsLimit) {
		throw new Error("The recall question and instructions exceed the selected model's input budget.");
	}

	const texts = prepared.map(message => serializeConversation([message])).filter(Boolean);
	const keywords = queryTerms(question);
	const matches = texts.map((text, index) => {
		const lower = text.toLowerCase();
		return { index, score: keywords.reduce((score, term) => score + Number(lower.includes(term)), 0) };
	})
		.filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
	const bookends = [...new Set([0, texts.length - 1, 1, texts.length - 2, 2, texts.length - 3])]
		.filter(index => index >= 0 && index < texts.length);
	const priority = [...new Set([...matches.map(match => match.index), ...bookends,
		...matches.flatMap(match => [match.index - 1, match.index + 1]).filter(index => index >= 0 && index < texts.length),
		...texts.map((_, index) => index)])];
	const window = createWindow(texts.length, limit - measure(prefix) - measure(footer), measure);
	const excerptCost = (text: string, available: number) => measure(text + SEP, available);
	// The marker starts after a newline, so its suffix cannot merge with the preceding excerpt.
	// Its cost is a lower bound even when BPE does not grow monotonically with prefix length.
	const truncationFloor = excerptCost(TRUNCATION_MARKER, Infinity);
	// Keep setup and final-state anchors before spending spare capacity on matches.
	for (const index of bookends) {
		const text = texts[index]!;
		const excerpt = text.length <= 2 * BOOKEND_CHARS ? text
			: safePrefix(text, BOOKEND_CHARS) + TRUNCATED + "\n" + text.slice(tailStart(text));
		const { available, put } = window.at(index);
		const cost = excerptCost(excerpt, available);
		if (cost <= available) put({ text: excerpt, cost });
	}
	for (let position = 0; position < priority.length; position++) {
		const index = priority[position]!;
		if (position % 32 === 0) await setImmediate(undefined, { signal });
		const text = texts[index]!;
		const { available, replacing, put } = window.at(index);
		if (available < 1) continue;
		const cost = excerptCost(text, available);
		if (cost <= available) {
			put({ text, cost });
			continue;
		}

		const keepTail = replacing && bookends.includes(index);
		const end = keepTail ? tailStart(text) : text.length;
		const tail = keepTail ? "\n" + text.slice(end) : "";
		if ((keepTail ? excerptCost(TRUNCATION_MARKER + tail, available) : truncationFloor) > available) continue;

		// An oversized relevant record must not bypass the budget or hide truncation.
		const lower = text.toLowerCase();
		const hit = keywords.map(word => lower.indexOf(word)).filter(at => at >= 0).sort((a, b) => a - b)[0];
		let start = hit === undefined ? 0 : Math.max(0, hit - 100);
		if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
		const head = start > 0 ? safePrefix(text, Math.min(BOOKEND_CHARS, start)) + TRUNCATED + "\n" : "";
		const rest = text.slice(start, end);
		let best: { text: string; cost: number } | undefined;
		let low = 0, high = rest.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const excerpt = head + safePrefix(rest, middle) + TRUNCATED + tail;
			const cost = excerptCost(excerpt, available);
			if (cost <= available) {
				best = { text: excerpt, cost };
				low = middle;
			} else high = middle - 1;
		}
		if (best) put(best);
	}
	signal?.throwIfAborted();
	const text = prefix + window.render() + SEP + footer;
	if (measure(text, limit) > limit) throw new Error("Recall context exceeds the selected model's input budget.");
	return { text, wasWindowed: true };
}

export async function createRecallRequest(messages: Message[], question: string, model: Model<Api>, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const counter = await queryInputBudget(model, SYSTEM_PROMPT, Math.floor(model.contextWindow * 0.8));
	try {
		const { text, wasWindowed } = await selectPrompt(messages, question, counter, signal);
		const context: Context = {
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text }] }],
		};
		const maxTokens = Math.min(Math.max(1, Math.floor(model.contextWindow * 0.2)), model.maxTokens || Infinity);
		return { context, maxTokens, wasWindowed, inputTokenCounter: counter.name };
	} finally {
		counter.close?.();
	}
}
