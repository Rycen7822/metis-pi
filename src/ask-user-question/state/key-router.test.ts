import { describe, expect, it } from "vitest";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionData } from "../tool/types.ts";
import type { QuestionRow } from "./row-intent.ts";
import { routeKey, wrapTab } from "./key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.ts";
import { makeQuestionnaireState as makeState } from "../test-fixtures.ts";

const KEY = {
	UP: "tui.select.up",
	DOWN: "tui.select.down",
	CONFIRM: "tui.select.confirm",
	SUBMIT: "tui.input.submit",
	CANCEL: "tui.select.cancel",
	NEW_LINE: "tui.input.newLine",
	EDITOR_UP: "tui.editor.cursorUp",
	EDITOR_DOWN: "tui.editor.cursorDown",
	CLEAR: "tui.editor.deleteToLineStart",
	EXTERNAL_EDITOR: "app.editor.external",
};
const sentinel = (name: string) => `<KEY:${name}>`;
const keybindings = { matches: (data: string, name: string) => data === sentinel(name) };

const BYTE_TAB = "\t";
const BYTE_SHIFT_TAB = "\x1b[Z";
const BYTE_RIGHT = "\x1b[C";
const BYTE_LEFT = "\x1b[D";
const BYTE_SPACE = " ";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "H",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
			{ label: "C", description: "c" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeRuntime(over: Partial<QuestionnaireRuntime> = {}): QuestionnaireRuntime {
	const questions = over.questions ?? [makeQuestion(), makeQuestion()];
	const items: QuestionRow[] = over.items
		? [...over.items]
		: questions[0]!.options.map((o) => ({ kind: "option" as const, label: o.label }));
	return {
		keybindings,
		inputBuffer: "",
		notesBuffer: "",
		canMoveInputUp: false,
		canMoveInputDown: false,
		questions,
		isMulti: questions.length > 1,
		currentItem: items[0],
		items,
		collapseKey: "ctrl+]",
		...over,
	};
}

describe("wrapTab", () => {
	it("wraps negative + over-max into [0, total)", () => {
		expect(wrapTab(-1, 3)).toBe(2);
		expect(wrapTab(3, 3)).toBe(0);
		expect(wrapTab(0, 0)).toBe(0);
	});

});

describe("routeKey — nav", () => {
	it("UP from a non-zero index decrements by 1", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 1,
			inputValue: "",
		});
	});
	it("DOWN advances by 1", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState(), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 1,
			inputValue: "",
		});
	});
	// With the chat row gone, UP/DOWN wrap within [option0 … optionLast] via wrapTab.
	// DOWN at the last item wraps to 0; UP at the first item wraps to the last.
	it("DOWN at the last item wraps to 0 (no chat row, wrapTab clamp)", () => {
		// makeRuntime default items length === 3 (questions[0].options)
		expect(routeKey(sentinel(KEY.DOWN), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 0,
			inputValue: "",
		});
	});
	it("UP at the first item wraps to the last (no chat row, wrapTab clamp)", () => {
		const runtime = makeRuntime();
		const last = runtime.items.length - 1;
		expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 0 }), runtime)).toEqual({
			kind: "nav",
			nextIndex: last,
			inputValue: "",
		});
	});
});

describe("routeKey — tab_switch", () => {
	it("Tab cycles forward through total tabs (questions + Submit)", () => {
		expect(routeKey(BYTE_TAB, makeState(), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 1,
		});
	});

	it("Right is an alias for Tab", () => {
		expect(routeKey(BYTE_RIGHT, makeState(), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 1,
		});
	});

	it("Shift+Tab wraps backward from tab 0 to the Submit tab", () => {
		expect(routeKey(BYTE_SHIFT_TAB, makeState({ currentTab: 0 }), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 2,
		});
	});

	it("Left is an alias for Shift+Tab", () => {
		expect(routeKey(BYTE_LEFT, makeState({ currentTab: 1 }), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 0,
		});
	});

	it("Tab is a no-op (returns ignore) in single-question mode", () => {
		expect(routeKey(BYTE_TAB, makeState(), makeRuntime({ isMulti: false, questions: [makeQuestion()] }))).toEqual({
			kind: "ignore",
		});
	});
});

