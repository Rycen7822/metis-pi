import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "../tool/types.ts";
import type { QuestionRow } from "./row-intent.ts";
import type { QuestionnaireAction, QuestionnaireState } from "./state.ts";
import { selectCustomDraftValue } from "./selectors/derivations.ts";

/** Session-lifetime constants. No live-component reads — peripheral values live on canonical state. */
export interface ApplyContext {
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly QuestionRow[]>;
}

/**
 * Declarative side-effects emitted by `reduce`. The runtime executes them after
 * committing the new state, then asks the props-adapter to re-project. Closed set —
 * adding an effect requires updating both the union AND the runtime's `runEffect` switch
 * (compiler-enforced exhaustive). No string-keyed escape hatch.
 */
export type Effect =
	| { kind: "set_input_buffer"; value: string }
	| { kind: "clear_input_buffer" }
	| { kind: "open_input_editor"; value: string }
	| { kind: "set_notes_value"; value: string }
	| { kind: "set_notes_focused"; focused: boolean }
	| { kind: "forward_notes_keystroke"; data: string }
	| { kind: "forward_input_keystroke"; data: string }
	| { kind: "scroll_review"; direction: -1 | 1 }
	/**
	 * Tell the session to hide or show its underlying overlay. Emitted by the
	 * `toggle_collapsed` action so the runtime can call `OverlayHandle.setHidden(...)`,
	 * which lets other overlay-aware consumers (e.g. `pi-station`) see the questionnaire
	 * as truly hidden and resume normal chat scroll while the user reads the transcript
	 * behind the modal.
	 */
	| { kind: "set_overlay_hidden"; hidden: boolean }
	| { kind: "done"; result: QuestionnaireResult };

export interface ApplyResult {
	state: QuestionnaireState;
	effects: readonly Effect[];
}

function orderedAnswers(state: QuestionnaireState, questions: readonly QuestionData[]): QuestionAnswer[] {
	const out: QuestionAnswer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const a = state.answers.get(i);
		if (a) out.push(a);
	}
	return out;
}

function syncMultiSelectFromAnswers(
	answers: ReadonlyMap<number, QuestionAnswer>,
	questions: readonly QuestionData[],
	tab: number,
): ReadonlySet<number> {
	const q = questions[tab];
	if (!q?.multiSelect) return new Set();
	const saved = answers.get(tab);
	const labels = saved?.selected ?? [];
	const indices = new Set<number>();
	for (let i = 0; i < q.options.length; i++) {
		if (labels.includes(q.options[i]!.label)) indices.add(i);
	}
	return indices;
}

function selectedLabels(state: QuestionnaireState, question: QuestionData): string[] {
	const selected: string[] = [];
	for (let i = 0; i < question.options.length; i++) {
		if (state.multiSelectChecked.has(i)) selected.push(question.options[i]!.label);
	}
	return selected;
}

function multiAnswer(state: QuestionnaireState, question: QuestionData, value: string): QuestionAnswer {
	const notes = state.notesByTab.get(state.currentTab);
	return {
		questionIndex: state.currentTab,
		question: question.question,
		kind: "multi",
		answer: value.trim().length > 0 ? value : null,
		selected: selectedLabels(state, question),
		...(notes ? { notes } : {}),
	};
}

function persistMultiSelectAnswer(state: QuestionnaireState, ctx: ApplyContext): ReadonlyMap<number, QuestionAnswer> {
	const q = ctx.questions[state.currentTab];
	if (!q?.multiSelect) return state.answers;
	const answer = multiAnswer(state, q, selectCustomDraftValue(state, state.currentTab));
	const out = new Map(state.answers);
	if (answer.selected?.length || answer.answer !== null) out.set(state.currentTab, answer);
	else out.delete(state.currentTab);
	return out;
}

/**
 * Note text to seed the editor/draft with for a tab. The in-flight side-band store
 * (`notesByTab`) is authoritative — before an option is confirmed the note lives ONLY
 * there; `answer.notes` is a mirror written on exit/confirm.
 */
function notesValueFor(state: QuestionnaireState, tab: number): string {
	return state.notesByTab.get(tab) ?? state.answers.get(tab)?.notes ?? "";
}

function setCustomDraft(state: QuestionnaireState, tab: number, value: string): ReadonlyMap<number, string> {
	const drafts = new Map(state.customDraftsByTab);
	drafts.set(tab, value);
	return drafts;
}

function withoutCustomDraft(state: QuestionnaireState, tab: number): ReadonlyMap<number, string> {
	if (!state.customDraftsByTab.has(tab)) return state.customDraftsByTab;
	const drafts = new Map(state.customDraftsByTab);
	drafts.delete(tab);
	return drafts;
}

function switchTabResult(state: QuestionnaireState, nextTab: number, ctx: ApplyContext): ApplyResult {
	const notesValue = notesValueFor(state, nextTab);
	const transitioned: QuestionnaireState = {
		...state,
		currentTab: nextTab,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		submitChoiceIndex: 0,
		multiSelectChecked: syncMultiSelectFromAnswers(state.answers, ctx.questions, nextTab),
	};
	return {
		state: transitioned,
		effects: [
			{ kind: "set_notes_focused", focused: false },
			{ kind: "set_notes_value", value: notesValue },
			{ kind: "set_input_buffer", value: selectCustomDraftValue(state, nextTab) },
		],
	};
}

