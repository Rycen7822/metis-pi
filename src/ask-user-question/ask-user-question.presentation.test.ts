import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";
import { HOST_ALLOCATED_ROWS } from "./presentation.ts";
import type { QuestionnaireSessionComponent } from "./state/questionnaire-session.ts";
import type { QuestionParams, QuestionnaireResult } from "./tool/types.ts";
import { HINT_PART_CANCEL } from "./view/dialog-builder.ts";

type Factory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: QuestionnaireResult) => void,
) => QuestionnaireSessionComponent;
type CustomOptions = { overlay?: boolean; overlayOptions?: unknown };

const DOWN = "\x1b[B";
const ENTER = "\r";
const COLLAPSE = "\x1d"; // ctrl+]

const twoOptions = {
	questions: [
		{
			question: "Where should the dialog appear?",
			header: "Layout",
			options: [{ label: "Inline", description: "" }, { label: "Overlay", description: "" }],
		},
	],
} satisfies QuestionParams;
// Renders 19 rows at width 100 — taller than the inline budget on a 24-row terminal.
const fourDescribedOptions = {
	questions: [
		{
			question: "Which approach should we take for the cache layer?",
			header: "Cache",
			options: [1, 2, 3, 4].map((i) => ({
				label: `Option ${i}`,
				description: `A reasonably long description of option ${i} that explains the trade-off.`,
			})),
		},
	],
} satisfies QuestionParams;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function mount(factory: Factory, rows = 24, done: (r: QuestionnaireResult) => void = () => {}) {
	return factory({ requestRender() {}, terminal: { columns: 100, rows } }, theme, getKeybindings(), done);
}

function setup(custom: (factory: Factory, options?: CustomOptions) => Promise<unknown>, overlayShowing = false) {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	const removeListener = vi.fn();
	const onTerminalInput = vi.fn(() => removeListener);
	const ctx = createMockCtx({ hasUI: true, ui: { custom: vi.fn((factory: Factory, options?: CustomOptions) => {
		if (overlayShowing && !options?.overlay) {
			return new Promise(resolve => factory({ requestRender() {}, terminal: { columns: 100, rows: 24 },
				hasOverlay: () => true }, theme, getKeybindings(), resolve));
		}
		return custom(factory, options);
	}), onTerminalInput } as never });
	const run = (params: object) =>
		captured.tools.get("ask_user_question")!.execute("tc", params as never, undefined, undefined, ctx as never);
	return { run, ctx, onTerminalInput, removeListener };
}