describe("routeKey — confirm (single-select)", () => {
	it("emits confirm with input intent on the first question", () => {
		const action = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 0 }), makeRuntime());
		expect(action).toMatchObject({ kind: "confirm", value: "" });
	});

	it("a key matching only tui.input.submit confirms (second confirm source)", () => {
		const action = routeKey(sentinel(KEY.SUBMIT), makeState({ currentTab: 0 }), makeRuntime());
		expect(action).toMatchObject({ kind: "confirm", value: "" });
	});

	it("inline-input mode: Enter confirms with the buffered text", () => {
		const other: QuestionRow = { kind: "other", label: "Type something." };
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ inputMode: true }),
			makeRuntime({ currentItem: other, inputBuffer: "my custom answer" }),
		);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.value).toBe("my custom answer");
		}
	});
});

describe("routeKey — multiSelect", () => {
	const multiQ = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "FE" },
			{ label: "BE", description: "BE" },
			{ label: "Tests", description: "T" },
		],
	});

	it.each([
		[BYTE_SPACE, true], ["\x1b[32u", true], ["\x1b[32;1:1u", true],
		["\x1b[32;1:2u", false], ["\x1b[32;1:3u", false],
	] as const)("Space %j toggles only on a press (%s)", (data, pressed) => {
		expect(
			routeKey(
				data,
				makeState({ optionIndex: 1 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
					],
					currentItem: { kind: "option", label: "BE" },
				}),
			),
		).toEqual(pressed ? { kind: "toggle", index: 1 } : { kind: "ignore" });
	});

	// Spec: Enter on a REGULAR option row toggles that row's checkbox (matches Space). Committing
	// + advancing requires explicit focus on the Next sentinel — see the confirmation tests below.
	it.each([
		[sentinel(KEY.CONFIRM), true], ["\r", true], ["\x1b[13;1:1u", true],
		["\x1b[13;1:2u", false], ["\x1b[13;1:3u", false],
	] as const)("Enter %j toggles the current option only on a press (%s)", (data, pressed) => {
		expect(
			routeKey(
				data,
				makeState({ optionIndex: 1 }),
				makeRuntime({
					keybindings: { matches: (key, name) => keybindings.matches(key, name)
						|| (name === KEY.CONFIRM && matchesKey(key, Key.enter)) },
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "option", label: "BE" },
				}),
			),
		).toEqual(pressed ? { kind: "toggle", index: 1 } : { kind: "ignore" });
	});

	// Spec: Space on the Next sentinel is ignored — Next is not a real option.
	it("Space on Next sentinel is ignored", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 3 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "next", label: "Next" },
				}),
			),
		).toEqual({ kind: "ignore" });
	});

	it("Enter on Next carries the current custom text", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 3 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					inputBuffer: "custom detail",
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "next", label: "Next" },
				}),
			),
		).toEqual({ kind: "confirm", value: "custom detail" });
	});

	it("Space does NOT emit toggle on a single-select question", () => {
		expect(routeKey(BYTE_SPACE, makeState(), makeRuntime())).toEqual({ kind: "ignore" });
	});
});

