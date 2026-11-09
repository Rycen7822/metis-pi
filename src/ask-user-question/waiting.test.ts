import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { expect, it, onTestFinished, vi } from "vitest";
import { buildQuestionnaireResponse, registerAskUserQuestionTool } from "./ask-user-question.ts";
import { ASK_USER_BLOCKED_EVENT } from "./events.ts";
import { runRpcQuestionnaire } from "./rpc-fallback.ts";
import type { QuestionnaireSessionComponent } from "./state/questionnaire-session.ts";
import type { QuestionParams } from "./tool/types.ts";
import { waitForQuestionnaire } from "./tool/wait.ts";

const questions = [{ question: "Which approach?", header: "Approach", options: [
	{ label: "First", description: "First approach" },
	{ label: "Second", description: "Second approach" },
] }];
const theme = {
	fg: (_: string, text: string) => text,
	bg: (_: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
};

function start(mode: "tui" | "rpc", waitMode: QuestionParams["mode"]) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const { pi, captured } = createMockPi();
	// Hidden registration avoids the unrelated session prewarm timer in this fixture.
	registerAskUserQuestionTool(pi, "hidden");
	const controller = new AbortController();
	let opened!: () => void;
	const ready = new Promise<void>(resolve => { opened = resolve; });
	let component!: QuestionnaireSessionComponent;
	let reply!: (value: string | undefined) => void;
	const ctx = createMockCtx({ hasUI: true, mode, ui: {
		custom: vi.fn(factory => new Promise(resolve => {
			component = factory(
				{ requestRender() {}, terminal: { columns: 120, rows: 24 }, hasOverlay: () => false },
				theme, getKeybindings(), resolve,
			);
			opened();
		})) as never,
		select: vi.fn((_title, _options, options) => new Promise<string | undefined>(resolve => {
			reply = resolve;
			options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			opened();
		})),
	} });
	const pending = captured.tools.get("ask_user_question")!.execute(
		"wait-mode", { questions, ...(waitMode ? { mode: waitMode } : {}) }, controller.signal, undefined, ctx,
	);
	onTestFinished(async () => {
		controller.abort();
		await Promise.resolve(pending).catch(() => {});
		vi.useRealTimers();
	});
	return { pending, ready, controller, captured,
		submit: () => mode === "tui" ? component.handleInput("\r") : reply("1. First — First approach"),
		cancel: () => mode === "tui" ? component.handleInput("\x1b") : reply(undefined),
	};
}

it.each(["tui", "rpc"] as const)("skip dismisses %s only at ten minutes and clears the blocked lifecycle", async mode => {
	const call = start(mode, "skip");
	await call.ready;
	let settled = false;
	void Promise.resolve(call.pending).then(() => { settled = true; });
	await vi.advanceTimersByTimeAsync(599_999);
	expect(settled).toBe(false);
	expect(call.captured.eventsEmitted.get(ASK_USER_BLOCKED_EVENT)?.at(-1)).toEqual({ active: true });
	await vi.advanceTimersByTimeAsync(1);
	const result = await call.pending;
	expect(result?.details).toEqual({ answers: [], cancelled: true, timedOut: true, unanswered: [0] });
	expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("not a user decision or approval") });
	expect(result?.content[0]).not.toMatchObject({ text: expect.stringContaining("declined") });
	expect(call.captured.eventsEmitted.get(ASK_USER_BLOCKED_EVENT)?.at(-1)).toEqual({ active: false });
	expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, "blocking"] as const)("%s mode keeps waiting past ten minutes", async mode => {
	const call = start("rpc", mode);
	await call.ready;
	let settled = false;
	void Promise.resolve(call.pending).then(() => { settled = true; });
	await vi.advanceTimersByTimeAsync(1_200_000);
	expect(settled).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	call.submit();
	expect((await call.pending)?.details).toMatchObject({ cancelled: false, answers: [{ answer: "First" }] });
});

it.each(["tui", "rpc"] as const)("a %s answer before the skip deadline keeps its normal envelope and removes the timer", async mode => {
	const call = start(mode, "skip");
	await call.ready;
	await vi.advanceTimersByTimeAsync(599_999);
	call.submit();
	const result = await call.pending;
	expect(result?.details).toMatchObject({ cancelled: false, answers: [{ answer: "First" }] });
	expect(result?.details).not.toHaveProperty("timedOut");
	expect(vi.getTimerCount()).toBe(0);
});

it.each(["tui", "rpc"] as const)("a %s decline is not reported as a timeout", async mode => {
	const call = start(mode, "skip");
	await call.ready;
	call.cancel();
	const result = await call.pending;
	expect(result?.details).toEqual({ answers: [], cancelled: true });
	expect(vi.getTimerCount()).toBe(0);
});

it.each(["tui", "rpc"] as const)("tool cancellation aborts a skipped %s wait rather than continuing normally", async mode => {
	const call = start(mode, "skip");
	await call.ready;
	const rejected = expect(call.pending).rejects.toThrow();
	call.controller.abort();
	await rejected;
	expect(call.captured.eventsEmitted.get(ASK_USER_BLOCKED_EVENT)?.at(-1)).toEqual({ active: false });
	expect(vi.getTimerCount()).toBe(0);
});

it("RPC timeout preserves earlier answers without giving each dialog another ten minutes", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const controller = new AbortController();
	let firstReply!: () => void;
	let firstOpened!: () => void;
	const firstReady = new Promise<void>(resolve => { firstOpened = resolve; });
	let secondOpened!: () => void;
	const secondReady = new Promise<void>(resolve => { secondOpened = resolve; });
	const select = vi.fn()
		.mockImplementationOnce((_title, _options, options) => new Promise<string | undefined>(resolve => {
			firstReply = () => resolve("1. First — First approach");
			options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
			firstOpened();
		}))
		.mockImplementationOnce((_title, _options, options) => new Promise(resolve => {
			options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
			secondOpened();
		}));
	const params: QuestionParams = { mode: "skip", questions: [...questions, { ...questions[0]!, question: "Second question?" }] };
	const pending = waitForQuestionnaire(params, controller.signal,
		signal => runRpcQuestionnaire({ select, input: vi.fn() }, params, signal));
	onTestFinished(async () => {
		controller.abort();
		await pending.catch(() => {});
		vi.useRealTimers();
	});
	await firstReady;
	await vi.advanceTimersByTimeAsync(540_000);
	firstReply();
	await secondReady;
	await vi.advanceTimersByTimeAsync(60_000);
	const result = await pending;
	expect(result).toMatchObject({ cancelled: true, timedOut: true, answers: [{ questionIndex: 0, answer: "First" }] });
	const response = buildQuestionnaireResponse(result, params);
	expect(response.details.unanswered).toEqual([1]);
	expect(response.content[0]?.text).toContain('"Which approach?"="First".');
	expect(select).toHaveBeenCalledTimes(2);
	expect(vi.getTimerCount()).toBe(0);
});
