import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reverseBranchEntryReferences } from "../session-history.ts";
import { reverseCustomEntries } from "./custom-entries.ts";
import { projectionFingerprint } from "./token-estimator.ts";

const CUSTOM_TYPE_ATTEMPT = "context-prune-group-attempt";
const MAX_ATTEMPTS = 32;
type AppendEntry = (customType: string, data: unknown) => void;
type Manager = ExtensionContext["sessionManager"];
const checkpointFingerprint = (message: { role: string; timestamp: number; content: unknown }) =>
  projectionFingerprint([{ role: message.role, timestamp: message.timestamp, content: message.content }]);

/** Host IDs own old history; only the current, possibly unpersisted checkpoint needs a content identity. */
export function summaryGroupSource(
  manager: Manager, closingMessage?: { role: "assistant"; timestamp: number; content: unknown },
): string {
  let closing = closingMessage ? checkpointFingerprint(closingMessage) : undefined;
  let skippedClosing = false;
  for (const reference of reverseBranchEntryReferences(manager)) {
    if (["custom", "usage", "label", "session_info", "model_change", "thinking_level_change"].includes(reference.type)) continue;
    // A later budget/recovery trigger may not carry closingMessage. Normalize its
    // persisted assistant head exactly as the preceding message_end's pending head.
    if (!closing && reference.type === "message" && reference.message.role === "assistant") {
      const entry = manager.getEntry(reference.id);
      if (entry?.type === "message" && entry.message.role === "assistant") {
        closing = checkpointFingerprint(entry.message); skippedClosing = true; continue;
      }
    }
    if (!skippedClosing && closing && reference.type === "message" && reference.message.role === closingMessage?.role) {
      const entry = manager.getEntry(reference.id);
      if (entry?.type === "message" && entry.message.role === "assistant" && entry.message.timestamp === closingMessage.timestamp
        && checkpointFingerprint(entry.message) === closing) { skippedClosing = true; continue; }
    }
    return JSON.stringify([reference.id, closing]);
  }
  return JSON.stringify([null, closing]);
}

/** A bounded branch-local spending latch, durable before any provider side effect. Never stores summary bodies. */
export class SummaryGroupAttempts {
  private readonly attempted = new Set<string>();

  restore(manager: Manager): void {
    this.attempted.clear();
    const seen = new Set<string>(), pending: string[] = [];
    for (const entry of reverseCustomEntries(manager, CUSTOM_TYPE_ATTEMPT)) {
      const data: unknown = entry.data;
      if (!data || typeof data !== "object" || !("key" in data) || typeof data.key !== "string" || data.key.length !== 64) continue;
      if (seen.has(data.key)) continue;
      seen.add(data.key);
      if (!("resolved" in data) || data.resolved !== true) pending.push(data.key);
      if (seen.size >= MAX_ATTEMPTS) break;
    }
    // Replay scans newest-first; eviction must still discard the oldest latch.
    for (const key of pending.reverse()) this.attempted.add(key);
  }

  has(key: string): boolean { return this.attempted.has(key); }

  begin(key: string, append: AppendEntry): void {
    if (this.attempted.has(key)) throw new Error("Summary group already attempted without progress");
    if (this.attempted.size >= MAX_ATTEMPTS) this.attempted.delete(this.attempted.values().next().value!);
    this.attempted.add(key);
    // An append failure prevents the provider request; the conservative in-memory latch remains.
    append(CUSTOM_TYPE_ATTEMPT, { key });
  }

  resolve(key: string, append: AppendEntry): void {
    // The summary is already durable. A failed tombstone cannot make it unpublished or re-pay it.
    this.attempted.delete(key);
    append(CUSTOM_TYPE_ATTEMPT, { key, resolved: true });
  }
}