describe("routeKey — multiSelect free-text ('Type something.')", () => {
	const multiQ = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "FE" },
			{ label: "BE", description: "BE" },
			{ label: "Tests", description: "T" },
		],
	});
	// Post-Phase-2 items: 3 options + other + next.
	const items: QuestionRow[] = [
		{ kind: "option", label: "FE" },
		{ kind: "option", label: "BE" },
		{ kind: "option", label: "Tests" },
		{ kind: "other", label: "Type something." },
		{ kind: "next", label: "Next" },
	];

	it("Enter on the custom row forwards its text as confirmation intent", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ optionIndex: 3, inputMode: true }),
			makeRuntime({
				questions: [multiQ],
				isMulti: false,
				items,
				currentItem: items[3],
				inputBuffer: "typed answer",
			}),
		);
		expect(action).toMatchObject({ kind: "confirm", value: "typed answer" });
	});

	it("Space on the 'Type something.' row (defensive, !inputMode) → ignore (no phantom toggle)", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "ignore" });
	});

	it("Enter on the 'Type something.' row (defensive, !inputMode) → ignore (no toggle/confirmation)", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "ignore" });
	});

	it("DOWN from last option (index 2) → nav to the other row (index 3)", () => {
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ optionIndex: 2 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[2] }),
			),
		).toEqual({ kind: "nav", nextIndex: 3, inputValue: "" });
	});

	it("DOWN from the other row (index 3) → nav to Next (index 4)", () => {
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "nav", nextIndex: 4, inputValue: "" });
	});

	it("UP from Next (index 4) → nav back to the other row (index 3)", () => {
		expect(
			routeKey(
				sentinel(KEY.UP),
				makeState({ optionIndex: 4 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[4] }),
			),
		).toEqual({ kind: "nav", nextIndex: 3, inputValue: "" });
	});
});

describe("routeKey — cancel + submit", () => {
	it("Esc cancels the entire questionnaire from any tab", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState(), makeRuntime())).toEqual({ kind: "cancel" });
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ currentTab: 2 }), makeRuntime())).toEqual({
			kind: "cancel",
		});
	});

	// D1 revised: partial submission allowed. Enter on Submit row always submits.
	it("Enter on Submit accepts partial submission", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ currentTab: 2, submitChoiceIndex: 0 }),
				makeRuntime(),
			),
		).toEqual({ kind: "submit" });
	});

	it("Submit tab + DOWN -> submit_nav nextIndex=1", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2, submitChoiceIndex: 0 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 1,
		});
	});

	it("Submit tab + UP wraps from 0 to 1", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ currentTab: 2, submitChoiceIndex: 0 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 1,
		});
	});

	it("Submit tab + DOWN from index 1 wraps to 0", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2, submitChoiceIndex: 1 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 0,
		});
	});

	it("Enter on Cancel cancels partial submission", () => {
		expect(
			routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 2, submitChoiceIndex: 1 }), makeRuntime()),
		).toEqual({ kind: "cancel" });
	});
});

describe("routeKey — notes", () => {
	it.each([
		["n", true], ["\x1b[110u", true], ["\x1b[110;1:1u", true],
		["\x1b[110;1:2u", false], ["\x1b[110;1:3u", false],
	] as const)("notes shortcut %j opens question and global notes only on a press (%s)", (data, pressed) => {
		for (const currentTab of [0, 2]) {
			expect(routeKey(data, makeState({ currentTab }), makeRuntime())).toEqual({
				kind: pressed ? "notes_enter" : "ignore",
			});
		}
	});

	it("'n' emits notes_enter on multiSelect questions even with preview (universal gate)", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		expect(routeKey("n", makeState(), makeRuntime({ questions: [multiQ, makeQuestion()] }))).toEqual({
			kind: "notes_enter",
		});
	});

	// goal §7 / FR-3: the universal gate is row-agnostic and sits ABOVE the
	// multi-select toggle block, so `n` reaches notes_enter even when the Next
	// sentinel row is focused. The Next sentinel does not activate inputMode (only
	// the "Type something." other row does, per the row kind), so `n` is neither
	// swallowed by an earlier block nor blocked by `blocksMultiToggle`.
	it("'n' emits notes_enter when the multi-select Next sentinel row is focused", () => {
		const multiQ = makeQuestion({
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
				{ label: "Tests", description: "T" },
			],
		});
		const items: QuestionRow[] = [
			{ kind: "option", label: "FE" },
			{ kind: "option", label: "BE" },
			{ kind: "option", label: "Tests" },
			{ kind: "next", label: "Next" },
		];
		expect(
			routeKey(
				"n",
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "notes_enter" });
	});

	it("notesMode: Esc -> notes_exit", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ notesVisible: true }), makeRuntime())).toEqual({ kind: "notes_exit", value: "" });
	});

	it("notesMode: Enter -> notes_exit (save + return to options)", () => {
		expect(routeKey(sentinel(KEY.CONFIRM), makeState({ notesVisible: true }), makeRuntime())).toEqual({ kind: "notes_exit", value: "" });
	});

	it("notesMode: Tab byte emits notes_forward (any non-Esc/Enter key forwards to the Input)", () => {
		expect(routeKey(BYTE_TAB, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data: BYTE_TAB,
		});
	});

	it("notesMode: arbitrary printable byte emits notes_forward (single dispatch path)", () => {
		expect(routeKey("a", makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data: "a",
		});
	});

	it("notesMode: configured newline is forwarded instead of closing the editor", () => {
		const data = sentinel(KEY.NEW_LINE);
		expect(routeKey(data, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data,
		});
	});
});

