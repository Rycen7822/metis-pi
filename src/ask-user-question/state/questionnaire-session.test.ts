import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { buildQuestionnaireResponse } from "../tool/response-envelope.ts";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.ts";
import type { QuestionRow } from "./row-intent.ts";
import { QuestionnaireSession } from "./questionnaire-session.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const SHIFT_ENTER = "\x1b\r";
const TAB = "\t";

const params: QuestionParams = {
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
};

function itemsFor(value: QuestionParams): QuestionRow[][] {
	return value.questions.map((question) => [
		...question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
		})),
		{ kind: "other" as const, label: "Type something." },
	]);
}

const keybindings = {
	matches(data: string, name: string): boolean {
		switch (name) {
			case "tui.select.up":
				return data === UP;
			case "tui.select.down":
				return data === DOWN;
			case "tui.select.confirm":
				return data === ENTER;
			case "tui.input.newLine":
				return data === SHIFT_ENTER;
			case "tui.editor.cursorUp":
				return data === UP;
			case "tui.editor.cursorDown":
				return data === DOWN;
			case "tui.select.cancel":
				return data === ESC;
			case "tui.editor.deleteToLineStart":
				return data === CTRL_U;
			case "app.editor.external":
				return data === CTRL_G;
			default:
				return false;
		}
	},
};

interface SessionTestOptions {
	params?: QuestionParams;
	itemsByTab?: QuestionRow[][];
	editInput?: (value: string, signal: AbortSignal) => Promise<string | undefined>;
	keybindings?: typeof keybindings;
	collapseKey?: string;
	rows?: number;
}

function makeSession(options: SessionTestOptions = {}) {
	const sessionParams = options.params ?? params;
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const tui = { terminal: { columns: 120, rows: options.rows ?? 40 }, requestRender: vi.fn() };
	const session = new QuestionnaireSession({
		tui: tui as unknown as TUI,
		theme: makeTheme() as unknown as Theme,
		params: sessionParams,
		itemsByTab: options.itemsByTab ?? itemsFor(sessionParams),
		done,
		keybindings: options.keybindings ?? keybindings,
		editInput: options.editInput ?? (async () => undefined),
		collapseKey: options.collapseKey ?? "off",
		canReopenWhileHidden: false,
		rowBudget: (rows) => rows,
	});
	return { session, done, tui };
}

function focusCustomAnswer(session: QuestionnaireSession): void {
	session.dispatch(DOWN);
	session.dispatch(DOWN);
}

it.each([false, true])("does not apply held Enter to the next question or Submit (custom=%s)", custom => {
	const { session, done } = makeSession({
		params: { questions: [params.questions[0], { ...params.questions[0], question: "Second?", header: "Second" }] },
		keybindings: { matches: (data, name) => keybindings.matches(data, name)
			|| (name === "tui.select.confirm" && matchesKey(data, Key.enter)) },
	});
	if (custom) {
		focusCustomAnswer(session);
		session.dispatch("draft");
	}
	const press = "\x1b[13;1:1u";
	const repeatAndRelease = () => {
		session.dispatch("\x1b[13;1:2u");
		session.dispatch("\x1b[13;1:3u");
	};
	session.dispatch(press);
	repeatAndRelease();
	expect(done).not.toHaveBeenCalled();
	session.dispatch(DOWN);
	session.dispatch(press);
	session.dispatch("n");
	session.dispatch("global note");
	session.dispatch(press);
	repeatAndRelease();
	expect(done).not.toHaveBeenCalled();
	session.dispatch(press);
	expect(done).toHaveBeenCalledWith(expect.objectContaining({
		cancelled: false,
		answers: [
			expect.objectContaining({ kind: custom ? "custom" : "option", answer: custom ? "draft" : "A" }),
			expect.objectContaining({ kind: "option", answer: "B" }),
		],
	}));
});

