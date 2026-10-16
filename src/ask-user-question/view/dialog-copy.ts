/** Leaf: imports nothing from `view/`, so `dialog-builder` and `tab-content-strategy` never form a runtime cycle (#208). */

export const HINT_PART_ENTER = "Enter to select";
export const HINT_PART_NAV = "↑/↓ to navigate";
export const HINT_PART_NEW_LINE = "Shift+Enter for newline";
export const HINT_PART_CLEAR = "Ctrl+U to clear";
export const HINT_PART_TOGGLE = "Space to toggle";
export const HINT_PART_NOTES = "n to add notes";
export const HINT_PART_TAB = "Tab to switch questions";
export const HINT_PART_CANCEL = "Esc to cancel";
/**
 * Collapse/expand hint copy is templated on `KEY_PLACEHOLDER` because the
 * shortcut is configurable (`collapseKey`) and `rpiv-i18n`'s `tr` has no
 * interpolation — locale entries carry the same `{key}` placeholder and call
 * sites `.replace()` it with `formatKeySpecForDisplay(collapseKey)` after
 * lookup, so per-locale word order is preserved.
 */
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} to collapse`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} to expand`;
/**
 * Template for the single-line footer shown by `QuestionnaireSession` when
 * `state.collapsed === true`. Bypasses `buildHintText`; the session replaces
 * `KEY_PLACEHOLDER` with the configured key's display form.
 */
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";
