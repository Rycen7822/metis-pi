import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { OptionListView, type OptionListTheme } from "./option-list-view.ts";
import type { QuestionRow } from "../../state/row-intent.ts";

// Cursor render emitted by inline-input-row.ts:renderInlineInputRow — pi-tui's
// zero-width CURSOR_MARKER (hardware-cursor positioning) immediately followed by
// the character UNDER the cursor wrapped in SGR 7/27 (reverse video). The cursor
// REPLACES (does not insert), so width is preserved. At end-of-buffer the
// reverse-video character is a single U+00A0 (NBSP); a literal space would
// tokenize as a wrap break.
const cursorOn = (ch: string) => `${CURSOR_MARKER}\x1b[7m${ch}\x1b[27m`;
const NBSP = " ";

const identityTheme: OptionListTheme = {
	selectedText: (t) => t,
	description: (t) => t,
	scrollInfo: (t) => t,
};

// Numbering is preserved — rows render as "❯ N. label". number width follows the real item count.
describe("OptionListView selectedIndex props", () => {
	it("clamps negative to 0", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "a" },
				{ kind: "option", label: "b" },
			], maxVisible: 10, theme: identityTheme });

		s.setProps({ selectedIndex: -5, focused: true, inputBuffer: "" });
		const lines = s.render(40);
		expect(lines[0]).toContain("❯ 1. a");
	});
	it("clamps above-max to last", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "a" },
				{ kind: "option", label: "b" },
			], maxVisible: 10, theme: identityTheme });

		s.setProps({ selectedIndex: 99, focused: true, inputBuffer: "" });
		const lines = s.render(40);
		expect(lines[1]).toContain("❯ 2. b");
	});
});

describe("OptionListView.render — visible window", () => {
	const items: QuestionRow[] = Array.from({ length: 20 }, (_, i) => ({
		kind: "option" as const,
		label: `row-${i + 1}`,
	}));

	it("renders all items when count <= maxVisible", () => {
		const s = new OptionListView({ items: items.slice(0, 3), maxVisible: 10, theme: identityTheme });

		const lines = s.render(40);
		expect(lines.filter((l) => l.includes("row-")).length).toBe(3);
	});

	it("shows scroll indicator when items exceed maxVisible", () => {
		const s = new OptionListView({ items: items, maxVisible: 5, theme: identityTheme });

		s.setProps({ selectedIndex: 10, focused: true, inputBuffer: "" });
		const lines = s.render(40);
		expect(lines.some((l) => l.includes("(11/20)"))).toBe(true);
	});

	it("centers window around selectedIndex", () => {
		const s = new OptionListView({ items: items, maxVisible: 5, theme: identityTheme });

		s.setProps({ selectedIndex: 10, focused: true, inputBuffer: "" });
		const lines = s.render(40);
		expect(lines.some((l) => /\brow-9\b/.test(l))).toBe(true);
		expect(lines.some((l) => /\brow-11\b/.test(l))).toBe(true);
		expect(lines.some((l) => /\brow-1\b/.test(l))).toBe(false);
	});

	it("returns empty array for zero items", () => {
		const s = new OptionListView({ items: [], maxVisible: 5, theme: identityTheme });

		expect(s.render(40)).toEqual([]);
	});
});

