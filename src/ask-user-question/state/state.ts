import type { QuestionAnswer, QuestionData } from "../tool/types.ts";
import type { QuestionRow } from "./row-intent.ts";

export type QuestionnaireAction =
	| { kind: "nav"; nextIndex: number; inputValue: string }
	| { kind: "input_clear" }
	| { kind: "input_edit"; value: string }
	| { kind: "input_replace"; value: string }
	| { kind: "input_forward"; data: string }
	| { kind: "tab_switch"; nextTab: number }
	| { kind: "confirm"; value: string }
	| { kind: "toggle"; index: number }
	| { kind: "cancel" }
	| { kind: "notes_enter" }
	| { kind: "notes_exit"; value: string }
	| { kind: "submit" }
	| { kind: "submit_nav"; nextIndex: 0 | 1 }
	| { kind: "notes_forward"; data: string }
	| { kind: "toggle_collapsed" }
	| { kind: "ignore" };

/**
 * Canonical state for the questionnaire dialog. Single source of truth — both the
 * dispatcher (`routeKey`) and the view layer read this same shape.
 */
export interface QuestionnaireState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesVisible: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	/** In-flight custom answers keyed by tab. A present empty string overrides an older answer. */
	customDraftsByTab: ReadonlyMap<number, string>;
	/**
	 * Pre-answer notes side-band, keyed by tab index. Decoupled from `answers` so adding
	 * notes does NOT mark a question answered (the Submit-tab missing-check would falsely
	 * pass otherwise). Merged into the answer at confirm time.
	 */
	notesByTab: ReadonlyMap<number, string>;
	/** Focused row in the Submit-tab picker (0 = Submit, 1 = Cancel). Reset on tab switch. */
	submitChoiceIndex: number;
	/**
	 * Collapsed mode: the questionnaire gets out of the way so the agent transcript behind
	 * the bottom-anchored overlay becomes readable. Toggled by the configured collapse key
	 * from any state; while true, every keystroke except cancel is swallowed (see
	 * `routeKey`). Two renderings, chosen by host capability:
	 *
	 * - Hosts with an `OverlayHandle` AND a raw `onTerminalInput` listener (real pi-tui):
	 *   the `set_overlay_hidden` effect fully hides the overlay; the raw listener registered
	 *   in `execute()` reopens it, because pi-tui routes no input to a hidden overlay.
	 * - Inline presentation, or hosts without the raw listener/handle: the dialog stays visible and
	 *   shrinks to a single hint row. The row keeps focus and input routing, so the same key
	 *   expands it and Esc cancels, and the expand key never falls through to an underlying
	 *   overlay (e.g. `/btw`). The session gates `set_overlay_hidden` on the listener's
	 *   existence (`canReopenWhileHidden`) so a handle-bearing host without raw input can
	 *   never hide the overlay into a state nothing can reopen.
	 */
	collapsed: boolean;
}

/**
 * Per-tick context the dispatcher needs alongside canonical state. Held separately
 * because `keybindings` / `inputBuffer` must never reach view setProps consumers.
 */
export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	notesBuffer: string;
	canMoveInputUp: boolean;
	canMoveInputDown: boolean;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: QuestionRow | undefined;
	items: readonly QuestionRow[];
	/**
	 * Key spec for the collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. Resolved
	 * from `AskUserQuestionConfig.collapseKey` (or the package default). When `"off"`,
	 * the collapse shortcut is disabled.
	 */
	collapseKey: string;
}
