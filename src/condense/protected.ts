/** Structural pick of ContextPruneConfig — keeps this module dependency-free. */
export interface ProtectionConfig {
  protectedTools: readonly string[];
  protectedPaths: readonly string[];
}

/** Keep a parent's evidence if a child was protected, failed or was not durably captured. */
export function hasProtectedNestedResults(details: any): boolean {
  const nested = details?.metisNested;
  return !!(nested?.protected || nested?.hasError || nested?.archiveFailed || nested?.unfinished);
}

/** Keep archive failures and the latest pending state for each parent call. */
export function hasUnavailableNestedEvidence(messages: readonly any[]): boolean {
  const roots = new Map<string, { archiveFailed: boolean; unfinished: boolean }>();
  for (const message of messages) {
    if (message.role !== "toolResult" || !message.details?.metisNested) continue;
    // Persisted cell results share a parent ID even when their outer call IDs differ.
    const details = message.details, root = details.cellParentToolCallId ?? message.toolCallId;
    const prior = roots.get(root);
    roots.set(root, { archiveFailed: !!(prior?.archiveFailed || details.metisNested.archiveFailed), unfinished: !!details.metisNested.unfinished });
  }
  return [...roots.values()].some(root => root.archiveFailed || root.unfinished);
}

// Compile-once: pattern -> RegExp is pure, so the cache never needs
// invalidation. Patterns only come from config arrays, so growth is bounded.
const patternCache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]*/)*"; // `**/` — zero or more whole directories
          i += 3;
        } else {
          re += ".*"; // bare `**`
          i += 2;
        }
      } else {
        re += "[^/]*"; // `*` — segment-local
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  patternCache.set(pattern, compiled);
  return compiled;
}

/** Identity normalization shared by protection matching and supersession: slash direction only, no resolution. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

// Large agent results and inspection histories keep the normal archive path.
const subagentControls = new Set(["pi_spawn_agent", "pi_wait_agent", "pi_list_agents", "pi_ack_result",
  "pi_answer_agent", "pi_send_message", "pi_followup_task", "pi_interrupt_agent"]);
export const isSubagentControl = (toolName: string): boolean => subagentControls.has(toolName);

export function isProtected(toolName: string, args: unknown, config: ProtectionConfig): boolean {
  if (isSubagentControl(toolName)) return true;
  if (config.protectedTools.includes(toolName)) return true;
  if (config.protectedPaths.length === 0) return false;
  const path = (args as Record<string, unknown> | null | undefined)?.path;
  if (typeof path !== "string") return false;
  const normalized = normalizePath(path);
  return config.protectedPaths.some((p) => globToRegExp(p).test(normalized));
}
