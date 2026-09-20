// Normalize the codex app-server `account/rateLimits/read` result (camelCase
// shape, verified against codex-cli 0.154.0: rateLimits.primary =
// {usedPercent, windowDurationMins, resetsAt}, credits, rateLimitsByLimitId)
// into the display snapshot. Boundary-validated: unknown shapes degrade to
// missing fields, never NaN; remainingPercent is derived, never echoed.

import { remainingPercent, type CodexQuotaSnapshot, type CodexQuotaWindow } from "./types.ts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 0..100 with tolerance: out-of-range values clamp (a provider bug must not
 * produce a nonsense display, e.g. 180% used). */
function normalizeWindow(raw: unknown): CodexQuotaWindow | undefined {
  const record = asObject(raw);
  if (!record) return undefined;
  const used = asNumber(record.usedPercent);
  if (used === undefined) return undefined;
  const clampedUsed = Math.max(0, Math.min(100, used));
  const window: CodexQuotaWindow = {
    usedPercent: clampedUsed,
    remainingPercent: remainingPercent(clampedUsed),
  };
  const minutes = asNumber(record.windowDurationMins);
  if (minutes !== undefined && minutes > 0) window.windowMinutes = minutes;
  const resetsAt = asNumber(record.resetsAt);
  if (resetsAt !== undefined && resetsAt > 0) window.resetsAt = resetsAt;
  return window;
}

function normalizeCredits(raw: unknown): CodexQuotaSnapshot["credits"] {
  const record = asObject(raw);
  if (!record) return undefined;
  const hasCredits = asBoolean(record.hasCredits);
  const unlimited = asBoolean(record.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  const balance = asString(record.balance);
  return { hasCredits, unlimited, ...(balance ? { balance } : {}) };
}

/** Normalize the `account/rateLimits/read` result. Returns undefined when the
 * payload carries no displayable window (shown as "no data", not fake 0%). */
export function normalizeAppServerRateLimits(result: unknown, capturedAt: number): CodexQuotaSnapshot | undefined {
  const root = asObject(result);
  if (!root) return undefined;
  const raw = asObject(root.rateLimits) ?? {};
  const primary = normalizeWindow(raw.primary);
  const secondary = normalizeWindow(raw.secondary);
  const credits = normalizeCredits(raw.credits);
  if (!primary && !secondary && !credits) return undefined;
  const snapshot: CodexQuotaSnapshot = { capturedAt };
  const planType = asString(raw.planType);
  if (planType) snapshot.planType = planType;
  if (primary) snapshot.primary = primary;
  if (secondary) snapshot.secondary = secondary;
  if (credits) snapshot.credits = credits;
  return snapshot;
}
