import { isKeyRelease, isKeyRepeat, Key, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionnaireAction, QuestionnaireRuntime, QuestionnaireState } from "./state.ts";

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_SUBMIT = "tui.input.submit";
const KEYBIND_CANCEL = "tui.select.cancel";
const KEYBIND_NEW_LINE = "tui.input.newLine";
const KEYBIND_EDITOR_UP = "tui.editor.cursorUp";
const KEYBIND_EDITOR_DOWN = "tui.editor.cursorDown";
const KEYBIND_CLEAR = "tui.editor.deleteToLineStart";
const KEYBIND_EXTERNAL_EDITOR = "app.editor.external";

const NOTES_ACTIVATE_KEY = "n";

export interface QuestionnaireKeybindings {
	matches(data: string, name: string): boolean;
}

// Confirm has two semantic sources: `tui.select.confirm` (the select-list default)
// and `tui.input.submit` (the user's "send" key). A Slack-style configuration folds
// `enter` into `tui.input.newLine` and moves submit elsewhere (e.g. `ctrl+enter`);
// the newline checks below stay first, so without the submit source every confirm
// branch would be shadowed by the collision and no key could confirm (#156). With
// pi defaults both names resolve to `enter`, so matching either is equivalent.
function isConfirm(kb: QuestionnaireKeybindings, data: string): boolean {
	return kb.matches(data, KEYBIND_CONFIRM) || kb.matches(data, KEYBIND_SUBMIT);
}

export function wrapTab(index: number, total: number): number {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

function totalTabs(runtime: QuestionnaireRuntime): number {
	return runtime.isMulti ? runtime.questions.length + 1 : 1;
}

function tabSwitchAction(
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
	if (!runtime.isMulti) return null;
	const total = totalTabs(runtime);
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab + 1, total) };
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab - 1, total) };
	}
	return null;
}

// DOWN at the last item wraps to the first (cycle through [option0, …, optionLast]).
function nextNavOnDown(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return {
		kind: "nav",
		nextIndex: wrapTab(state.optionIndex + 1, Math.max(1, runtime.items.length)),
		inputValue: runtime.inputBuffer,
	};
}

// UP at the first item wraps to the last (symmetric with nextNavOnDown).
function prevNavOnUp(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return {
		kind: "nav",
		nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, runtime.items.length)),
		inputValue: runtime.inputBuffer,
	};
}

// Collapsed-mode lockout: while collapsed, swallow every keystroke except cancel so
// the user can read the now-uncovered transcript without accidentally mutating
// answers or notes. The collapse toggle itself is already handled above.
function routeCollapsed(kb: QuestionnaireKeybindings, data: string): QuestionnaireAction {
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	return { kind: "ignore" };
}

function routeNotesMode(kb: QuestionnaireKeybindings, data: string, value: string): QuestionnaireAction {
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "notes_exit", value };
	if (kb.matches(data, KEYBIND_NEW_LINE)) return { kind: "notes_forward", data };
	if (isConfirm(kb, data)) return { kind: "notes_exit", value };
	return { kind: "notes_forward", data };
}

function routeInputMode(
	kb: QuestionnaireKeybindings,
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	// Newline takes precedence over confirmation if a user configuration binds
	// the same physical key to both semantic actions.
	if (kb.matches(data, KEYBIND_NEW_LINE)) return { kind: "input_forward", data };
	if (isConfirm(kb, data)) return { kind: "confirm", value: runtime.inputBuffer };
	// Treat Pi's Ctrl+U line-kill binding as an explicit whole-draft clear,
	// independent of the current cursor position.
	if (kb.matches(data, KEYBIND_CLEAR)) return { kind: "input_clear" };
	if (kb.matches(data, KEYBIND_EXTERNAL_EDITOR)) return { kind: "input_edit", value: runtime.inputBuffer };
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	if (kb.matches(data, KEYBIND_EDITOR_UP) && runtime.canMoveInputUp) return { kind: "input_forward", data };
	if (kb.matches(data, KEYBIND_EDITOR_DOWN) && runtime.canMoveInputDown) return { kind: "input_forward", data };
	if (kb.matches(data, KEYBIND_UP)) return prevNavOnUp(state, runtime);
	if (kb.matches(data, KEYBIND_DOWN)) return nextNavOnDown(state, runtime);
	return { kind: "input_forward", data };
}

