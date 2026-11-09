import type { QuestionnaireResult, QuestionParams } from "./types.ts";

// One deadline for the entire questionnaire, including tab/dialog transitions.
const SKIP_TIMEOUT_MS = 10 * 60 * 1000;
export const QUESTIONNAIRE_TIMEOUT = Symbol("questionnaire-timeout");

/** Abort the mounted UI on timeout; await its cleanup before returning to the agent. */
export async function waitForQuestionnaire(
	params: QuestionParams,
	signal: AbortSignal | undefined,
	open: (signal: AbortSignal | undefined) => Promise<QuestionnaireResult | undefined>,
): Promise<QuestionnaireResult | undefined> {
	signal?.throwIfAborted();
	const timeout = params.mode === "skip" ? new AbortController() : undefined;
	const waitingSignal = timeout ? AbortSignal.any(signal ? [signal, timeout.signal] : [timeout.signal]) : signal;
	const timer = timeout ? setTimeout(() => timeout.abort(QUESTIONNAIRE_TIMEOUT), SKIP_TIMEOUT_MS) : undefined;
	try {
		const result = await open(waitingSignal);
		signal?.throwIfAborted();
		return result;
	} catch (error) {
		// Tool/session cancellation remains an abort, even when it coincides with the deadline.
		signal?.throwIfAborted();
		if (error !== QUESTIONNAIRE_TIMEOUT || !timeout?.signal.aborted) throw error;
		return { answers: [], cancelled: true, timedOut: true };
	} finally {
		clearTimeout(timer);
	}
}
