import type { QuestionData } from "../tool/types.ts";

/** Interaction rows are independent of their renderer. */
export interface QuestionRow {
	kind: "option" | "other" | "next";
	label: string;
	description?: string;
}

export type SentinelKind = Exclude<QuestionRow["kind"], "option">;

export function sentinelsToAppend(question: QuestionData): SentinelKind[] {
	return question.multiSelect ? ["other", "next"] : ["other"];
}
