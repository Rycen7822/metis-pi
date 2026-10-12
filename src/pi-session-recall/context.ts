import { normalizeContext, type Context, type Message, type Model, type Api } from "@earendil-works/pi-ai";
import { estimateTokens, serializeConversation } from "@earendil-works/pi-coding-agent";
import { setImmediate } from "node:timers/promises";

const SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

const WINDOW_NOTE = "\n\n**Note:** This is a large session. The conversation has been windowed to focus on sections most relevant to your question. Some messages were omitted or truncated (marked with [...]).";
const TRUNCATED = "\n[... message truncated ...]";
const STOP_WORDS = new Set("a an the is was were are be been being have has had do does did will would could should may might can shall to of in for on with at by from as into about like through after over between out against during without before under around among and but or nor not so yet both either neither each every all any few more most other some such no only own same than too very just because if when where how what which who whom this that these those it its they them their we us our you your he him his she her i me my".split(" "));

function prepareMessages(messages: Message[]): Message[] {
	return messages.flatMap<Message>(message => {
		if (message.role === "toolResult") return [];
		if (message.role !== "assistant") return [message];
		const content = message.content.filter(block => block.type !== "thinking");
		return content.length ? [{ ...message, content }] : [];
	});
}

function requestContext(conversation: string, question: string, windowed: boolean): Context {
	return {
		systemPrompt: SYSTEM_PROMPT,
		messages: [{ role: "user", timestamp: Date.now(), content: [
			{ type: "text", text: `## Session Conversation${windowed ? WINDOW_NOTE : ""}\n\n${conversation}\n\n## Question\n\n${question}` },
		] }],
	};
}

/** Use the host's input estimate over the actual normalized request, not a conversation-only estimate. */
function inputTokens(context: Context): number {
	return normalizeContext(context).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function renderWindow(selected: ReadonlyMap<number, string>, total: number): string {
	const parts: string[] = [];
	let next = 0;
	for (const [index, text] of [...selected].sort(([a], [b]) => a - b)) {
		if (index > next) parts.push(`[... ${index - next} messages omitted ...]`);
		parts.push(text);
		next = index + 1;
	}
	if (next < total) parts.push(`[... ${total - next} messages omitted ...]`);
	return parts.join("\n\n");
}

function safePrefix(text: string, length: number): string {
	const end = length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1]!) ? length - 1 : length;
	return text.slice(0, end);
}

export async function createRecallRequest(messages: Message[], question: string, model: Model<Api>, signal?: AbortSignal): Promise<{
	context: Context;
	maxTokens: number;
	wasWindowed: boolean;
}> {
	signal?.throwIfAborted();
	const inputBudget = Math.floor(model.contextWindow * 0.8);
	const maxTokens = Math.min(Math.max(1, Math.floor(model.contextWindow * 0.2)), model.maxTokens || Infinity);
	const prepared = prepareMessages(messages);
	const full = requestContext(serializeConversation(prepared), question, false);
	if (inputTokens(full) <= inputBudget) return { context: full, maxTokens, wasWindowed: false };
	if (inputTokens(requestContext("", question, true)) >= inputBudget) {
		throw new Error("The recall question and instructions exceed the selected model's input budget.");
	}

	const texts = prepared.map(message => serializeConversation([message])).filter(Boolean);
	const keywords = question.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/)
		.filter(word => word.length > 2 && !STOP_WORDS.has(word));
	const matches = texts.map((text, index) => ({ index, score: keywords.filter(word => text.toLowerCase().includes(word)).length }))
		.filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
	const bookends = [...new Set([0, texts.length - 1, 1, texts.length - 2, 2, texts.length - 3])]
		.filter(index => index >= 0 && index < texts.length);
	const priority = [...new Set([...matches.map(match => match.index), ...bookends,
		...matches.flatMap(match => [match.index - 1, match.index + 1]).filter(index => index >= 0 && index < texts.length),
		...texts.map((_, index) => index)])];
	const selected = new Map<number, string>();
	const fits = (index: number, text: string) => inputTokens(requestContext(renderWindow(new Map([...selected, [index, text]]), texts.length), question, true)) <= inputBudget;
	// Keep the original setup/final-state anchors before spending spare capacity
	// on matching neighborhoods. Giant bookends get disclosed head/tail excerpts.
	for (const index of bookends) {
		const text = texts[index]!;
		let tail = Math.max(0, text.length - 100);
		if (tail > 0 && /[\uDC00-\uDFFF]/.test(text[tail]!)) tail--;
		const excerpt = text.length <= 200 ? text : safePrefix(text, 100) + TRUNCATED + "\n" + text.slice(tail);
		if (fits(index, excerpt)) selected.set(index, excerpt);
	}
	for (let position = 0; position < priority.length; position++) {
		const index = priority[position]!;
		if (position % 32 === 0) await setImmediate(undefined, { signal });
		const text = texts[index]!;
		if (fits(index, text)) { selected.set(index, text); continue; }
		// An oversized relevant record must not bypass the budget or hide truncation.
		const lower = text.toLowerCase();
		const hit = keywords.map(word => lower.indexOf(word)).filter(at => at >= 0).sort((a, b) => a - b)[0];
		let start = hit === undefined ? 0 : Math.max(0, hit - 100);
		if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
		const head = start > 0 ? safePrefix(text, Math.min(100, start)) + TRUNCATED + "\n" : "";
		let tailStart = Math.max(0, text.length - 100);
		if (tailStart > 0 && /[\uDC00-\uDFFF]/.test(text[tailStart]!)) tailStart--;
		const keepTail = selected.has(index) && bookends.includes(index);
		const tail = keepTail ? "\n" + text.slice(tailStart) : "";
		const fragment = (length: number) => head + safePrefix(text.slice(start), length) + TRUNCATED + tail;
		let low = 0, high = keepTail ? Math.max(0, tailStart - start) : text.length - start;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fits(index, fragment(middle))) low = middle;
			else high = middle - 1;
		}
		if (low > 0) selected.set(index, fragment(low));
	}
	const context = requestContext(renderWindow(selected, texts.length), question, true);
	if (inputTokens(context) > inputBudget) throw new Error("Recall context exceeds the selected model's input budget.");
	return { context, maxTokens, wasWindowed: true };
}
