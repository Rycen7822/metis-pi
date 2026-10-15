import type { QuestionAnswer } from "./types.ts";

export const NO_INPUT_PLACEHOLDER = "(no input)";

/** Custom/multi empty input uses a placeholder; an option's empty label stays empty. */
export function formatAnswerScalar(a: QuestionAnswer): string {
	switch (a.kind) {
		case "multi": {
			const values = [...(a.selected ?? [])];
			if (a.answer && a.answer.length > 0) values.push(a.answer);
			return values.length > 0 ? values.join(", ") : NO_INPUT_PLACEHOLDER;
		}
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
	}
}
