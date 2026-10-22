import type { QuestionParams } from "./tool/types.ts";
import { createMockCtx, createMockPi, mockStdout } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { BEL, registerAskUserQuestionTool } from "./ask-user-question.ts";

type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;
type InputFn = (title: string, placeholder?: string) => Promise<string | undefined>;

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

function registerWithCapture() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return { tool: captured.tools.get("ask_user_question")!, captured };
}

/** Native RPC context: explicit mode and SDK dialog primitives. */
function ctxRpc(opts: { select?: SelectFn; input?: InputFn } = {}) {
	return createMockCtx({
		hasUI: true,
		mode: "rpc",
		ui: {
			select: (opts.select ?? vi.fn(async () => undefined)) as never,
			input: (opts.input ?? vi.fn(async () => "")) as never,
		} as never,
	});
}

const SINGLE = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
} satisfies QuestionParams;

const MULTI = {
	questions: [
		{
			question: "Pick colors?",
			header: "Colors",
			multiSelect: true,
			options: [
				{ label: "red", description: "r" },
				{ label: "green", description: "g" },
				{ label: "blue", description: "b" },
			],
		},
	],
} satisfies QuestionParams;

async function run(tool: ReturnType<typeof register>, params: unknown, ctx: unknown) {
	return await tool.execute("tc", params as never, undefined, undefined, ctx as never);
}