it.each([18, 11])("reaches every review row and the global note within %i terminal rows", rows => {
	const { session, done } = makeSession({
		rows,
		params: { questions: [params.questions[0], { ...params.questions[0], question: "Second?", header: "Second" }] },
	});
	const markers = Array.from({ length: 20 }, (_, i) => `ROW_${String(i).padStart(2, "0")}`);
	focusCustomAnswer(session);
	session.dispatch(markers.join("\n"));
	session.dispatch(ENTER);
	session.dispatch(ENTER);
	session.component.render(42);
	session.dispatch("n");
	session.dispatch("END_OF_NOTE");
	const editing = session.component.render(42);
	const notesCaretVisible = editing.some(line => line.includes(CURSOR_MARKER));
	session.dispatch(ENTER);
	const first = session.component.render(42).join("\n");
	const seen = new Set<string>();
	for (let page = 0; page < 40; page++) {
		const lines = session.component.render(42);
		expect(lines.length).toBeLessThanOrEqual(rows);
		for (const marker of [...markers, "END_OF_NOTE"]) {
			if (lines.some(line => line.includes(marker))) seen.add(marker);
		}
		session.dispatch(page === 0 ? "\x1b[6~" : "\x1b[6;1:2~");
	}
	expect([...markers, "END_OF_NOTE"].every(marker => seen.has(marker))).toBe(true);
	expect(notesCaretVisible).toBe(true);
	const bottom = session.component.render(42).join("\n");
	session.dispatch("\x1b[5~");
	expect(session.component.render(42).join("\n")).not.toBe(bottom);
	session.dispatch("\x1b[Z");
	session.dispatch("\t");
	expect(session.component.render(42).join("\n")).toBe(first);
	expect(done).not.toHaveBeenCalled();
	session.dispatch(ENTER);
	expect(done).toHaveBeenCalledWith(expect.objectContaining({
		answers: [expect.objectContaining({ answer: markers.join("\n") }), expect.objectContaining({ answer: "A" })],
	}));
});

