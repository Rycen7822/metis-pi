// Durable checkpoint codec and exact native carrier semantics. No IO or session state.
import { convertToLlm, type SessionEntry, type CompactionEntry } from "@earendil-works/pi-coding-agent";

export const KEY = "metisCodexRemoteCompaction";
export const MARKER = "[Metis Codex remote checkpoint ";
export const MAX_BYTES = 8 * 1024 * 1024;
export type Item = Record<string, any>;
export interface BindingScope {
  route: string; account?: string; credential?: "oauth" | "api_key"; apiKeyDigest?: string;
}
export type CheckpointScope = BindingScope & (
  { credential: "oauth"; apiKeyDigest?: never } | { credential: "api_key"; apiKeyDigest: string }
);
interface CheckpointData {
  marker: string; history: Item[]; protocol?: "responses";
  model?: { provider: string; modelId: string };
}
export type Checkpoint = CheckpointData & (
  // Read-only compatibility with token/grant-bound v1 checkpoints.
  { version: 1; binding: string; scope?: BindingScope; codexBinding?: string; codexScope?: BindingScope }
  | { version: 2; scope: CheckpointScope; codexScope?: CheckpointScope; binding?: never; codexBinding?: never }
);
export const record = (value: unknown): Item => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isMarker = (value: unknown): value is string => typeof value === "string"
  && value.startsWith(MARKER) && /^[\da-f-]{36}\]$/.test(value.slice(MARKER.length));
export const ours = (entry: SessionEntry): entry is CompactionEntry => entry.type === "compaction"
  && (Object.hasOwn(record(entry.details), KEY) || entry.fromHook === true && isMarker(entry.summary));

export function responsesHistory(value: unknown): value is Item[] {
  if (!Array.isArray(value) || !value.length || !value.every(item => item && typeof item === "object" && !Array.isArray(item))) return false;
  const checkpoints = value.filter(item => item.type === "compaction");
  return checkpoints.length > 0 && checkpoints.every(item => typeof item.encrypted_content === "string"
    && item.encrypted_content.length > 0 && (!item.status || item.status === "completed"));
}

export function checkpoint(entry: CompactionEntry): Checkpoint | undefined {
  const data = record(record(entry.details)[KEY]);
  if (!isMarker(entry.summary) || ![1, 2].includes(data.version) || data.marker !== entry.summary
    || !Array.isArray(data.history)) return;
  if (data.version === 1 && typeof data.binding !== "string") return;
  if (data.version === 2 && data.scope === undefined) return;
  if (data.model !== undefined && (typeof record(data.model).provider !== "string" || typeof record(data.model).modelId !== "string")) return;
  for (const scope of [data.scope, data.codexScope]) {
    if (scope !== undefined && (!digest(record(scope).route)
      || scope.account !== undefined && !digest(scope.account)
      || (data.version === 2 || scope.credential !== undefined) && !["oauth", "api_key"].includes(scope.credential))) return;
    if (scope !== undefined && (scope.apiKeyDigest !== undefined && (scope.credential !== "api_key" || !digest(scope.apiKeyDigest))
      || data.version === 2 && scope.credential === "api_key" && !digest(scope.apiKeyDigest))) return;
  }
  if (JSON.stringify(data.history).length > MAX_BYTES) return;
  if (data.protocol === "responses") return responsesHistory(data.history) ? data as Checkpoint : undefined;
  if (data.protocol !== undefined) return;
  const last = record(data.history.at(-1));
  if (last.type !== "compaction" || typeof last.encrypted_content !== "string" || !last.encrypted_content) return;
  if (!data.history.slice(0, -1).every((item: unknown) => record(item).role === "user"
    && (!record(item).type || record(item).type === "message"))) return;
  return data as Checkpoint;
}

/** Original entries remain in Pi's ledger. Removing only our boundaries restores
 * raw history without bypassing preceding plaintext compactions or context edits. */
export function rawBranch(branch: SessionEntry[]): SessionEntry[] {
  return branch.map(entry => ours(entry)
    ? { ...entry, type: "custom" as const, customType: KEY, data: undefined }
    : entry);
}
export function summaryText(marker: string): string {
  const message = convertToLlm([{ role: "compactionSummary", summary: marker, tokensBefore: 0, timestamp: 0 }])[0];
  return typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
}
export function matchesMarker(item: Item, expected: string): boolean {
  if (item.role !== "user" || item.type && item.type !== "message") return false;
  if (typeof item.content === "string") return item.content === expected;
  return Array.isArray(item.content)
    && item.content.map((part: Item) => part.type === "input_text" ? part.text : "").join("") === expected;
}
export function replaceMarker(payload: unknown, data: Checkpoint): Item {
  const body = record(payload);
  if (!Array.isArray(body.input)) throw new Error("Codex payload has no input");
  const expected = summaryText(data.marker);
  let matches = 0;
  const input = body.input.flatMap((item: Item) => {
    if (!matchesMarker(item, expected)) return [item];
    matches++; return data.history;
  });
  if (matches !== 1) throw new Error("Codex checkpoint marker missing or ambiguous");
  return { ...body, input };
}
