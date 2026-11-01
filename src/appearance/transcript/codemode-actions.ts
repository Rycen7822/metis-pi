import { asRecord } from "../../presentation/tool-names.ts";

/** Runtime helpers without native tool/model lifecycle rows. */
export const CODEMODE_HELPERS = {
  describeNamespace: "Describe namespace",
  describeTool: "Describe tool",
  searchTools: "Search tools",
  "models.getModelsOfType": "Read models",
  "models.getAvailableOfType": "Read available models",
  "models.getModelOfType": "Read model",
} as const;

export interface CodemodeAction {
  id: string;
  name: keyof typeof CODEMODE_HELPERS;
  arguments: string[];
  /** Number of native calls already started; helpers do not consume native call positions. */
  beforeCall: number;
  status: "running" | "ok" | "error" | "cancelled";
  error?: string;
}

export interface CodemodeActions {
  calls: CodemodeAction[];
  omitted: number;
}

export function isCodemodeHelper(name: string): name is CodemodeAction["name"] {
  return Object.hasOwn(CODEMODE_HELPERS, name);
}

/** Saved details cross the history boundary; unrecognized rows keep the generic script summary. */
export function readCodemodeActions(details: unknown): CodemodeActions {
  const data = asRecord(asRecord(details).codemodeActions);
  const calls: CodemodeAction[] = [];
  for (const item of Array.isArray(data.calls) ? data.calls : []) {
    const row = asRecord(item);
    if (typeof row.id !== "string" || typeof row.name !== "string" || !isCodemodeHelper(row.name)
      || !Array.isArray(row.arguments) || !row.arguments.every(value => typeof value === "string")
      || !Number.isSafeInteger(row.beforeCall) || Number(row.beforeCall) < 0
      || !["running", "ok", "error", "cancelled"].includes(String(row.status))) continue;
    calls.push({
      id: row.id, name: row.name, arguments: row.arguments, beforeCall: Number(row.beforeCall),
      status: row.status as CodemodeAction["status"],
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    });
  }
  return { calls, omitted: Number.isSafeInteger(data.omitted) && Number(data.omitted) > 0 ? Number(data.omitted) : 0 };
}
