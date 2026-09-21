// Goal state derived from mitsuhiko/agent-stuff @122e299 (Apache-2.0).
// See LICENSE-APACHE-2.0 and NOTICE. Host events, messages and persistence live in extensions/goal.ts.

import { randomUUID } from "node:crypto";

export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

const MAX_OBJECTIVE_CHARS = 4_000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function charCount(value: string): number {
  return [...value].length;
}

export function validateObjective(input: string): string {
  const objective = input.trim();
  if (!objective) {
    throw new Error("goal objective must not be empty");
  }
  if (charCount(objective) > MAX_OBJECTIVE_CHARS) {
    throw new Error(
      `Goal objective is too long: ${charCount(objective).toLocaleString()} characters. Limit: ${MAX_OBJECTIVE_CHARS.toLocaleString()} characters. Put longer instructions in a file and refer to that file in the goal, for example: /goal follow the instructions in docs/goal.md.`,
    );
  }
  return objective;
}

function validateTokenBudget(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("goal budgets must be positive integers when provided");
  }
  return value;
}

function normalizeStatus(value: unknown): GoalStatus {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "complete":
      return value;
    case "usageLimited":
    case "usage_limited":
      return "usageLimited";
    case "budgetLimited":
    case "budget_limited":
      return "budgetLimited";
    default:
      return "active";
  }
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeGoal(value: unknown): Goal | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Goal> & Record<string, unknown>;
  const objective = typeof raw.objective === "string" ? raw.objective : "";
  if (!objective.trim()) return null;
  const tokenBudget = typeof raw.tokenBudget === "number" && Number.isFinite(raw.tokenBudget) && raw.tokenBudget > 0
    ? Math.floor(raw.tokenBudget)
    : undefined;
  const ts = nowSeconds();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
    objective,
    status: normalizeStatus(raw.status),
    tokenBudget,
    tokensUsed: normalizeNonNegativeInteger(raw.tokensUsed),
    timeUsedSeconds: normalizeNonNegativeInteger(raw.timeUsedSeconds),
    createdAt: normalizeNonNegativeInteger(raw.createdAt, ts),
    updatedAt: normalizeNonNegativeInteger(raw.updatedAt, ts),
  };
}


function assistantUsageTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const msg = message as {
      role?: string;
      usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
    };
    if (msg.role !== "assistant" || !msg.usage) continue;
    const input = Math.max(0, msg.usage.input ?? 0);
    const cacheRead = Math.max(0, msg.usage.cacheRead ?? 0);
    const output = Math.max(0, msg.usage.output ?? 0);
    const measured = Math.max(0, input - cacheRead) + output;
    total += measured > 0 ? measured : Math.max(0, msg.usage.totalTokens ?? 0);
  }
  return total;
}


/** Owns goal state, clocks and turn accounting. It performs no host I/O. */
export class GoalState {
  #goal: Goal | null = null;
  #activeSinceMs: number | null = null;
  #startedGoalId: string | null = null;
  continuationQueued = false;

  get current(): Readonly<Goal> | null { return this.#goal; }

  snapshot(): Goal | null {
    if (!this.#goal) return null;
    const snapshot = { ...this.#goal };
    if (snapshot.status === "active" && this.#activeSinceMs !== null) {
      snapshot.timeUsedSeconds += Math.max(0, Math.floor((Date.now() - this.#activeSinceMs) / 1000));
    }
    return snapshot;
  }

  #accountElapsed(): boolean {
    if (this.#goal?.status !== "active" || this.#activeSinceMs === null) return false;
    const seconds = Math.max(0, Math.floor((Date.now() - this.#activeSinceMs) / 1000));
    if (seconds <= 0) return false;
    this.#goal.timeUsedSeconds += seconds;
    this.#goal.updatedAt = nowSeconds();
    this.#activeSinceMs += seconds * 1000;
    return true;
  }

  create(objectiveInput: string, tokenBudgetInput?: number): void {
    const objective = validateObjective(objectiveInput);
    const tokenBudget = validateTokenBudget(tokenBudgetInput);
    const ts = nowSeconds();
    this.#goal = { id: randomUUID(), objective, status: "active", tokenBudget,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: ts, updatedAt: ts };
    this.#activeSinceMs = Date.now();
    this.continuationQueued = false;
  }

  edit(objectiveInput: string): void {
    if (!this.#goal) throw new Error("cannot edit goal because no goal exists");
    const objective = validateObjective(objectiveInput);
    this.#accountElapsed();
    const status = this.#goal.status;
    this.transition(status === "complete" || status === "budgetLimited" ? "active" : status);
    this.#goal.objective = objective;
  }

  transition(status: GoalStatus): void {
    if (!this.#goal) throw new Error("cannot update goal because no goal exists");
    const wasActive = this.#goal.status === "active";
    if (wasActive && status !== "active") {
      this.#accountElapsed();
      this.#activeSinceMs = null;
    }
    if (status === "active" && !wasActive) this.#activeSinceMs = Date.now();
    if (status !== "active" || !wasActive) this.continuationQueued = false;
    this.#goal.status = status;
    this.#goal.updatedAt = nowSeconds();
  }

  clear(): boolean {
    const hadGoal = this.#goal !== null;
    this.#accountElapsed();
    this.restore([]);
    return hadGoal;
  }

  restore(entries: readonly { type: string; customType?: string; data?: unknown }[]): void {
    this.#goal = null;
    this.#activeSinceMs = null;
    this.#startedGoalId = null;
    this.continuationQueued = false;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "goal") {
        this.#goal = normalizeGoal((entry.data as { goal?: unknown } | undefined)?.goal);
      }
    }
    if (this.#goal?.status === "active") this.#activeSinceMs = Date.now();
  }

  startTurn(): void {
    this.continuationQueued = false;
    this.#startedGoalId = this.#goal?.status === "active" ? this.#goal.id : null;
  }

  accountTurn(messages: unknown[]): { changed: boolean; limited: boolean } {
    if (!this.#goal) return { changed: false, limited: false };
    let changed = false;
    if (this.#startedGoalId === this.#goal.id) {
      const tokens = assistantUsageTokens(messages);
      if (tokens > 0) {
        this.#goal.tokensUsed += tokens;
        this.#goal.updatedAt = nowSeconds();
        changed = true;
      }
    }
    if (this.#accountElapsed()) changed = true;
    const limited = this.#goal.status === "active" && this.#goal.tokenBudget !== undefined
      && this.#goal.tokensUsed >= this.#goal.tokenBudget;
    if (limited) this.transition("budgetLimited");
    return { changed: changed || limited, limited };
  }

  finishTurn(): void { this.#startedGoalId = null; }
}