function routeSubmitTab(
	kb: QuestionnaireKeybindings,
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	const tab = tabSwitchAction(data, state, runtime);
	if (tab) return tab;
	if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
		const delta = kb.matches(data, KEYBIND_DOWN) ? 1 : -1;
		const next = wrapTab(state.submitChoiceIndex + delta, 2);
		return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
	}
	if (isConfirm(kb, data)) {
		// D1 (revised): Submit always submits; Cancel always cancels. The warning header
		// is informational only — completeness no longer gates submission. Partial
		// answers flow through `orderedAnswers()` in the host.
		return state.submitChoiceIndex === 1 ? { kind: "cancel" } : { kind: "submit" };
	}
	// Global note (#182): `n` on the Submit tab opens the notes editor scoped to the whole
	// questionnaire at the pseudo-index (`questions.length` in notesByTab). Reachable only
	// with the editor closed — `routeKey` dispatches notesVisible traffic to
	// `routeNotesMode` before the submit-tab block runs. The branch shadows nothing above
	// it (cancel, tab switch, submit-nav, confirm): a literal `n` byte matches none of them
	// under default bindings, and a user who deliberately binds one of those actions to
	// `n` keeps that mapping because the earlier branch still wins (Enter still submits).
	if (matchesKey(data, NOTES_ACTIVATE_KEY)) {
		return { kind: "notes_enter" };
	}
	return { kind: "ignore" };
}

function routeMultiSelectTab(
	kb: QuestionnaireKeybindings,
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	const kind = runtime.currentItem?.kind;
	if (matchesKey(data, Key.space)) return kind === "option" ? { kind: "toggle", index: state.optionIndex } : { kind: "ignore" };
	if (isConfirm(kb, data)) {
		if (kind === "other") return { kind: "ignore" };
		if (kind === "next") return { kind: "confirm", value: runtime.inputBuffer };
		return { kind: "toggle", index: state.optionIndex };
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	return { kind: "ignore" };
}

function routeSingleSelectTab(
	kb: QuestionnaireKeybindings,
	data: string,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	if (isConfirm(kb, data)) {
		return runtime.currentItem?.kind === "option" ? { kind: "confirm", value: runtime.inputBuffer } : { kind: "ignore" };
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	return { kind: "ignore" };
}

export function routeKey(data: string, state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	if (isKeyRelease(data)) return { kind: "ignore" };
	const action = routeKeyAction(data, state, runtime);
	// Only navigation and editor input may repeat.
	if (
		isKeyRepeat(data) &&
		action.kind !== "nav" && action.kind !== "submit_nav" &&
		action.kind !== "input_forward" && action.kind !== "notes_forward"
	) return { kind: "ignore" };
	return action;
}

function routeKeyAction(data: string, state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	const kb = runtime.keybindings;

	// Collapse has priority in every mode. A raw terminal listener handles reopening
	// a hidden overlay; hosts without that listener retain a visible collapsed row.
	// Invalid/off shortcuts must not reach pi-tui's key parser.
	if (
		typeof runtime.collapseKey === "string" &&
		runtime.collapseKey !== "off" &&
		matchesKey(data, runtime.collapseKey as Parameters<typeof matchesKey>[1])
	) {
		return { kind: "toggle_collapsed" };
	}

	if (state.collapsed) return routeCollapsed(kb, data);
	if (state.notesVisible) return routeNotesMode(kb, data, runtime.notesBuffer);
	if (state.inputMode) return routeInputMode(kb, data, state, runtime);
	if (runtime.isMulti && state.currentTab === runtime.questions.length) {
		return routeSubmitTab(kb, data, state, runtime);
	}

	const tab = tabSwitchAction(data, state, runtime);
	if (tab) return tab;

	const q = runtime.questions[state.currentTab];
	if (!q) return { kind: "ignore" };

	// Universal `n` activation (FR-1): the notes editor opens on every question tab
	// (single- or multi-select, preview or no-preview). The blocks above already
	// swallow `n` when it should NOT reach here — notesVisible forwards to the
	// notes Input, inputMode forwards to the inline Input, the submit-tab block
	// activates it via its own branch (the global note, ahead of its ignore
	// fall-through), and tabSwitchAction ignores it — so by the time we reach this
	// gate, `n` is unambiguously a notes-enter request. Row intent (Next sentinel,
	// "Type something.") is irrelevant: the gate sits ABOVE the multi-select
	// toggle block and the Next sentinel never activates inputMode, so `n` is
	// neither swallowed earlier nor blocked by the focused row.
	if (matchesKey(data, NOTES_ACTIVATE_KEY)) {
		return { kind: "notes_enter" };
	}

	if (kb.matches(data, KEYBIND_UP)) {
		return prevNavOnUp(state, runtime);
	}
	if (kb.matches(data, KEYBIND_DOWN)) {
		return nextNavOnDown(state, runtime);
	}

	if (q.multiSelect) return routeMultiSelectTab(kb, data, state, runtime);
	return routeSingleSelectTab(kb, data, runtime);
}