describe("OptionListView.render — inline input when kind:'other' + focused", () => {
	// `lineCountForInputRow` collapses the rendered output into just the inline-input
	// row(s). Useful when asserting wrap behavior — the cursor row may now span
	// multiple lines, but we want to ignore unrelated rows (e.g. scrollInfo) when
	// computing how many wrapped lines the input produced.
	const inlineInputLines = (lines: readonly string[]): string[] =>
		lines.filter((l) => l.includes(CURSOR_MARKER) || /[a-z0-9]/.test(l));

	it("renders inline input row with cursor when kind:'other' item focused", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hi" });
		const lines = s.render(40);
		expect(lines[0]).toContain("hi");
		expect(lines[0]).toContain(CURSOR_MARKER);
	});
	it("renders the custom draft (without a cursor) when kind:'other' is not focused", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: false, inputBuffer: "draft" });
		const lines = s.render(40);
		expect(lines[0]).toContain("draft");
		expect(lines[0]).not.toContain("pick");
		expect(lines[0]).not.toContain(CURSOR_MARKER);
	});

	it("falls back to the Type something label when the unfocused draft is empty", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: false, inputBuffer: "" });
		expect(s.render(40)[0]).toContain("pick");
	});

	it("shows a changed custom draft without the prior answer's confirmation mark", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: false, inputBuffer: "new draft", confirmed: { index: 0, labelOverride: "confirmed" } });
		const line = s.render(40)[0] ?? "";
		expect(line).toContain("new draft");
		expect(line).not.toContain("confirmed");
		expect(line).not.toContain("✔");
	});

	// Regression: pre-fix the inline-input row was hard-truncated to `width`, so long
	// custom answers visually disappeared off the right edge instead of wrapping.
	// Post-fix every emitted line — first line + all continuation lines — must stay
	// within `width`, matching the contract that `renderLabelBlock` already honors.
	it("wraps inline input row across multiple lines when input exceeds width", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "this is a really long input that exceeds the width" });
		const narrowWidth = 20;
		const lines = s.render(narrowWidth);
		for (const l of lines) {
			expect(visibleWidth(l)).toBeLessThanOrEqual(narrowWidth);
		}
		expect(inlineInputLines(lines).length).toBeGreaterThan(1);
	});

	// rowPrefix "❯ 1. " = 5 cols, +16 chars input, +1 col cursor = 22 cols → 2 over.
	// Reproduces the original "overflows by a column or two" symptom that crashed pi.
	// Width invariant must hold across every emitted line, including continuation lines.
	it("keeps every line ≤ width when input pushes the row just past width (off-by-one boundary)", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "a".repeat(16) });
		const width = 20;
		const lines = s.render(width);
		for (const l of lines) {
			expect(visibleWidth(l)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps every line ≤ width when input is much longer than width", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "x".repeat(200) });
		const width = 10;
		const lines = s.render(width);
		for (const l of lines) {
			expect(visibleWidth(l)).toBeLessThanOrEqual(width);
		}
		// 200 chars at width=10 minus rowPrefix overhead → at least several wrapped lines.
		expect(inlineInputLines(lines).length).toBeGreaterThan(2);
	});

	// Each 😀 is 2 cols wide, so unclipped overflow scales with grapheme width.
	it("keeps every line ≤ width when input contains wide (emoji) characters", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "😀".repeat(30) });
		const width = 20;
		const lines = s.render(width);
		for (const l of lines) {
			expect(visibleWidth(l)).toBeLessThanOrEqual(width);
		}
	});

	// totalItemsForNumbering=1000 → numberWidth=4 → rowPrefix "❯    1. " = 8 cols.
	// Pins that wrapping uses post-prefix contentWidth, not full terminal width.
	it("keeps every line ≤ width when number column inflates the prefix", () => {
		const s = new OptionListView({ items: [...Array.from({ length: 999 }, (_, i) => ({ kind: "option" as const, label: String(i) })), { kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 999, focused: true, inputBuffer: "hello world" });
		const width = 12;
		const lines = s.render(width);
		for (const l of lines) {
			expect(visibleWidth(l)).toBeLessThanOrEqual(width);
		}
	});

	it("renders inline input row within width when input is empty", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const width = 12;
		const lines = s.render(width);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
	});

	it("renders cursor at end-of-buffer when no offset is set (default fallback)", () => {
		// When setInputCursorOffset is never called, cursor defaults to end-of-buffer
		// (identical to pre-fix behavior).
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "this input is long enough that it definitely wraps across multiple lines" });
		const lines = s.render(20);
		const cursorLines = lines.filter((l) => l.includes(CURSOR_MARKER));
		expect(cursorLines).toHaveLength(1);
		expect(lines[lines.length - 1]).toContain(CURSOR_MARKER);
	});

	// First line carries the row prefix ("❯ N. "); continuation lines are blank-padded
	// to the same column so wrapped input visually hangs under the start of the buffer.
	it("renders rowPrefix on first line and aligned continuation whitespace on wrapped lines", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "a".repeat(60) });
		const lines = s.render(20);
		expect(lines[0]?.startsWith("❯ 1. ")).toBe(true);
		// Continuation lines must NOT carry a numbered prefix and must start with the
		// same column-count of leading whitespace as the rowPrefix.
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i] ?? "";
			expect(line).not.toContain("❯");
			expect(line.startsWith("     ")).toBe(true); // "❯ 1. " = 5 cols
		}
	});

	// Every wrapped line of the inline input passes through theme.selectedText,
	// matching the per-line styling contract that renderLabelBlock honors.
	it("applies selectedText theme to every wrapped line of the inline input", () => {
		const marked: OptionListTheme = {
			selectedText: (t) => `\x1b[31m${t}\x1b[39m`,
			description: (t) => t,
			scrollInfo: (t) => t,
		};
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: marked });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "a".repeat(60) });
		const lines = s.render(20);
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) {
			expect(l.startsWith("\x1b[31m")).toBe(true);
			expect(l.endsWith("\x1b[39m")).toBe(true);
		}
	});
});

