import type { SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";

export const METIS_EVENTS = {
  executionStatus: "metis:execution-status",
  goalSnapshot: "metis:goal-snapshot",
  goalOpen: "metis:goal-open",
  goalProject: "metis:goal-project",
  occStatus: "metis:occ-status",
  occFinished: "metis:occ-finished",
  checkpointRequestCancelled: "metis:checkpoint-request-cancelled",
  codexCompactionOwner: "metis:codex-compaction-owner",
  beforeRemoteCompact: "metis:before-remote-compact",
  condenseProject: "metis:condense-project",
  condenseMaintenance: "metis:condense-maintenance",
} as const;

// Queries are synchronous: listeners fill response fields on the original object
// before emit returns. Inputs are readonly; response fields remain mutable.
export interface ExecutionStatusRequest { busy: boolean }
export interface GoalSnapshotRequest { snapshot: unknown }
export interface GoalProjectRequest { messages: unknown[] }
export interface OccStatusRequest { deferGoal: boolean; running?: boolean }
export interface OccFinished { readonly cancelled: boolean }
export interface BeforeRemoteCompactRequest {
  readonly signal: AbortSignal;
  readonly waits: unknown[];
}
export interface CondenseProjectRequest {
  readonly sessionId: string | undefined;
  readonly api?: string;
  readonly maintenance?: boolean;
  readonly includeSummaries?: boolean;
  messages: unknown[];
  busy?: boolean;
}
export interface CondenseMaintenanceRequest { pending?: Promise<void> }

// Ownership needs model identity and native history reads, not a full SDK ctx.
export interface CodexCompactionOwnerRequest {
  readonly model?: { readonly api: string; readonly provider: string };
  readonly sessionManager: {
    readonly buildSessionProjection: () => SessionProjection;
    readonly getBranch: () => SessionEntry[];
  };
  owns: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";

export function isExecutionStatusRequest(value: unknown): value is ExecutionStatusRequest {
  return record(value) && typeof value["busy"] === "boolean";
}
export function isGoalSnapshotRequest(value: unknown): value is GoalSnapshotRequest {
  return record(value) && Object.hasOwn(value, "snapshot");
}
export function isGoalProjectRequest(value: unknown): value is GoalProjectRequest {
  return record(value) && Array.isArray(value["messages"]);
}
export function isOccStatusRequest(value: unknown): value is OccStatusRequest {
  return record(value) && typeof value["deferGoal"] === "boolean" && optionalBoolean(value["running"]);
}
export function isOccFinished(value: unknown): value is OccFinished {
  return record(value) && typeof value["cancelled"] === "boolean";
}
export function isBeforeRemoteCompactRequest(value: unknown): value is BeforeRemoteCompactRequest {
  return record(value) && value["signal"] instanceof AbortSignal && Array.isArray(value["waits"]);
}
export function isCondenseProjectRequest(value: unknown): value is CondenseProjectRequest {
  return record(value) && (value["sessionId"] === undefined || typeof value["sessionId"] === "string")
    && (value["api"] === undefined || typeof value["api"] === "string") && Array.isArray(value["messages"])
    && optionalBoolean(value["maintenance"]) && optionalBoolean(value["includeSummaries"])
    && optionalBoolean(value["busy"]);
}
export function isCondenseMaintenanceRequest(value: unknown): value is CondenseMaintenanceRequest {
  return record(value) && (value["pending"] === undefined || value["pending"] instanceof Promise);
}
export function isCodexCompactionOwnerRequest(value: unknown): value is CodexCompactionOwnerRequest {
  return record(value) && typeof value["owns"] === "boolean"
    && (value["model"] === undefined || (record(value["model"]) && typeof value["model"]["api"] === "string"
      && typeof value["model"]["provider"] === "string"))
    && record(value["sessionManager"]) && typeof value["sessionManager"]["buildSessionProjection"] === "function"
    && typeof value["sessionManager"]["getBranch"] === "function";
}
