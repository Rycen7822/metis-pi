// Quota display types. `remainingPercent` is ALWAYS derived as
// clamp(0, 100, 100 - usedPercent) — the two directions must never be mixed
// (a "used" number must never render as remaining).

export interface CodexQuotaWindow {
  usedPercent: number;
  remainingPercent: number;
  /** Rate-limit window length in minutes, when the source reports it. */
  windowMinutes?: number;
  /** Epoch seconds when the window resets, when reported. */
  resetsAt?: number;
}

export interface CodexQuotaCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexQuotaSnapshot {
  capturedAt: number; // wall clock ms
  planType?: string;
  /** Primary (short) window — the "Codex 5h 82%" line. */
  primary?: CodexQuotaWindow;
  /** Secondary (weekly) window. */
  secondary?: CodexQuotaWindow;
  credits?: CodexQuotaCredits;
}

/** Bounded error classes — diagnostics show the CLASS, never the raw body. */
export type QuotaErrorClass =
  | "codex-missing"
  | "startup-timeout"
  | "rpc-timeout"
  | "rpc-error"
  | "early-exit"
  | "no-data";

export interface QuotaState {
  /** Last successfully normalized snapshot (undefined = never succeeded). */
  quota: CodexQuotaSnapshot | undefined;
  /** True when the last refresh failed and `quota` may be outdated. */
  stale: boolean;
  lastErrorClass: QuotaErrorClass | undefined;
  lastErrorAt: number | undefined;
  lastSuccessAt: number | undefined;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function remainingPercent(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}

/** "300 min → 5h · 10080 min → week · else 30m / 3h / 2d". */
export function windowLabel(windowMinutes: number | undefined): string | undefined {
  if (windowMinutes === undefined || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return undefined;
  if (windowMinutes === 10080) return "week";
  if (windowMinutes === 43200) return "month";
  if (windowMinutes < 60) return `${Math.round(windowMinutes)}m`;
  if (windowMinutes < 1440) {
    const hours = windowMinutes / 60;
    return `${Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10}h`;
  }
  const days = windowMinutes / 1440;
  return `${Number.isInteger(days) ? days : Math.round(days * 10) / 10}d`;
}

/** "Codex 5h 82% · week 64%" / "Codex 5h 82%" / "Codex ∞" / undefined. */
export function formatQuotaLine(snapshot: CodexQuotaSnapshot | undefined, stale: boolean): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.credits?.unlimited) return stale ? undefined : "Codex ∞";
  const parts: string[] = [];
  const primary = snapshot.primary;
  if (primary) {
    const label = windowLabel(primary.windowMinutes) ?? "Codex";
    parts.push(`Codex ${label} ${Math.round(primary.remainingPercent * 10) / 10}%`);
  } else {
    parts.push("Codex —");
  }
  const secondary = snapshot.secondary;
  if (secondary) {
    const label = windowLabel(secondary.windowMinutes) ?? "week";
    parts.push(`${label} ${Math.round(secondary.remainingPercent * 10) / 10}%`);
  }
  if (parts.length === 0) return undefined;
  return parts.join(" · ");
}