describe("OptionListView.render — cursor position via inputCursorOffset props", () => {
	it("renders cursor at position 0 (start of buffer)", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hello", inputCursorOffset: 0 });
		const lines = s.render(40);
		expect(lines[0]).toContain(`${cursorOn("h")}ello`);
	});

	it("renders cursor mid-string", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hello", inputCursorOffset: 2 });
		const lines = s.render(40);
		expect(lines[0]).toContain(`he${cursorOn("l")}lo`);
	});

	it("renders cursor at end of buffer", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hello", inputCursorOffset: 5 });
		const lines = s.render(40);
		expect(lines[0]).toContain(`hello${cursorOn(NBSP)}`);
	});

	it("falls back to end-of-buffer when offset is undefined", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hello" });
		// Don't call setInputCursorOffset — stays undefined
		const lines = s.render(40);
		expect(lines[0]).toContain(`hello${cursorOn(NBSP)}`);
	});

	it("wraps correctly with cursor mid-string on narrow width", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		// 11 chars > contentWidth 10 → wraps. Cursor REPLACES (does not insert), so the
		// reverse-video cell occupies the same column as `d` would; total visible width
		// is the same as the raw buffer. First wrapped segment fits 10 cols → "abcdefghij"
		// with `d` rendered in reverse video at column index 3. Last char `k` wraps.

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "abcdefghijk", inputCursorOffset: 3 });
		const narrowWidth = 15; // rowPrefix "❯ 1. " = 5 cols, contentWidth = 10
		const lines = s.render(narrowWidth);
		expect(lines[0]).toContain(`abc${cursorOn("d")}efghij`);
		expect(lines[0]).toContain(CURSOR_MARKER);
		// Every line must respect width invariant
		for (const l of lines) {
			expect(visibleWidth(l)).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("clamps negative offset to end-of-buffer fallback", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hello", inputCursorOffset: -1 });
		const lines = s.render(40);
		expect(lines[0]).toContain(`hello${cursorOn(NBSP)}`);
	});

	it("clamps offset exceeding buffer length to end-of-buffer fallback", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hello", inputCursorOffset: 99 });
		const lines = s.render(40);
		expect(lines[0]).toContain(`hello${cursorOn(NBSP)}`);
	});

	it("renders cursor on emoji without splitting surrogate pair", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "hi😀bye", inputCursorOffset: 2 });
		const lines = s.render(40);
		expect(lines[0]).toContain(`hi${cursorOn("😀")}bye`);
	});

	it("renders cursor on ZWJ emoji sequence without splitting the cluster", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		const family = "👨‍👩‍👧";

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: `a${family}b`, inputCursorOffset: 1 });
		const lines = s.render(40);
		expect(lines[0]).toContain(`a${cursorOn(family)}b`);
	});

	it("renders cursor at correct position with wrapping across multiple lines", () => {
		const s = new OptionListView({ items: [{ kind: "other", label: "pick" }], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "this is a very long input that will wrap", inputCursorOffset: 5 });
		const width = 20;
		const lines = s.render(width);
		// Cursor at position 5 in a long string → cursor appears on the first wrapped line
		expect(lines[0]).toContain(CURSOR_MARKER);
		// Width invariant
		for (const l of lines) {
			expect(visibleWidth(l)).toBeLessThanOrEqual(width);
		}
	});
});

describe("OptionListView.render — number column padding", () => {
	it("pads numbers to width of total count", () => {
		const items: QuestionRow[] = Array.from({ length: 12 }, (_, i) => ({
			kind: "option" as const,
			label: `r${i + 1}`,
		}));
		const s = new OptionListView({ items: items, maxVisible: 20, theme: identityTheme });

		const lines = s.render(40);
		expect(lines[0]).toContain(" 1. ");
		expect(lines[9]).toContain("10. ");
	});

});

