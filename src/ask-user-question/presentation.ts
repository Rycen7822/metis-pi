import type { QuestionnaireResult } from "./tool/types.ts";

/**
 * Inline row budget. A component in Pi's editor slot only receives a width, and the
 * host clips the slot from the bottom when the dock outgrows the screen, so the inline
 * dialog caps itself — the same idiom Pi's own editor uses in that slot
 * (`max(5, floor(rows * 0.3))`). The floor keeps the dialog chrome plus a few option
 * rows; past the cap, `DialogView`'s scroll-to-focus partition takes over.
 */
export const INLINE_ROW_RATIO = 0.7;
export const INLINE_MIN_ROWS = 12;

/** Maps the terminal's row count to the rows the dialog may render. */
export type RowBudget = (terminalRows: number) => number;

/** The whole of `terminal.rows`: the overlay, and any host that already allocates the dialog's rows. */
export const fullRowBudget: RowBudget = (terminalRows) => terminalRows;

/**
 * Marker a host sets on `tui.terminal` when it reports the rows it has allocated to the
 * questionnaire as `terminal.rows` (rpiv-pi's lane console `cappedTui`). The inline cap
 * exists to leave the transcript room in Pi's editor slot; applying it to an allocation
 * would shrink an already-sized band a second time. A registry symbol, so hosts need no
 * import from this package.
 */
export const HOST_ALLOCATED_ROWS = Symbol.for("rpiv-ask-user-question:host-allocated-rows");

function hostAllocatesRows(terminal: object): boolean {
	return (terminal as Record<symbol, unknown>)[HOST_ALLOCATED_ROWS] === true;
}

/** The presentation's budget, unless the host has already allocated the rows itself. */
export function rowBudgetForHost(terminal: object, budget: RowBudget): RowBudget {
	return hostAllocatesRows(terminal) ? fullRowBudget : budget;
}

/**
 * Resolved by an inline mount that gives the editor slot up (see `mustYieldInlineSlot`);
 * `execute()` remounts as an overlay on seeing it. Compared by identity — a valid cancel
 * result, so it is harmless should it ever escape.
 */
export const YIELD_TO_OVERLAY: QuestionnaireResult = Object.freeze({
	answers: [],
	cancelled: true,
}) as QuestionnaireResult;

/**
 * True when an inline mount would land underneath an overlay already on screen (e.g. an
 * open `/btw`). pi-tui hands focus to the newly mounted editor-slot component while
 * that overlay keeps painting over it, so keys — Esc included — would reach a question
 * the user cannot see. Stacking as an overlay instead keeps the question visible and
 * focused, and pi-tui returns focus to the other overlay when it closes. A host that
 * allocates the rows itself (rpiv-pi lane console) owns its geometry and is left alone.
 */
export function mustYieldInlineSlot(tui: { terminal: object; hasOverlay?: () => boolean }): boolean {
	return !hostAllocatesRows(tui.terminal) && typeof tui.hasOverlay === "function" && tui.hasOverlay();
}

export const inlineRowBudget: RowBudget = (terminalRows) =>
	Math.min(terminalRows, Math.max(INLINE_MIN_ROWS, Math.floor(terminalRows * INLINE_ROW_RATIO)));

export interface Presentation {
	/** True → focused overlay (`ctx.ui.custom` overlay options); false → Pi's editor slot. */
	overlay: boolean;
	rowBudget: RowBudget;
}

// Pi 1.4 owns inline dialog stacking, focus restoration and per-dialog removal.
export const INLINE_PRESENTATION: Presentation = Object.freeze({
	overlay: false,
	rowBudget: inlineRowBudget,
});

export const OVERLAY_PRESENTATION: Presentation = Object.freeze({
	overlay: true,
	rowBudget: fullRowBudget,
});