describe("ask_user_question.execute — RPC dialog walker (ctx.mode === 'rpc')", () => {
	it("single-select uses ctx.ui.select and returns the chosen label in the envelope", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options[1]); // "2. B — b"
		const ctx = ctxRpc({ select });
		const r = await run(tool, SINGLE, ctx);
		expect(select).toHaveBeenCalledOnce();
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="B"') });
		expect(r?.content[0]).toMatchObject({ text: expect.stringMatching(/^User has answered your questions:/) });
	});

	it("does NOT call ctx.ui.custom in RPC mode", async () => {
		const tool = register();
		const custom = vi.fn(async () => ({ answers: [], cancelled: true }));
		const ctx = createMockCtx({
			hasUI: true,
			mode: "rpc",
			ui: {
				custom: custom as never,
				select: vi.fn(async (_t: string, o: string[]) => o[0]) as never,
				input: vi.fn(async () => "") as never,
			} as never,
		});
		await run(tool, SINGLE, ctx);
		expect(custom).not.toHaveBeenCalled();
	});

	it("writes one BEL before the first RPC dialog and clears the blocked lifecycle afterward", async () => {
		const stdout = mockStdout(true);
		try {
			const mockEmit = vi.fn();
			const { pi, captured } = createMockPi({
				events: { emit: mockEmit, on: vi.fn(() => () => {}) },
			});
			registerAskUserQuestionTool(pi);
			const tool = captured.tools.get("ask_user_question")!;
			const select = vi.fn(async (_t: string, options: string[]) => options[0]);

			await run(tool, SINGLE, ctxRpc({ select }));

			expect(stdout.stdoutWrite).toHaveBeenCalledTimes(1);
			expect(stdout.stdoutWrite).toHaveBeenCalledWith(BEL);
			expect(mockEmit).toHaveBeenNthCalledWith(2, "rpiv:ask-user:blocked", { active: true });
			expect(mockEmit).toHaveBeenNthCalledWith(3, "rpiv:ask-user:blocked", { active: false });
			expect(mockEmit.mock.calls.filter(([name]) => name === "rpiv:ask-user:blocked")).toEqual([
				["rpiv:ask-user:blocked", { active: true }],
				["rpiv:ask-user:blocked", { active: false }],
			]);
			expect(mockEmit.mock.invocationCallOrder[1]).toBeLessThan(stdout.stdoutWrite.mock.invocationCallOrder[0]);
			expect(stdout.stdoutWrite.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]);
		} finally {
			stdout.restore();
		}
	});

	it("does not write BEL when RPC stdout is not a TTY", async () => {
		const stdout = mockStdout(false);
		try {
			const tool = register();
			const select = vi.fn(async (_t: string, options: string[]) => options[0]);

			await run(tool, SINGLE, ctxRpc({ select }));

			expect(select).toHaveBeenCalledOnce();
			expect(stdout.stdoutWrite).not.toHaveBeenCalled();
		} finally {
			stdout.restore();
		}
	});

	it("appends the 'Type something.' sentinel row from the shared protocol labels", async () => {
		const tool = register();
		let offered: string[] = [];
		const select = vi.fn(async (_t: string, options: string[]) => {
			offered = options;
			return options[0];
		});
		await run(tool, SINGLE, ctxRpc({ select }));
		expect(offered).toEqual(["1. A — a", "2. B — b", "3. Type something."]);
	});

	it("'Type something.' sentinel follows up with ctx.ui.input for custom text", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options[options.length - 1]);
		const input = vi.fn(async () => "typed it");
		const r = await run(tool, SINGLE, ctxRpc({ select, input }));
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="typed it"') });
	});
	it.each(["", " "])("preserves an explicitly confirmed custom input %j like the TUI", async typed => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options.at(-1));
		const input = vi.fn(async () => typed);
		const result = await run(tool, SINGLE, ctxRpc({ select, input }));
		expect(result.details).toMatchObject({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which?", kind: "custom", answer: typed.length ? typed : null }],
		});
	});

	it.each([[undefined, false], ["", false], ["PREVIEW-A", true]] as const)("omits empty RPC previews (%j)", async (preview, hasPreview) => {
		const tool = register();
		const withPreview = {
			questions: [
				{
					question: "Which?",
					header: "Pick",
					options: [
						{ label: "A", description: "a", ...(preview === undefined ? {} : { preview }) },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		let title = "";
		const select = vi.fn(async (t: string, options: string[]) => {
			title = t;
			return options[0];
		});
		const r = await run(tool, withPreview, ctxRpc({ select }));
		const answers = (r.details as { answers: object[] }).answers;
		expect(Object.hasOwn(answers[0], "preview")).toBe(hasPreview);
		if (hasPreview) {
			expect(title).toContain("PREVIEW-A");
			expect(r.content[0]).toMatchObject({ text: expect.stringContaining("selected preview: PREVIEW-A") });
		} else expect(r.content[0]).toMatchObject({ text: expect.not.stringContaining("selected preview:") });
	});

	it.each([
		["1,3", ["red", "green", "blue"], ["red", "blue"]],
		["3,1,3", ["red", "green", "blue"], ["red", "blue"]],
	] as const)("RPC selection %j follows authored option order", async (value, labels, selected) => {
		const tool = register();
		const input = vi.fn(async () => value);
		const params = { questions: [{ ...MULTI.questions[0], options: labels.map(label => ({ label, description: label })) }] };
		const r = await run(tool, params, ctxRpc({ input }));
		expect(input).toHaveBeenCalledOnce();
		expect(r?.details).toMatchObject({ cancelled: false, answers: [{ selected }] });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining(`"Pick colors?"="${selected.join(", ")}"`) });
	});

	it.each([
		[" another color", " another color"], ["keep padding  ", "keep padding  "],
		["  more; detail  ", "  more; detail  "], ["   ", null],
	] as const)("multi-select preserves selected labels and custom suffix %j", async (custom, answer) => {
		const tool = register();
		const input = vi.fn(async () => `1,3;${custom}`);
		const r = await run(tool, MULTI, ctxRpc({ input }));
		expect(r?.details).toMatchObject({
			answers: [{ kind: "multi", selected: ["red", "blue"], answer }],
		});
		expect(r?.content[0]).toMatchObject({
			text: expect.stringContaining(`"Pick colors?"="red, blue${answer === null ? "" : `, ${answer}`}"`),
		});
	});

	it.each(["red, something else entirely", "  red please  "])("multi-select preserves custom input %j verbatim", async answer => {
		const tool = register();
		const input = vi.fn(async () => answer);
		const r = await run(tool, MULTI, ctxRpc({ input }));
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.details).toMatchObject({
			answers: [{ kind: "multi", selected: [], answer }],
		});
		expect(r?.content[0]).toMatchObject({
			text: expect.stringContaining(`"Pick colors?"="${answer}"`),
		});
	});

	it("multi-select empty input commits an empty selection (Next with nothing toggled)", async () => {
		const tool = register();
		const input = vi.fn(async () => "  ");
		const r = await run(tool, MULTI, ctxRpc({ input }));
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Pick colors?"="(no input)"') });
	});

	it("dismiss (select resolves undefined) → decline envelope", async () => {
		const tool = register();
		const select = vi.fn(async () => undefined);
		const r = await run(tool, SINGLE, ctxRpc({ select }));
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("declined") });
	});

	it("walks multiple questions sequentially, one dialog each", async () => {
		const tool = register();
		const params = { questions: [...SINGLE.questions, ...MULTI.questions] };
		const select = vi.fn(async (_t: string, options: string[]) => options[0]); // "1. A — a"
		const input = vi.fn(async () => "2"); // green
		const r = await run(tool, params, ctxRpc({ select, input }));
		expect(select).toHaveBeenCalledOnce();
		expect(input).toHaveBeenCalledOnce();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Pick colors?"="green"') });
	});
});

