import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import {
	buildItemsForQuestion,
	buildQuestionnaireResponse,
	buildToolResult,
	registerAskUserQuestionTool,
} from "./ask-user-question.ts";
import { makeQuestion } from "./test-fixtures.ts";
import { prepareQuestionArguments } from "./tool/normalize-params.ts";
import type { QuestionAnswer, QuestionnaireResult } from "./tool/types.ts";

const params = { questions: [makeQuestion({ question: "Pick?", header: "Different header" })] };
const suffix = "You can now continue with the user's answers in mind.";

describe("questionnaire protocol", () => {
	it.each([false, true])("preserves options and appends ordered sentinels (multiSelect=%s)", multiSelect => {
		const items = buildItemsForQuestion(makeQuestion({
			multiSelect,
			options: [
				{ label: "A", description: "a", preview: "## Preview" },
				{ label: "B", description: "b" },
			],
		}));
		expect(items).toEqual([
			{ kind: "option", label: "A", description: "a" },
			{ kind: "option", label: "B", description: "b" },
			{ kind: "other", label: "Type something." },
			...(multiSelect ? [{ kind: "next", label: "Next" }] : []),
		]);
	});

	it.each([null, undefined, { cancelled: false, answers: [] }])("declines an absent or unanswered result: %j", result => {
		expect(buildQuestionnaireResponse(result, params)).toEqual({
			content: [{ type: "text", text: "User declined to answer questions" }],
			details: { answers: [], cancelled: true },
		});
	});

	it("declines cancellation while preserving partial answers and the optional global note", () => {
		const answers: QuestionAnswer[] = [{ questionIndex: 0, question: "Pick?", kind: "option", answer: "A" }];
		for (const globalNote of [undefined, "kept for replay"]) {
			const result: QuestionnaireResult = { cancelled: true, answers, ...(globalNote ? { globalNote } : {}) };
			expect(buildQuestionnaireResponse(result, params)).toEqual({
				content: [{ type: "text", text: "User declined to answer questions" }],
				details: result,
			});
		}
	});

	const formats: Array<[Omit<QuestionAnswer, "questionIndex" | "question">, string]> = [
		[{ kind: "option", answer: "A" }, '"Pick?"="A".'],
		[{ kind: "custom", answer: "my custom" }, '"Pick?"="my custom".'],
		[{ kind: "custom", answer: null }, '"Pick?"="(no input)".'],
		[{ kind: "multi", selected: ["FE", "BE"], answer: "Docs" }, '"Pick?"="FE, BE, Docs".'],
		[{ kind: "multi", selected: ["FE", "BE"], answer: null, notes: "both" },
			'"Pick?"="FE, BE". user notes: both.'],
		[{ kind: "option", answer: "A", preview: "## Centered\n\nbody", notes: "because of X" },
			'"Pick?"="A". selected preview: ## Centered\n\nbody. user notes: because of X.'],
	];
	it.each(formats)("formats %j inside the exact envelope", (answer, segment) => {
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Pick?", ...answer }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content).toEqual([{ type: "text", text: `User has answered your questions: ${segment} ${suffix}` }]);
		expect(r.details).toBe(result);
		expect("unanswered" in r.details).toBe(false);
	});

	it("orders mixed answers by question and preserves per-question notes in details", () => {
		const questions = ["Q1?", "Q2?", "Q3?"].map(question => makeQuestion({ question }));
		const result: QuestionnaireResult = { cancelled: false, answers: [
			{ questionIndex: 2, question: "Q3?", kind: "multi", selected: ["FE", "BE"], answer: null },
			{ questionIndex: 0, question: "Q1?", kind: "option", answer: "A", notes: "n1" },
			{ questionIndex: 1, question: "Q2?", kind: "custom", answer: "my own thing", notes: "n2" },
		] };
		const r = buildQuestionnaireResponse(result, { questions });
		expect(r.content[0].text).toBe(
			'User has answered your questions: "Q1?"="A". user notes: n1. ' +
			'"Q2?"="my own thing". user notes: n2. "Q3?"="FE, BE". ' + suffix,
		);
		expect(r.details).toBe(result);
	});

	it("appends a raw multiline global note before the envelope suffix", () => {
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Pick?", kind: "option", answer: "A" }],
			globalNote: "ship it\nFriday",
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toBe('User has answered your questions: "Pick?"="A". global note: ship it\nFriday. ' + suffix);
		expect(r.details).toBe(result);
	});

	it.each([false, true])("names unanswered questions and puts the global note last (noteOnly=%s)", noteOnly => {
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: noteOnly ? [] : [{ questionIndex: 1, question: "Q2?", kind: "option", answer: "B" }],
			globalNote: "later",
		};
		const questions = ["Q1?", "Q2?"].map(question => makeQuestion({ question }));
		const r = buildQuestionnaireResponse(result, { questions });
		expect(r.content[0].text).toBe("User has answered your questions: " +
			(noteOnly ? 'unanswered: "Q1?", "Q2?".' : '"Q2?"="B". unanswered: "Q1?".') +
			" global note: later. " + suffix);
		expect(r.details).toEqual({ ...result, unanswered: noteOnly ? [0, 1] : [0] });
	});

	it("reports partial submission without a global note", () => {
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 1, question: "Q2?", kind: "option", answer: "B" }],
		};
		const questions = ["Q1?", "Q2?"].map(question => makeQuestion({ question }));
		const r = buildQuestionnaireResponse(result, { questions });
		expect(r.content[0].text).toBe('User has answered your questions: "Q2?"="B". unanswered: "Q1?". ' + suffix);
		expect(r.details).toEqual({ ...result, unanswered: [0] });
	});

	it("builds the tool envelope and keeps error details by reference", () => {
		const details: QuestionnaireResult = { answers: [], cancelled: true, error: "no_questions" };
		const r = buildToolResult("msg", details);
		expect(r).toEqual({ content: [{ type: "text", text: "msg" }], details });
		expect(r.details).toBe(details);
	});

	it("registers argument repair before Pi schema validation", () => {
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		expect(captured.tools.get("ask_user_question")?.prepareArguments).toBe(prepareQuestionArguments);
	});
});
