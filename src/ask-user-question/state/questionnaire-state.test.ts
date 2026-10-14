import { describe, expect, it } from "vitest";
import type { QuestionAnswer } from "../tool/types.ts";
import { itemsRegular, itemsWithOther, makeQuestion as q } from "../test-fixtures.ts";
import { selectActivePreviewPaneIndex, selectConfirmedIndicator, selectSavedNote } from "./selectors/derivations.ts";
import { selectActiveView } from "./selectors/focus.ts";

describe("selectConfirmedIndicator", () => {
	it("returns undefined when the question is multiSelect", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }],
		]);
		expect(selectConfirmedIndicator([q({ multiSelect: true })], 0, answers, itemsRegular)).toBeUndefined();
	});

	it("returns undefined when there is no prior answer for the tab", () => {
		expect(selectConfirmedIndicator([q()], 0, new Map(), itemsRegular)).toBeUndefined();
	});

	it("returns the kind:'other' index + labelOverride when the prior answer was kind:'custom'", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "custom", answer: "Hello" }],
		]);
		expect(selectConfirmedIndicator([q()], 0, answers, itemsWithOther)).toEqual({ index: 2, labelOverride: "Hello" });
	});

	it("returns undefined when kind:'custom' but the items array has no kind:'other' row", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "custom", answer: "Hello" }],
		]);
		expect(selectConfirmedIndicator([q()], 0, answers, itemsRegular)).toBeUndefined();
	});

	it("returns the matching index for a regular label answer", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "B" }],
		]);
		expect(selectConfirmedIndicator([q()], 0, answers, itemsRegular)).toEqual({ index: 1 });
	});

	it("returns undefined when the prior label matches no row (defensive)", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "ZZ" }],
		]);
		expect(selectConfirmedIndicator([q()], 0, answers, itemsRegular)).toBeUndefined();
	});
});

describe("selectActivePreviewPaneIndex", () => {
	it("returns currentTab when within range", () => {
		expect(selectActivePreviewPaneIndex(1, 3)).toBe(1);
	});
	it("clamps to the last question index when on the Submit tab", () => {
		expect(selectActivePreviewPaneIndex(3, 3)).toBe(2);
	});
	it("returns 0 when totalQuestions is 0 (defensive)", () => {
		expect(selectActivePreviewPaneIndex(0, 0)).toBe(0);
	});
});

describe("selectActiveView", () => {
	it.each([
		[true, 0, "notes"], [true, 2, "notes"],
		[false, 2, "submit"], [false, 0, "options"],
	] as const)("chooses the active view (notes=%s, tab=%i)", (notesVisible, currentTab, expected) => {
		expect(selectActiveView({ notesVisible, currentTab }, 2)).toBe(expected);
	});
});

describe("selectSavedNote (#197)", () => {
	const answered = new Map([
		[0, { questionIndex: 0, question: "Q", kind: "option" as const, answer: "A", notes: "on answer" }],
	]);

	it("prefers the in-flight side-band over the answer's mirror", () => {
		expect(selectSavedNote(new Map([[0, "in flight"]]), answered, 0)).toBe("in flight");
	});

	it("falls back to the answer's note", () => {
		expect(selectSavedNote(new Map(), answered, 0)).toBe("on answer");
	});

	it("a note saved before answering lives only in the side-band", () => {
		expect(selectSavedNote(new Map([[1, "early note"]]), new Map(), 1)).toBe("early note");
	});

	it("a cleared side-band note hides the answer's stale mirror", () => {
		expect(selectSavedNote(new Map([[0, ""]]), answered, 0)).toBeUndefined();
	});

	it("is undefined when the tab has no note", () => {
		expect(selectSavedNote(new Map(), new Map(), 0)).toBeUndefined();
	});
});