function doneFor(state: QuestionnaireState, ctx: ApplyContext, cancelled: boolean): ApplyResult {
	// Global note lift: the Submit-tab note lives at the `questions.length` pseudo-index
	// in `notesByTab` — question tabs only occupy 0..questions.length-1, so this can never
	// cross-contaminate a per-question note. Attached regardless of `cancelled` (the
	// reducer is truth; the envelope owns decline presentation), with cancel/submit/confirm
	// sharing this single lift. Conditional spread keeps note-free results byte-identical.
	const globalNote = state.notesByTab.get(ctx.questions.length);
	const result: QuestionnaireResult = {
		answers: orderedAnswers(state, ctx.questions),
		cancelled,
		...(globalNote && globalNote.length > 0 ? { globalNote } : {}),
	};
	return { state, effects: [{ kind: "done", result }] };
}

function confirmResult(state: QuestionnaireState, value: string, ctx: ApplyContext): ApplyResult {
	const q = ctx.questions[state.currentTab];
	if (!q) return { state, effects: [] };
	let answer: QuestionAnswer;
	if (q.multiSelect) {
		// Explicit confirmation preserves an empty multi answer; toggling to empty does not.
		answer = multiAnswer(state, q, value);
	} else if (state.inputMode) {
		answer = { questionIndex: state.currentTab, question: q.question, kind: "custom", answer: value.length ? value : null };
	} else {
		const item = ctx.itemsByTab[state.currentTab]?.[state.optionIndex];
		if (item?.kind !== "option") return { state, effects: [] };
		const option = q.options[state.optionIndex];
		if (!option) return { state, effects: [] };
		answer = {
			questionIndex: state.currentTab, question: q.question, kind: "option", answer: option.label,
			...(option.preview ? { preview: option.preview } : {}),
		};
	}
	const notes = state.notesByTab.get(state.currentTab);
	if (notes) answer = { ...answer, notes };
	const answers = new Map(state.answers);
	answers.set(state.currentTab, answer);
	const next = {
		...state, answers,
		customDraftsByTab: answer.kind === "option" ? state.customDraftsByTab : withoutCustomDraft(state, state.currentTab),
	};
	return ctx.questions.length > 1 ? switchTabResult(next, state.currentTab + 1, ctx) : doneFor(next, ctx, false);
}

function exitNotes(state: QuestionnaireState, value: string): ApplyResult {
	const trimmed = value.trim();
	const notes = new Map(state.notesByTab);
	const answers = new Map(state.answers);
	const prev = answers.get(state.currentTab);
	if (trimmed.length === 0) {
		notes.delete(state.currentTab);
		if (prev?.notes) {
			const { notes: _removed, ...answer } = prev;
			answers.set(state.currentTab, answer);
		}
	} else {
		notes.set(state.currentTab, trimmed);
		if (prev) answers.set(state.currentTab, { ...prev, notes: trimmed });
	}
	return {
		state: { ...state, notesByTab: notes, answers, notesVisible: false },
		effects: [{ kind: "set_notes_focused", focused: false }],
	};
}

export function reduce(state: QuestionnaireState, action: QuestionnaireAction, ctx: ApplyContext): ApplyResult {
	switch (action.kind) {
		case "nav": {
			const inputMode = ctx.itemsByTab[state.currentTab]?.[action.nextIndex]?.kind === "other";
			const customDraftsByTab = state.inputMode ? setCustomDraft(state, state.currentTab, action.inputValue) : state.customDraftsByTab;
			let next = { ...state, optionIndex: action.nextIndex, inputMode, customDraftsByTab };
			if (state.inputMode && !inputMode && ctx.questions[state.currentTab]?.multiSelect) {
				next = { ...next, answers: persistMultiSelectAnswer(next, ctx) };
			}
			return { state: next, effects: inputMode ? [{ kind: "set_input_buffer", value: selectCustomDraftValue(next, state.currentTab) }] : [] };
		}
		case "input_clear":
			return {
				state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, "") },
				effects: [{ kind: "clear_input_buffer" }],
			};
		case "input_edit":
			return { state, effects: [{ kind: "open_input_editor", value: action.value }] };
		case "input_replace":
			return {
				state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, action.value) },
				effects: [{ kind: "set_input_buffer", value: action.value }],
			};
		case "input_forward":
			return { state, effects: [{ kind: "forward_input_keystroke", data: action.data }] };
		case "tab_switch":
			return switchTabResult(state, action.nextTab, ctx);
		case "confirm":
			return confirmResult(state, action.value, ctx);
		case "toggle": {
			const checked = new Set(state.multiSelectChecked);
			if (checked.has(action.index)) checked.delete(action.index);
			else checked.add(action.index);
			const next = { ...state, multiSelectChecked: checked };
			return { state: { ...next, answers: persistMultiSelectAnswer(next, ctx) }, effects: [] };
		}
		case "notes_enter":
			return {
				state: { ...state, notesVisible: true },
				effects: [{ kind: "set_notes_value", value: notesValueFor(state, state.currentTab) }, { kind: "set_notes_focused", focused: true }],
			};
		case "notes_exit":
			return exitNotes(state, action.value);
		case "notes_forward":
			return { state, effects: [{ kind: "forward_notes_keystroke", data: action.data }] };
		case "cancel":
		case "submit":
			return doneFor(state, ctx, action.kind === "cancel");
		case "submit_nav":
			return { state: { ...state, submitChoiceIndex: action.nextIndex }, effects: [] };
		case "review_scroll":
			return { state, effects: [{ kind: "scroll_review", direction: action.direction }] };
		case "toggle_collapsed":
			return { state: { ...state, collapsed: !state.collapsed }, effects: [{ kind: "set_overlay_hidden", hidden: !state.collapsed }] };
		case "ignore":
			return { state, effects: [] };
	}
}