describe("OptionListView.render — description block", () => {
	it("renders description lines under label", () => {
		const s = new OptionListView({ items: [{ kind: "option", label: "L", description: "desc-line" }], maxVisible: 2, theme: identityTheme });

		const lines = s.render(40);
		expect(lines.some((l) => l.includes("desc-line"))).toBe(true);
	});
	it("omits description block when absent", () => {
		const s = new OptionListView({ items: [{ kind: "option", label: "L" }], maxVisible: 1, theme: identityTheme });

		expect(s.render(40).length).toBe(1);
	});
});

// `setConfirmedIndex` powers the "✔ on previously-chosen row" indicator when the user
// navigates back to a tab they already answered. Pointer (`❯`) stays with the live cursor;
// the confirmed row gets the same accent+bold styling as the active row plus a trailing ` ✔`.
const markedTheme: OptionListTheme = {
	selectedText: (t) => `<S>${t}</S>`,
	description: (t) => t,
	scrollInfo: (t) => t,
};

describe("OptionListView confirmed props", () => {
	it("renders ` ✔` on the confirmed row in selectedText styling, no pointer", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "Alpha" },
				{ kind: "option", label: "Beta" },
				{ kind: "option", label: "Gamma" },
			], maxVisible: 10, theme: markedTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: { index: 1 } });
		const lines = s.render(40);
		expect(lines[0]).toContain("❯ 1. Alpha");
		expect(lines[1]).toContain("  2. Beta ✔");
		expect(lines[1]).toContain("<S>");
		expect(lines[1]).toContain("</S>");
		expect(lines[1]).not.toContain("❯");
		expect(lines[2]).toBe("  3. Gamma");
	});
	it("renders both ❯ and ✔ when cursor lands on the confirmed row (e.g. prior answer was row 0)", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "Alpha" },
				{ kind: "option", label: "Beta" },
			], maxVisible: 10, theme: markedTheme });

		s.setProps({ selectedIndex: 1, focused: true, inputBuffer: "", confirmed: { index: 1 } });
		const lines = s.render(40);
		expect(lines[1]).toContain("❯ 2. Beta ✔");
		expect(lines[1]).toContain("<S>");
	});
	it("undefined clears the marker (default behavior preserved)", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "A" },
				{ kind: "option", label: "B" },
			], maxVisible: 10, theme: markedTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: { index: 1 } });
		expect(s.render(40).join("\n")).toContain("✔");

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: undefined });
		const lines = s.render(40);
		expect(lines.join("\n")).not.toContain("✔");
	});
	it("labelOverride replaces the static label (e.g. `Hello ✔` on kind:'other' row)", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "Alpha" },
				{ kind: "option", label: "Beta" },
				{ kind: "other", label: "Type something." },
			], maxVisible: 10, theme: markedTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: { index: 2, labelOverride: "Hello" } });
		const lines = s.render(40);
		expect(lines[2]).toContain("Hello ✔");
		expect(lines[2]).not.toContain("Type something.");
		expect(lines[2]).toContain("<S>");
	});
	it("when focused on kind:'other' row, inline-input rendering wins over confirmed marker", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "Alpha" },
				{ kind: "other", label: "Type something." },
			], maxVisible: 10, theme: markedTheme });

		s.setProps({ selectedIndex: 1, focused: true, inputBuffer: "World", confirmed: { index: 1, labelOverride: "Hello" } });
		const lines = s.render(40);
		expect(lines[1]).toContain("World");
		expect(lines[1]).toContain(CURSOR_MARKER);
		expect(lines[1]).not.toContain("✔");
	});
	it("clamps index to valid range", () => {
		const s = new OptionListView({ items: [
				{ kind: "option", label: "A" },
				{ kind: "option", label: "B" },
			], maxVisible: 10, theme: markedTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: { index: 99 } });
		const lines = s.render(40);
		expect(lines[1]).toContain("B ✔");
	});
	it("respects width — wrappable label + ` ✔` does not exceed width per line", () => {
		// Use identityTheme so the test theme markers don't inflate visibleWidth.
		const wrappable = "alpha beta gamma delta epsilon zeta eta theta";
		const s = new OptionListView({ items: [
				{ kind: "option", label: "A" },
				{ kind: "option", label: wrappable },
			], maxVisible: 10, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: { index: 1 } });
		const width = 20;
		const lines = s.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(lines.some((l) => l.includes("✔"))).toBe(true);
	});
});

