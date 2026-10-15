import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderInlineInputRow } from "./inline-input.ts";

const cursorOn = (ch: string) => `${CURSOR_MARKER}\x1b[7m${ch}\x1b[27m`;
const NBSP = "\xa0";
const id = (text: string) => text;

const opts = (buffer: string, cursorOffset: number | undefined, contentWidth: number) => ({
	buffer,
	cursorOffset,
	rowPrefix: "❯ 1. ",
	continuationPrefix: "     ",
	contentWidth,
	selectedText: id,
});

describe("renderInlineInputRow", () => {
	it.each([
		["😀", 0], ["😀", 1], ["👨‍👩‍👧‍👦", 2], ["e\u0301", 1],
	])("keeps the complete grapheme %s under the cursor at offset %i", (grapheme, within) => {
		const lines = renderInlineInputRow(opts(`hi${grapheme}bye`, 2 + within, 40));
		expect(lines[0]).toContain(`hi${cursorOn(grapheme)}bye`);
	});

	it("uses a visible cursor cell at end-of-buffer", () => {
		const lines = renderInlineInputRow(opts("hello", undefined, 40));
		expect(lines[0]).toContain(`hello${cursorOn(NBSP)}`);
	});

	it("wraps long logical lines within the available width", () => {
		const lines = renderInlineInputRow(opts("a".repeat(60), 60, 15));
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]?.startsWith("❯ 1. ")).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});

	it("preserves explicit newlines and draws the cursor at a logical line end", () => {
		const lines = renderInlineInputRow(opts("first\nsecond", 5, 40));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`first${cursorOn(NBSP)}`);
		expect(lines[1]).toContain("second");
	});
});