describe("QuestionnaireSession — custom-answer drafts", () => {
	it.each([false, true])("keeps the long custom answer's caret visible within the viewport (multi=%s)", (multiSelect) => {
		const value = { questions: [{ ...params.questions[0], multiSelect }] };
		const { session } = makeSession({ params: value, rows: 14 });
		focusCustomAnswer(session);
		session.dispatch("long answer ".repeat(100));
		for (const width of [34, 18]) {
			const lines = session.component.render(width);
			expect(lines.length).toBeLessThanOrEqual(14);
			expect(lines.filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(1);
		}
		session.dispatch("\x01");
		for (let i = 0; i < 10; i++) session.dispatch("\x1b[C");
		expect(session.component.render(34).filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(1);
	});
	it("does not edit the draft while visibly collapsed, and resumes at the same input", () => {
		const { session, done } = makeSession({ collapseKey: "ctrl+]" });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.toggleCollapsedExternal();
		session.dispatch("unexpected");
		session.toggleCollapsedExternal();
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft" })],
			cancelled: false,
		});
	});

	it("preserves a draft while browsing options and restores it on return", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("draft answer");
		session.dispatch(UP);
		const browsingView = session.component.render(120).join("\n");
		expect(browsingView).toContain("draft answer");
		expect(browsingView).not.toContain("Type something.");
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "Which?",
					kind: "custom",
					answer: "draft answer",
				},
			],
			cancelled: false,
		});
	});

	it("submits a multiline custom answer composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		const view = session.component.render(120).join("\n");
		expect(view).toContain("first line");
		expect(view).toContain("second line");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("uses vertical arrows within the draft and returns to row navigation at the boundary", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch("!");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first!\nsecond" })],
			cancelled: false,
		});
	});

	it("clears the whole draft with Pi's Ctrl+U line-kill binding", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("discard me");
		session.dispatch(CTRL_U);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: null })],
			cancelled: false,
		});
	});

	it("replaces the inline draft with the external editor result", async () => {
		const editInput = vi.fn(async (value: string, _signal: AbortSignal) => `${value} + edited`);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		await Promise.resolve();
		await Promise.resolve();
		expect(editInput).toHaveBeenCalledWith("draft", expect.any(AbortSignal));
		session.dispatch(ENTER);

		expect(done).toHaveBeenLastCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
			cancelled: false,
		});
	});

	it("keeps input exclusive while the external editor is open", async () => {
		let resolveEditor!: (value: string | undefined) => void;
		const editInput = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					resolveEditor = resolve;
				}),
		);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);

		session.dispatch(UP);
		session.dispatch("late input");
		resolveEditor("edited");
		await Promise.resolve();
		await Promise.resolve();
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "edited" })],
			cancelled: false,
		});
	});

	it("closes an editing session without publishing a late editor result", async () => {
		let finish!: (value: string) => void;
		const editInput = vi.fn((_value: string, _signal: AbortSignal) => new Promise<string>((resolve) => { finish = resolve; }));
		const { session, done, tui } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		const closing = session.close();
		expect(editInput.mock.calls[0][1].aborted).toBe(true);
		const requests = tui.requestRender.mock.calls.length;
		finish("late replacement");
		await closing;
		session.dispatch(ENTER);
		expect(done).not.toHaveBeenCalled();
		expect(tui.requestRender).toHaveBeenCalledTimes(requests);
	});

	it("attaches multiline notes composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		session.dispatch("n");
		session.dispatch("first note");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second note");
		session.dispatch(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "option", notes: "first note\nsecond note" })],
			cancelled: false,
		});
	});

	it("commits the typed draft with a remapped tui.input.submit key (#156)", () => {
		// Slack-style config: enter is folded into tui.input.newLine (colliding with
		// the default tui.select.confirm), submit lives on its own key. The submit
		// key must confirm the custom answer instead of falling through to the
		// editor, whose own submit handling would wipe the draft.
		const CTRL_ENTER = "<CTRL_ENTER>";
		const remapped: typeof keybindings = {
			matches(data: string, name: string): boolean {
				if (name === "tui.input.submit") return data === CTRL_ENTER;
				if (name === "tui.input.newLine") return data === ENTER || data === SHIFT_ENTER;
				return keybindings.matches(data, name);
			},
		};
		const { session, done } = makeSession({ keybindings: remapped });
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		session.dispatch(CTRL_ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("a raw Enter byte the router does not match cannot wipe the draft via the editor's own submit (#156)", () => {
		// The session fake matches only the <ENTER> sentinel, so a raw "\r" reaches
		// the headless Editor, whose GLOBAL keybindings still bind tui.input.submit
		// to enter. Without disableSubmit, Editor.submitValue() would reset the
		// buffer and silently destroy the draft.
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("precious draft");
		session.dispatch("\r");
		expect(session.component.render(120).join("\n")).toContain("precious draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "precious draft" })],
			cancelled: false,
		});
	});

	it("keeps each question's latest draft isolated through real navigation and tab switches", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session } = makeSession({ params: multiParams });

		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch("-latest");
		session.dispatch(ENTER);

		focusCustomAnswer(session);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch(TAB);
		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("first-latest");

		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("second");
	});
});