describe("OptionListView.focusedItemRowRange", () => {
	it("returns [0, 0] for empty items", () => {
		const s = new OptionListView({ items: [], maxVisible: 10, theme: identityTheme });

		const [start, end] = s.focusedItemRowRange(40);
		expect(start).toBe(0);
		expect(end).toBe(0);
	});

	it("returns [0, 1] for single item focused at index 0", () => {
		const s = new OptionListView({ items: [{ kind: "option", label: "A" }], maxVisible: 10, theme: identityTheme });

		const [start, end] = s.focusedItemRowRange(40);
		expect(start).toBe(0);
		expect(end).toBe(1);
	});

	it("returns correct range for focused item at index 1", () => {
		const items: QuestionRow[] = [
			{ kind: "option", label: "A" },
			{ kind: "option", label: "B" },
		];
		const s = new OptionListView({ items: items, maxVisible: 10, theme: identityTheme });

		s.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		const [start, end] = s.focusedItemRowRange(40);
		expect(start).toBe(1);
		expect(end).toBe(2);
	});

	it("accounts for description rows in item before focused", () => {
		const items: QuestionRow[] = [
			{ kind: "option", label: "A", description: "multi-word description text that is moderately long" },
			{ kind: "option", label: "B" },
		];
		const s = new OptionListView({ items: items, maxVisible: 10, theme: identityTheme });

		s.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		const [start, end] = s.focusedItemRowRange(40);
		// Item A = 1 label + N description rows → start > 1
		expect(start).toBeGreaterThan(1);
		expect(end).toBe(start + 1);
	});

	it("accounts for focused item's own description rows", () => {
		const items: QuestionRow[] = [
			{ kind: "option", label: "A" },
			{ kind: "option", label: "B", description: "desc text" },
			{ kind: "option", label: "C" },
		];
		const s = new OptionListView({ items: items, maxVisible: 10, theme: identityTheme });

		s.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		const [start, end] = s.focusedItemRowRange(40);
		expect(start).toBe(1);
		expect(end).toBeGreaterThan(start + 1);
	});

	it("handles items in visible window (windowed)", () => {
		const items: QuestionRow[] = Array.from({ length: 20 }, (_, i) => ({
			kind: "option" as const,
			label: `row-${i + 1}`,
		}));
		const s = new OptionListView({ items: items, maxVisible: 5, theme: identityTheme });

		s.setProps({ selectedIndex: 10, focused: true, inputBuffer: "" });
		const [start, end] = s.focusedItemRowRange(40);
		// Window centered on index 10: indices 8..12. Items 8,9 before focused = 2 rows.
		expect(start).toBe(2);
		expect(end).toBe(3);
	});

	it("range matches actual rendered output position", () => {
		const items: QuestionRow[] = [
			{ kind: "option", label: "A", description: "a longer description that may wrap around" },
			{ kind: "option", label: "B" },
			{ kind: "option", label: "C" },
		];
		const s = new OptionListView({ items: items, maxVisible: 10, theme: identityTheme });

		s.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		const [start, end] = s.focusedItemRowRange(30);
		const rendered = s.render(30);
		expect(rendered[start]).toContain("B");
		expect(rendered[end - 1]).not.toContain("C");
	});
});

describe("QuestionRow.kind contract — exhaustive", () => {
	const allKinds: QuestionRow[] = [
		{ kind: "option", label: "opt" },
		{ kind: "other", label: "Type something." },
		{ kind: "next", label: "Next" },
	];

	it.each(allKinds)("shouldRenderAsInlineInput is true only for kind 'other' when active", (item) => {
		const s = new OptionListView({ items: [item], maxVisible: 1, theme: identityTheme });

		s.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = s.render(20);
		const isOther = item.kind === "other";
		const hasInputCursor = lines.some((l) => l.includes(CURSOR_MARKER));
		expect(hasInputCursor).toBe(isOther);
	});
});

describe("OptionListView narrow input", () => {
	it("keeps the caret and respects widths smaller than the numbered prefix", () => {
		const view = new OptionListView({ items: [{ kind: "other", label: "Type something." }], theme: identityTheme });
		view.setProps({ selectedIndex: 0, focused: true, inputBuffer: "界😀answer" });
		for (const width of [1, 4, 5, 6, 8]) {
			const lines = view.render(width);
			expect(lines.filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
