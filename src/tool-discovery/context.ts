import { isDeepStrictEqual } from "node:util";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isVisible } from "./search.ts";

const MAX_NAMES = 8;
const MAX_MESSAGE = 360;

export interface CatalogSnapshot {
  names: Set<string>;
  parameters: Map<string, string>;
}

/** On session start only names are known. Later requests carry active definitions and changes to previously seen ones. */
export function snapshot(tools: readonly ToolInfo[], activeNames: readonly string[], previous?: CatalogSnapshot): CatalogSnapshot {
  const active = new Set(activeNames), names = new Set<string>(), parameters = new Map<string, string>();
  for (const tool of tools) {
    if (!isVisible(tool, active)) continue;
    names.add(tool.name);
    if (previous && (active.has(tool.name) || previous.parameters.has(tool.name)))
      parameters.set(tool.name, JSON.stringify(tool.parameters));
  }
  return { names, parameters };
}

export function catalogNotice(previous: CatalogSnapshot, current: CatalogSnapshot): string | undefined {
  const added = [...current.names].filter(name => !previous.names.has(name));
  const removed = [...previous.names].filter(name => !current.names.has(name));
  const changed: string[] = [];
  for (const [name, after] of current.parameters) {
    const before = previous.parameters.get(name);
    // Compare immutable wire snapshots, ignoring an object's key order when its serialization differs.
    if (before !== undefined && before !== after && !isDeepStrictEqual(JSON.parse(before), JSON.parse(after))) changed.push(name);
  }
  if (!added.length && !removed.length && !changed.length) return;
  const list = (names: readonly string[]) => names.slice(0, MAX_NAMES).join(", ") +
    (names.length > MAX_NAMES ? ", +" + (names.length - MAX_NAMES) + " more" : "");
  const parts = [changed.length && "parameters changed: " + list(changed), added.length && "added: " + list(added),
    removed.length && "removed: " + list(removed)].filter(Boolean);
  const suffix = ". Use tool_search action=describe for current parameters.";
  const message = "[tool catalog] Visible tools changed — " + parts.join("; ");
  const budget = MAX_MESSAGE - suffix.length;
  return (message.length > budget ? message.slice(0, budget - 1) + "…" : message) + suffix;
}