describe("QuestionnaireSession — multi-select custom text joins checked options (#188)", () => {
	const SPACE = " ";
	const multiParams: QuestionParams = {
		questions: [{ ...params.questions[0]!, multiSelect: true }],
	};
	const multiItems: QuestionRow[][] = [
		[...itemsFor(multiParams)[0]!, { kind: "next" as const, label: "Next" }],
	];
	const both = {
		answers: [{ questionIndex: 0, question: "Which?", kind: "multi", answer: "my text", selected: ["A"] }],
		cancelled: false,
	};

	function checkAThenType(): ReturnType<typeof makeSession> {
		const made = makeSession({ params: multiParams, itemsByTab: multiItems });
		made.session.dispatch(SPACE); // check A
		focusCustomAnswer(made.session);
		made.session.dispatch("my text");
		return made;
	}

	it("Enter in the custom input submits the checked options AND the text", () => {
		const { session, done } = checkAThenType();
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith(both);
		expect(buildQuestionnaireResponse(done.mock.calls[0]![0], multiParams).content[0]!.text).toContain(
			'"Which?"="A, my text"',
		);
	});

	it("Next submits the checked options AND the text", () => {
		const { session, done } = checkAThenType();
		session.dispatch(DOWN); // leave the input for Next
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith(both);
	});

	it("the custom row is checked while it holds text and unchecked once cleared", () => {
		const { session } = checkAThenType();
		expect(session.component.render(120).join("\n")).toMatch(/\[✔\] my text/);
		session.dispatch(CTRL_U);
		expect(session.component.render(120).join("\n")).toMatch(/3\. \[ \]/);
	});
});

describe("QuestionnaireSession — a saved note stays visible (#197)", () => {
	const NOTE_LABEL = "Note for this answer:";
	const view = (session: QuestionnaireSession) => session.component.render(120).join("\n");
	function saveNote(session: QuestionnaireSession, text: string): void {
		session.dispatch("n");
		session.dispatch(text);
		session.dispatch(ENTER); // closes the notes editor, keeping the note
	}

	it("shows the note on the question tab once its editor closes", () => {
		const { session } = makeSession();
		expect(view(session)).not.toContain(NOTE_LABEL);
		saveNote(session, "remember the cache");
		expect(view(session)).toContain(`${NOTE_LABEL} remember the cache`);
	});

	it("keeps a multi-line note to one row", () => {
		const { session } = makeSession();
		session.dispatch("n");
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		session.dispatch(ENTER);
		const lines = session.component.render(120).filter((l) => l.includes(NOTE_LABEL));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("first line …");
		expect(view(session)).not.toContain("second line");
	});

	it("a note row keeps the cross-tab dialog height when the body leaves room", () => {
		const taller = {
			question: "Second?",
			header: "Second",
			options: ["A", "B", "C", "D"].map((label) => ({ label, description: label.toLowerCase() })),
		};
		const p: QuestionParams = {
			questions: [{ ...params.questions[0]!, question: "First?", header: "First" }, taller],
		};
		const { session } = makeSession({ params: p });
		const height = session.component.render(120).length;
		saveNote(session, "remember the cache"); // on the shorter First tab
		expect(view(session)).toContain(`${NOTE_LABEL} remember the cache`);
		expect(session.component.render(120).length).toBe(height);
		session.dispatch(TAB);
		expect(session.component.render(120).length).toBe(height);
	});

	it("labels the note the same way on the review tab", () => {
		const twoQuestions: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session } = makeSession({ params: twoQuestions });
		saveNote(session, "remember the cache");
		session.dispatch(ENTER); // answer First, advancing to Second
		session.dispatch(TAB); // Submit tab
		const review = view(session);
		expect(review).toContain(`${NOTE_LABEL} remember the cache`);
		expect(review).not.toContain("notes: remember the cache");
	});
});

describe("QuestionnaireSession — collapsed row", () => {
	it.each(["off", "ctrl+shift+super+backspace"])("keeps the %s hint in one terminal row", collapseKey => {
		const { session } = makeSession({ collapseKey });
		session.toggleCollapsedExternal();
		const collapsed = session.component.render(120);
		expect(collapsed).toHaveLength(1);
		if (collapseKey === "off") {
			expect(collapsed[0]).toContain("Esc to cancel");
			expect(collapsed[0]).not.toContain("to expand");
			expect(collapsed[0]).not.toContain("Off");
		} else expect(collapsed[0]).toContain("Ctrl+Shift+Super+Backspace");
		for (const width of [15, 1, 0]) {
			const lines = session.component.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		}
	});
});