describe("routeKey — global note on the Submit tab", () => {
	// The Submit tab lives at the pseudo-index currentTab === questions.length (2 for the
	// default two-question runtime). #182: `n` there opens the notes editor scoped to the
	// whole questionnaire instead of a single question.
	const submitTab = (over: Partial<QuestionnaireState> = {}) =>
		makeState({ currentTab: 2, notesVisible: false, ...over });

	it("'n' with the editor closed emits notes_enter at the pseudo-index", () => {
		expect(routeKey("n", submitTab(), makeRuntime())).toEqual({ kind: "notes_enter" });
	});

	it("while open, the Tab byte forwards to the notes editor — NOT tab_switch", () => {
		expect(routeKey(BYTE_TAB, submitTab({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data: BYTE_TAB,
		});
	});

	it("while open, Esc commits the note (notes_exit)", () => {
		expect(routeKey(sentinel(KEY.CANCEL), submitTab({ notesVisible: true }), makeRuntime())).toEqual({ kind: "notes_exit", value: "" });
	});

	it("while open, Enter commits the note (notes_exit) — it does NOT submit", () => {
		expect(routeKey(sentinel(KEY.CONFIRM), submitTab({ notesVisible: true }), makeRuntime())).toEqual({ kind: "notes_exit", value: "" });
	});

	it("with the editor closed, Enter still submits/cancels per submitChoiceIndex (the n branch shadows nothing)", () => {
		// D1-revised Enter-submit preserved: the notes branch sits AFTER the confirm branch
		// inside routeSubmitTab, so Enter keeps its submit/cancel meaning on the Submit tab.
		expect(routeKey(sentinel(KEY.CONFIRM), submitTab({ submitChoiceIndex: 0 }), makeRuntime())).toEqual({
			kind: "submit",
		});
		expect(routeKey(sentinel(KEY.CONFIRM), submitTab({ submitChoiceIndex: 1 }), makeRuntime())).toEqual({
			kind: "cancel",
		});
	});
});

describe("routeKey — inputMode (Type something)", () => {
	const other: QuestionRow = { kind: "other", label: "Type something." };

	it("Tab byte is ignored under inputMode", () => {
		expect(routeKey(BYTE_TAB, makeState({ inputMode: true }), makeRuntime({ currentItem: other }))).toEqual({ kind: "input_forward", data: BYTE_TAB });
	});

	it("printable bytes return an explicit editor forwarding action", () => {
		expect(routeKey("x", makeState({ inputMode: true }), makeRuntime({ currentItem: other }))).toEqual({ kind: "input_forward", data: "x" });
	});

	it("configured newline is forwarded to the multiline editor", () => {
		expect(
			routeKey(sentinel(KEY.NEW_LINE), makeState({ inputMode: true }), makeRuntime({ currentItem: other })),
		).toEqual({ kind: "input_forward", data: sentinel(KEY.NEW_LINE) });
	});

	it("forwards vertical editor movement while the cursor is between logical lines", () => {
		const editing = makeState({ inputMode: true, optionIndex: 1 });
		expect(
			routeKey(
				sentinel(KEY.EDITOR_UP),
				editing,
				makeRuntime({ currentItem: other, canMoveInputUp: true, canMoveInputDown: true }),
			),
		).toEqual({ kind: "input_forward", data: sentinel(KEY.EDITOR_UP) });
		expect(
			routeKey(
				sentinel(KEY.EDITOR_DOWN),
				editing,
				makeRuntime({ currentItem: other, canMoveInputUp: true, canMoveInputDown: true }),
			),
		).toEqual({ kind: "input_forward", data: sentinel(KEY.EDITOR_DOWN) });
	});

	// FR-3: the inputMode block intercepts BEFORE the universal notes gate, so `n`
	// inserts a literal character into the inline buffer instead of opening notes.
	it("'n' under inputMode forwards a literal 'n', NOT notes_enter", () => {
		expect(routeKey("n", makeState({ inputMode: true }), makeRuntime({ currentItem: other }))).toEqual({ kind: "input_forward", data: "n" });
	});

	it("Pi's Ctrl+U line-kill binding clears the whole custom answer", () => {
		expect(
			routeKey(sentinel(KEY.CLEAR), makeState({ inputMode: true }), makeRuntime({ currentItem: other })),
		).toEqual({ kind: "input_clear" });
	});

	it("the app.editor.external binding opens the editor with the current draft", () => {
		expect(
			routeKey(
				sentinel(KEY.EXTERNAL_EDITOR),
				makeState({ inputMode: true }),
				makeRuntime({ currentItem: other, inputBuffer: "draft" }),
			),
		).toEqual({ kind: "input_edit", value: "draft" });
	});

	it("Esc cancels the questionnaire even in inputMode", () => {
		expect(
			routeKey(sentinel(KEY.CANCEL), makeState({ inputMode: true }), makeRuntime({ currentItem: other })),
		).toEqual({ kind: "cancel" });
	});
});

describe("routeKey — remapped submit key as the confirm source (#156)", () => {
	// Models a Slack/Discord-style ~/.pi/agent/keybindings.json:
	//   { "tui.input.submit": ["ctrl+enter"], "tui.input.newLine": ["enter", ...] }
	// `tui.select.confirm` keeps its default `enter`, so `enter` matches BOTH the
	// user's newline override and confirm. The newline checks win that collision by
	// design; the remapped submit key must therefore act as confirm everywhere, or
	// notes and custom answers become impossible to commit.
	const REMAPPED_ENTER = "<REMAPPED:ENTER>";
	const REMAPPED_CTRL_ENTER = "<REMAPPED:CTRL_ENTER>";
	const remapped = {
		matches(data: string, name: string): boolean {
			switch (name) {
				case KEY.SUBMIT:
					return data === REMAPPED_CTRL_ENTER;
				case KEY.NEW_LINE:
					return data === REMAPPED_ENTER;
				case KEY.CONFIRM:
					// Default binding — the user's config does not touch tui.select.confirm.
					return data === REMAPPED_ENTER;
				default:
					return false;
			}
		},
	};
	const other: QuestionRow = { kind: "other", label: "Type something." };

	it("inputMode: Enter is consumed as a newline (collision resolves to newline)", () => {
		expect(
			routeKey(
				REMAPPED_ENTER,
				makeState({ inputMode: true }),
				makeRuntime({ keybindings: remapped, currentItem: other }),
			),
		).toEqual({ kind: "input_forward", data: REMAPPED_ENTER });
	});

	it("inputMode: the submit key confirms with the buffered text instead of falling through to the editor", () => {
		const action = routeKey(
			REMAPPED_CTRL_ENTER,
			makeState({ inputMode: true }),
			makeRuntime({ keybindings: remapped, currentItem: other, inputBuffer: "typed answer" }),
		);
		expect(action).toMatchObject({ kind: "confirm", value: "typed answer" });
	});

	it("notes: Enter forwards as a newline; the submit key exits the notes editor", () => {
		expect(
			routeKey(REMAPPED_ENTER, makeState({ notesVisible: true }), makeRuntime({ keybindings: remapped })),
		).toEqual({ kind: "notes_forward", data: REMAPPED_ENTER });
		// Regression: before #156 this fell through to notes_forward, reaching the
		// headless editor's own tui.input.submit handling and wiping the notes draft.
		expect(
			routeKey(REMAPPED_CTRL_ENTER, makeState({ notesVisible: true }), makeRuntime({ keybindings: remapped })),
		).toEqual({ kind: "notes_exit", value: "" });
	});

	it("single-select option row: the submit key confirms", () => {
		expect(
			routeKey(REMAPPED_CTRL_ENTER, makeState({ currentTab: 0 }), makeRuntime({ keybindings: remapped })),
		).toMatchObject({ kind: "confirm", value: "" });
	});

	it("Submit tab: the submit key submits the questionnaire", () => {
		expect(
			routeKey(
				REMAPPED_CTRL_ENTER,
				makeState({ currentTab: 2, submitChoiceIndex: 0 }),
				makeRuntime({ keybindings: remapped }),
			),
		).toEqual({ kind: "submit" });
	});

	it("multi-select: the submit key toggles a regular row and commits on the Next sentinel (matches Enter)", () => {
		const multiQ = makeQuestion({
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
			],
		});
		const items: QuestionRow[] = [
			{ kind: "option", label: "FE" },
			{ kind: "option", label: "BE" },
			{ kind: "next", label: "Next" },
		];
		expect(
			routeKey(
				REMAPPED_CTRL_ENTER,
				makeState({ optionIndex: 1 }),
				makeRuntime({ keybindings: remapped, questions: [multiQ], isMulti: false, items, currentItem: items[1] }),
			),
		).toEqual({ kind: "toggle", index: 1 });
		expect(
			routeKey(
				REMAPPED_CTRL_ENTER,
				makeState({ optionIndex: 2 }),
				makeRuntime({ keybindings: remapped, questions: [multiQ], isMulti: false, items, currentItem: items[2] }),
			),
		).toEqual({ kind: "confirm", value: "" });
	});
});

describe("routeKey — collapse/expand (Ctrl+] toggle + collapsed-mode lockout)", () => {
	// Raw control byte for Ctrl+] (GS, 0x1d). matchesKey recognises this directly on
	// every terminal that delivers raw control bytes in TUI mode — macOS Terminal.app,
	// iTerm2, Warp, Ghostty, tmux, zellij. The legacy telnet/ssh escape role does NOT
	// apply because the questionnaire runs in-process.
	const BYTE_CTRL_RBRACKET = "\x1d";

	it.each([[1, "toggle_collapsed"], [2, "ignore"], [3, "ignore"]] as const)(
		"routes Kitty Ctrl+] event %i as %s", (event, kind) => {
			expect(routeKey(`\x1b[93;5:${event}u`, makeState(), makeRuntime())).toEqual({ kind });
		},
	);

	it("Ctrl+] emits toggle_collapsed from the default question state", () => {
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), makeRuntime())).toEqual({ kind: "toggle_collapsed" });
	});

	it("Ctrl+] emits toggle_collapsed even while notesVisible (the notes branch never sees the key)", () => {
		// Notes mode normally forwards every keystroke to the notes input via `notes_forward`.
		// The collapse intercept sits ABOVE all state branches so the user can shrink the
		// dialog to read the transcript mid-notes-edit without dirtying the draft.
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "toggle_collapsed",
		});
	});

	it("Ctrl+] emits toggle_collapsed even when already collapsed (expand round-trip)", () => {
		// Symmetric: pressing Ctrl+] a second time returns to the full questionnaire.
		// The reducer flips the boolean; the router stays oblivious to which way we're going.
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ collapsed: true }), makeRuntime())).toEqual({
			kind: "toggle_collapsed",
		});
	});

	it("while collapsed, Esc maps to cancel (the documented escape hatch in the one-line footer)", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "cancel" });
	});

	it("while collapsed, navigation keys are swallowed as ignore (no state mutation behind the one-line footer)", () => {
		// Arrow keys would otherwise navigate options; collapsed mode is a read-the-
		// transcript pause, so non-cancel keys must not advance any focus.
		expect(routeKey(sentinel(KEY.UP), makeState({ collapsed: true, optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(routeKey(sentinel(KEY.DOWN), makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "ignore" });
		expect(routeKey(sentinel(KEY.CONFIRM), makeState({ collapsed: true }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(routeKey(BYTE_TAB, makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "ignore" });
	});

	it("while collapsed, the notes-forward and toggle branches are unreachable (lockout precedes them)", () => {
		// Regression guard: without the lockout, a collapsed + notesVisible state would forward
		// keystrokes into the notes input, and a collapsed + multiSelect state would let Space
		// flip checkboxes. Both paths must be dead-ended at the collapsed branch.
		expect(routeKey("x", makeState({ collapsed: true, notesVisible: true }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ collapsed: true }),
				makeRuntime({ questions: [makeQuestion({ multiSelect: true })] }),
			),
		).toEqual({ kind: "ignore" });
	});

	it("uses the runtime's collapseKey for the toggle (default `ctrl+]`, configurable for non-US layouts)", () => {
		// Latin American keyboards, Dvorak, and several European layouts put `]` on a
		// shifted layer. Users override via the `collapseKey` config field; the router
		// matches whatever spec the runtime carries, not a hardcoded literal. Note that
		// on legacy terminals (no Kitty keyboard protocol), `Ctrl+]` and `Ctrl+}` both
		// send the same 0x1D control byte and are not distinguishable by the parser
		// alone — users on such terminals should pick a key whose spec resolves
		// unambiguously (e.g. `alt+o`, `ctrl+shift+h`).
		const BYTE_ALT_O = "\x1bo"; // ESC + 'o' — legacy encoding for Alt+O
		expect(routeKey(BYTE_ALT_O, makeState(), makeRuntime({ collapseKey: "alt+o" }))).toEqual({
			kind: "toggle_collapsed",
		});
		// When the override is `alt+o`, sending the Ctrl+] byte should NOT match
		expect(routeKey("\x1d", makeState(), makeRuntime({ collapseKey: "alt+o" }))).toEqual({ kind: "ignore" });
	});
	it("`collapseKey: 'off'` disables the toggle entirely (the key is never matched)", () => {
		// Disable the collapse shortcut via config: the key router must not emit
		// toggle_collapsed for any key. With the toggle disabled, Ctrl+] falls through
		// to the normal state branches (no-op here, but the same flow as any other
		// non-handled key).
		const runtime = makeRuntime({ collapseKey: "off" });
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), runtime)).not.toEqual({ kind: "toggle_collapsed" });
	});

	it("treats a missing collapseKey as disabled instead of throwing after an in-process package update", () => {
		// A Pi process can retain the pre-collapse outer module while a package update
		// replaces the lazily imported QuestionnaireSession graph on disk. The old
		// constructor call has no collapseKey field, so runtime receives undefined at
		// runtime despite the TypeScript contract. Never pass that value to matchesKey:
		// pi-tui's parseKeyId calls toLowerCase() and would terminate the whole process.
		const runtime = makeRuntime() as unknown as { collapseKey?: string };
		delete runtime.collapseKey;

		expect(() => routeKey(BYTE_CTRL_RBRACKET, makeState(), runtime as QuestionnaireRuntime)).not.toThrow();
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), runtime as QuestionnaireRuntime)).toEqual({ kind: "ignore" });
	});
});
