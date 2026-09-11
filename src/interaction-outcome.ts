// Interaction outcome — "did the RUN finish normally" separated from "did
// every business step succeed". Replaces the old sticky lastRunFailed flag,
// where any single tool error permanently branded the whole interaction.
//
// Evidence model (host events only, Pi v0.85.1 semantics):
//   - each assistant message is one provider attempt; message_start opens it
//     (re-announcements of an unfinished attempt do NOT open a new one);
//   - message_end stopReason is terminal evidence: stop=completed,
//     error=failed, aborted=interrupted, length=incomplete;
//     toolUse/deferred are NON-terminal (the loop continues);
//   - tool_execution_end isError only increments toolErrorsObserved — it is
//     never termination evidence in either direction;
//   - agent_settled freezes the verdict. The HIGHEST attempt with terminal
//     evidence wins, so a late error from an OLD request cannot override a
//     newer clean stop (retry/continuation semantics). An attempt that started
//     but never ended at settle time yields unknown — never guessed success.
// No text semantics: the words "完成"/"Failed" in output are not evidence.

export type InteractionOutcome = "completed" | "failed" | "interrupted" | "incomplete" | "unknown";

export type TerminalEvidence =
  | "assistant-stop"
  | "assistant-error"
  | "assistant-aborted"
  | "assistant-length"
  | "settled-only";

export interface OutcomeVerdict {
  outcome: InteractionOutcome;
  evidence: TerminalEvidence;
  /** Human-readable, diagnostics-safe reason (no message bodies). */
  reason: string;
  /** 1-based attempt sequence the verdict is based on. */
  attempt: number;
  toolErrorsObserved: number;
}

const OUTCOME_BY_STOP: Record<string, { outcome: Exclude<InteractionOutcome, "unknown">; evidence: TerminalEvidence }> = {
  stop: { outcome: "completed", evidence: "assistant-stop" },
  error: { outcome: "failed", evidence: "assistant-error" },
  aborted: { outcome: "interrupted", evidence: "assistant-aborted" },
  length: { outcome: "incomplete", evidence: "assistant-length" },
};

export class InteractionOutcomeTracker {
  #attempt = 0;
  /** attempt seq → terminal outcome for that attempt. */
  #terminals = new Map<number, { outcome: Exclude<InteractionOutcome, "unknown">; evidence: TerminalEvidence }>();
  #toolErrors = 0;
  #frozen: OutcomeVerdict | undefined;

  /** message_start: open a new attempt only when the previous one already
   * reached a terminal (a retry/continuation) — re-announced in-flight
   * messages must not inflate the sequence. */
  messageStart(role: string): void {
    if (role !== "assistant") return;
    if (this.#attempt === 0 || this.#terminals.has(this.#attempt)) {
      this.#attempt += 1;
    }
  }

  /** message_end terminal evidence for the current attempt. Non-terminal
   * stopReasons (toolUse/deferred/pending) are recorded only implicitly.
   * A terminal without any seen message_start still counts (attempt 1) —
   * evidence must never be dropped for event-order quirks. */
  terminalStop(stopReason: string): void {
    const mapped = OUTCOME_BY_STOP[stopReason];
    if (!mapped) return;
    if (this.#attempt === 0) this.#attempt = 1;
    this.#terminals.set(this.#attempt, mapped);
  }

  /** tool_execution_end isError — diagnostic count ONLY. */
  toolError(): void {
    this.#toolErrors += 1;
  }

  /** agent_settled: freeze the verdict for this interaction. */
  freeze(): OutcomeVerdict {
    if (this.#frozen) return this.#frozen;
    let verdict: OutcomeVerdict;
    let lastTerminalAttempt = 0;
    for (const seq of this.#terminals.keys()) {
      if (seq > lastTerminalAttempt) lastTerminalAttempt = seq;
    }
    if (lastTerminalAttempt > 0 && lastTerminalAttempt === this.#attempt) {
      const terminal = this.#terminals.get(lastTerminalAttempt)!;
      verdict = {
        outcome: terminal.outcome,
        evidence: terminal.evidence,
        reason: `final assistant attempt ${lastTerminalAttempt} stopReason=${terminal.evidence.replace("assistant-", "")}`,
        attempt: lastTerminalAttempt,
        toolErrorsObserved: this.#toolErrors,
      };
    } else if (lastTerminalAttempt > 0) {
      // A newer attempt started but never ended — the older terminal is stale
      // evidence for a run that went on; the ending is genuinely unknown.
      verdict = {
        outcome: "unknown",
        evidence: "settled-only",
        reason: `attempt ${this.#attempt} unfinished at settle (older attempt ${lastTerminalAttempt} terminal ignored)`,
        attempt: this.#attempt,
        toolErrorsObserved: this.#toolErrors,
      };
    } else {
      verdict = {
        outcome: "unknown",
        evidence: "settled-only",
        reason: this.#attempt === 0
          ? "agent_settled without any assistant attempt"
          : `agent_settled without terminal evidence (last attempt ${this.#attempt} non-terminal)`,
        attempt: this.#attempt,
        toolErrorsObserved: this.#toolErrors,
      };
    }
    this.#frozen = verdict;
    return verdict;
  }

  /** True once agent_settled froze the verdict (duplicate settles never
   * re-freeze, so summaries append exactly once). */
  get frozen(): boolean {
    return this.#frozen !== undefined;
  }

  get toolErrorsObserved(): number {
    return this.#toolErrors;
  }

  get attemptCount(): number {
    return this.#attempt;
  }

  /** New interaction / session boundary: no sticky state may leak across. */
  reset(): void {
    this.#attempt = 0;
    this.#terminals.clear();
    this.#toolErrors = 0;
    this.#frozen = undefined;
  }
}