describe("inline presentation", () => {
	it("mounts in the editor slot", async () => {
		const { run, ctx, onTerminalInput } = setup(async () => ({ answers: [], cancelled: true }));
		await run(twoOptions);
		expect(vi.mocked(ctx.ui.custom).mock.calls[0]?.[1]).toEqual({ overlay: false });
		expect(onTerminalInput).not.toHaveBeenCalled();
	});

	it("collapses to a visible row without a raw listener, and still submits", async () => {
		const { run, ctx, onTerminalInput } = setup(async (factory, options) => {
			expect(options).toEqual({ overlay: false });
			let result: QuestionnaireResult | undefined;
			const component = mount(factory, 24, (answer) => {
				result = answer;
			});
			expect(component.render(100).length).toBeGreaterThan(1);
			// No overlay handle to hide: collapse keeps a focused one-row component that re-expands.
			component.handleInput(COLLAPSE);
			expect(component.render(100)).toHaveLength(1);
			component.handleInput(COLLAPSE);
			expect(component.render(100).length).toBeGreaterThan(1);
			component.handleInput(ENTER);
			return result;
		});
		const result = await run(twoOptions);
		expect(ctx.ui.custom).toHaveBeenCalledOnce();
		expect(result.details).toMatchObject({ cancelled: false, answers: [{ kind: "option", answer: "Inline" }] });
		expect(onTerminalInput).not.toHaveBeenCalled();
	});

	it("caps the dialog to the inline row budget and keeps the footer and focused option visible", async () => {
		const rows = 24;
		const budget = 16; // 70% of 24 — pinned literally so a budget regression cannot move the goalposts
		const { run } = setup(async (factory) => {
			const component = mount(factory, rows);
			for (const pressDown of [false, true, true, true]) {
				if (pressDown) component.handleInput(DOWN);
				const lines = component.render(100);
				expect(lines.length).toBeLessThanOrEqual(budget);
				// The host clips the editor slot from the bottom, so the hint row must be last.
				expect(lines.at(-1)).toContain(HINT_PART_CANCEL);
				// The question being answered stays pinned while the options scroll.
				expect(lines.some((line) => line.includes("Which approach should we take"))).toBe(true);
			}
			expect(component.render(100).some((line) => line.includes("Option 4"))).toBe(true);
			return { answers: [], cancelled: true };
		});
		await run(fourDescribedOptions);
	});

	it.each([
		{ cols: 120, rows: 24, layout: "side-by-side", described: false },
		{ cols: 90, rows: 30, layout: "stacked", described: true },
	])(
		"fits a long preview into the inline budget as a closed box ($layout, $cols×$rows) — #210",
		async ({ cols, rows, described }) => {
			initTheme(); // markdown preview rendering reads Pi's theme
			const code = (tag: string) =>
				`\`\`\`\n${Array.from({ length: 40 }, (_, i) => `${tag}${i + 1}`).join("\n")}\n\`\`\``;
			const withPreviews = {
				questions: [
					{
						question: "Apply which patch to the pricing cache?",
						header: "Patch",
						options: [1, 2, 3, 4].slice(0, described ? 4 : 2).map((i) => ({
							label: `Patch ${i}`,
							description: described ? `Trade-off summary for patch ${i}, one sentence long.` : "",
							preview: code(`L${i}_`),
						})),
					},
				],
			};
			const { run } = setup(async (factory) => {
				const lines = factory(
					{ requestRender() {}, terminal: { columns: cols, rows } },
					theme,
					getKeybindings(),
					() => {},
				)
					.render(cols)
					.map((l) => l.replace(/\x1b\[[0-9;:]*m/g, ""));
				expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.7));
				expect(lines.some((l) => l.includes("Apply which patch"))).toBe(true);
				expect(lines.some((l) => l.includes("L1_1"))).toBe(true); // the focused option's preview is in view
				expect(lines.some((l) => l.includes("┌"))).toBe(true);
				expect(lines.some((l) => l.includes("└") && l.includes("lines hidden"))).toBe(true);
				expect(lines.at(-1)).toContain(HINT_PART_CANCEL);
				return { answers: [], cancelled: true };
			});
			await run(withPreviews);
		},
	);

	it("uses a host's whole allocated band instead of capping it again", async () => {
		// rpiv-pi's lane console reports its band as terminal.rows and marks it allocated.
		const { run } = setup(async (factory) => {
			const tui = { requestRender() {}, terminal: { columns: 100, rows: 19, [HOST_ALLOCATED_ROWS]: true } };
			const lines = factory(tui, theme, getKeybindings(), () => {}).render(100);
			expect(lines.length).toBe(19); // natural height 19; the 70% inline cap would be 13
			expect(lines.some((line) => line.includes("Option 4"))).toBe(true);
			return { answers: [], cancelled: true };
		});
		await run(fourDescribedOptions);
	});

	it("leaves the fallback overlay at its natural height for the same questionnaire", async () => {
		const { run } = setup(async (factory, options) => {
			expect(options?.overlay).toBe(true);
			const lines = mount(factory, 24).render(100);
			expect(lines.length).toBeGreaterThan(16);
			expect(lines.length).toBeLessThanOrEqual(24);
			return { answers: [], cancelled: true };
		}, true);
		await run(fourDescribedOptions);
	});

	it("stacks as an overlay instead when another overlay (e.g. /btw) is already on screen", async () => {
		const calls: Array<CustomOptions | undefined> = [];
		let overlayShowing = true;
		const { run, onTerminalInput } = setup(
			(factory, options) =>
				new Promise((resolve) => {
					calls.push(options);
					const tui = {
						requestRender() {},
						terminal: { columns: 100, rows: 24 },
						hasOverlay: () => overlayShowing,
					};
					const component = factory(tui, theme, getKeybindings(), resolve);
					if (options?.overlay) {
						expect(component.render(100).length).toBeGreaterThan(1);
						component.handleInput(ENTER);
					} else {
						// A yielding factory has already resolved; otherwise settle the inline mount.
						resolve({ answers: [], cancelled: true });
					}
				}),
		);
		const result = await run(twoOptions);
		expect(calls.map((o) => o?.overlay)).toEqual([false, true]);
		expect(calls[1]).toMatchObject({ overlayOptions: { anchor: "bottom-center" } });
		expect(onTerminalInput).toHaveBeenCalledTimes(1);
		expect(result.details).toMatchObject({ cancelled: false, answers: [{ kind: "option", answer: "Inline" }] });

		// With no overlay on screen, the next question stays inline.
		overlayShowing = false;
		await run(twoOptions);
		expect(calls[2]?.overlay).toBe(false);
	});


});

describe("overlay fallback", () => {
	it.each([false, true])("safely collapses a fallback overlay with an existing overlay=%s", async existingOverlay => {
		const { run, ctx, onTerminalInput, removeListener } = setup(factory => new Promise(resolve => {
			const component = factory({
				requestRender() {}, terminal: { columns: 100, rows: 24 }, hasOverlay: () => existingOverlay,
			}, theme, getKeybindings(), resolve);
			component.handleInput(COLLAPSE);
			expect(component.render(100)).toHaveLength(1);
			component.handleInput(COLLAPSE);
			component.handleInput(ENTER);
		}), true);
		await run(twoOptions);
		expect(vi.mocked(ctx.ui.custom).mock.calls[1]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "bottom-center", maxHeight: "100%" },
		});
		expect(onTerminalInput).toHaveBeenCalledTimes(1);
		expect(removeListener).toHaveBeenCalledTimes(1);
	});
});