describe("ask_user_question.execute — RPC single-select replies", () => {
	const answersOf = (r: Awaited<ReturnType<typeof run>>) =>
		(r?.details as { answers: unknown[]; cancelled: boolean } | undefined) ?? { answers: [], cancelled: true };

	it.each([
		["the offered line", "2. B — b", { kind: "option", answer: "B" }],
		["a bare index", "2", { kind: "option", answer: "B" }],
		["an exact option label", "B", { kind: "option", answer: "B" }],
		["free text (#299)", "B but change the title", { kind: "custom", answer: "B but change the title" }],
		["padded free text", "  use foo  ", { kind: "custom", answer: "  use foo  " }],
		["whitespace-only free text", "   ", { kind: "custom", answer: "   " }],
		["an explicitly empty reply", "", { kind: "custom", answer: null }],
		[
			"free text starting with a digit (#299)",
			"2 but change the title",
			{ kind: "custom", answer: "2 but change the title" },
		],
	])("reads %s as the user's answer, never a dismissal", async (_name, reply, expected) => {
		const tool = register();
		const r = await run(tool, SINGLE, ctxRpc({ select: vi.fn(async () => reply) }));
		expect(answersOf(r)).toMatchObject({ cancelled: false, answers: [expected] });
	});

	it("cancelling the 'Type something.' input returns to the options instead of cancelling (#142)", async () => {
		const tool = register();
		const replies = ["3. Type something.", "1. A — a"];
		const select = vi.fn(async (_t: string, options: string[]) =>
			replies.shift() === "1. A — a" ? options[0] : options.at(-1),
		);
		const input = vi.fn(async () => undefined);
		const r = await run(tool, SINGLE, ctxRpc({ select, input }));
		expect(select).toHaveBeenCalledTimes(2);
		expect(input).toHaveBeenCalledOnce();
		expect(answersOf(r)).toMatchObject({ cancelled: false, answers: [{ kind: "option", answer: "A" }] });
	});

	it("keeps earlier answers when a later question's follow-up is cancelled (#142)", async () => {
		const tool = register();
		const params = { questions: [SINGLE.questions[0], { ...SINGLE.questions[0], question: "And?", header: "Next" }] };
		const replies = ["1. A — a", "3. Type something.", "2. B — b"];
		const select = vi.fn(async () => replies.shift());
		const r = await run(tool, params, ctxRpc({ select, input: vi.fn(async () => undefined) }));
		expect(answersOf(r)).toMatchObject({
			cancelled: false,
			answers: [
				{ question: "Which?", answer: "A" },
				{ question: "And?", answer: "B" },
			],
		});
	});

	it("shows the option list in the 'Type something.' input so the user can refer to it (#194)", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options.at(-1));
		const input = vi.fn(async (_title: string) => "neither");
		await run(tool, SINGLE, ctxRpc({ select, input }));
		const title = input.mock.calls[0]?.[0] as string;
		expect(title).toContain("1. A — a");
		expect(title).toContain("2. B — b");
		expect(title).toContain("Type your answer:");
	});
});

describe("ask_user_question.execute — native mode dispatch", () => {
	it("keeps the blocked event active until the RPC dialog reply arrives", async () => {
		const { tool, captured } = registerWithCapture();
		const custom = vi.fn(async () => undefined);
		let reply!: () => void;
		const answer = new Promise<string>((resolve) => { reply = () => resolve("B"); });
		const select = vi.fn(async () => answer);
		const ctx = createMockCtx({
			hasUI: true,
			mode: "rpc",
			ui: { custom: custom as never, select: select as never, input: vi.fn(async () => "") as never } as never,
		});
		const pending = run(tool, SINGLE, ctx);
		try {
			await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
			expect(captured.eventsEmitted.get("rpiv:ask-user:blocked")?.at(-1)).toEqual({ active: true });
		} finally {
			reply();
			await pending;
		}
		const r = await pending;
		expect(captured.eventsEmitted.get("rpiv:ask-user:blocked")?.at(-1)).toEqual({ active: false });
		expect(custom).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledOnce();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="B"') });
	});

	it("uses custom rendering in TUI mode even when select is available", async () => {
		const tool = register();
		const custom = vi.fn(async () => ({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which?", kind: "option", answer: "A" }],
		}));
		const select = vi.fn(async () => "should-not-be-called");
		const ctx = createMockCtx({
			hasUI: true,
			mode: "tui",
			ui: { custom: custom as never, select: select as never } as never,
		});
		const r = await run(tool, SINGLE, ctx);
		expect(custom).toHaveBeenCalledOnce();
		expect(select).not.toHaveBeenCalled();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
	});
});
