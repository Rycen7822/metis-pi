import { describe, expect, it } from "vitest";
import type { QuestionData } from "../tool/types.ts";
import { sentinelsToAppend } from "./row-intent.ts";

describe("sentinelsToAppend walker", () => {
	const baseSingle: QuestionData = {
		question: "Q?",
		header: "H",
		options: [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
		],
	};
	const baseMulti: QuestionData = { ...baseSingle, multiSelect: true };

	it("appends `other` for single-select regardless of preview", () => {
		expect(sentinelsToAppend(baseSingle)).toEqual(["other"]);
	});

	it("appends `other` + `next` for multi-select (other no longer suppressed)", () => {
		expect(sentinelsToAppend(baseMulti)).toEqual(["other", "next"]);
	});
});
