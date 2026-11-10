import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isVisible } from "./search.ts";

const MAX_NAMES = 8;
const MAX_MESSAGE = 360;

/** Model-visible names: hidden tools and inactive direct/model-only tools are not part of the request. */
export function visibleNames(tools: readonly ToolInfo[], active: readonly string[]): Set<string> {
  const activeSet = new Set(active);
  return new Set(tools.filter(tool => isVisible(tool, activeSet)).map(tool => tool.name));
}

/**
 * One bounded notice for a changed visible name set, or undefined when nothing visible changed.
 * Loaded tool schemas are read live on every call, so a name change is all this needs to report.
 */
export function catalogNotice(added: readonly string[], removed: readonly string[]): string | undefined {
  if (added.length === 0 && removed.length === 0) return undefined;
  const list = (names: readonly string[]) => names.slice(0, MAX_NAMES).join(", ") +
    (names.length > MAX_NAMES ? `, +${names.length - MAX_NAMES} more` : "");
  const parts = [
    added.length > 0 ? `added: ${list(added)}` : "",
    removed.length > 0 ? `removed: ${list(removed)}` : "",
  ].filter(Boolean);
  const message = `[tool catalog] Visible tools changed — ${parts.join("; ")}. ` +
    "Loaded tools stay searchable; call tool_search to search again and action=describe for current parameters.";
  return message.length <= MAX_MESSAGE ? message : `${message.slice(0, MAX_MESSAGE - 1)}…`;
}
