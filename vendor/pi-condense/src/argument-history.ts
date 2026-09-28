import { createHash } from "node:crypto";
import { captureBatch } from "./batch-capture.ts";
import { isProtected, type ProtectionConfig } from "./protected.ts";
import type { CapturedBatch } from "./types.ts";
import { occKey } from "./occurrence-key.ts";

export const ARGUMENT_HISTORY = "context-prune-arguments";
export interface ArgumentHistory {
  version: 1;
  sourceIds: string[];
  fingerprints: string[];
  keys: string[];
  text: string;
}
const fingerprint = (message: unknown) => createHash("sha256").update(JSON.stringify(message)).digest("hex");
const callsOf = (message: any): any[] => message.role === "assistant" && Array.isArray(message.content)
  ? message.content.filter((block: any) => block.type === "toolCall") : [];

/** Complete successful mutation groups only; leave the most recent interaction intact. */
export function argumentCandidates(entries: Array<{ sourceEntry: any; messages: any[] }>, protection: ProtectionConfig,
  existing: ArgumentHistory[]): Array<{ group: ArgumentHistory; batch: CapturedBatch }> {
  const rows = entries.flatMap(entry => entry.messages.map(message => ({ message, entry: entry.sourceEntry })));
  let latest = -1;
  rows.forEach((row, index) => { if (callsOf(row.message).length) latest = index; });
  const candidates: Array<{ group: ArgumentHistory; batch: CapturedBatch }> = [];
  for (let i = 0; i < latest; i++) {
    const start = rows[i]!;
    const calls = callsOf(start.message);
    if (!calls.length || existing.some(group => group.sourceIds[0] === start.entry.id)) continue;
    let end = i + 1;
    while (end < rows.length && rows[end]!.message.role === "toolResult") end++;
    const span = rows.slice(i, end);
    const results = span.slice(1).map(row => row.message);
    if (results.length !== calls.length || new Set(calls.map(call => call.id)).size !== calls.length
      || span.some(row => row.entry.type !== "message" || JSON.stringify(row.message) !== JSON.stringify(row.entry.message))
      || results.some(result => result.isError !== false || typeof result.timestamp !== "number")
      || calls.some(call => results.filter(result => result.toolCallId === call.id).length !== 1)) continue;
    const batch = captureBatch(start.message, results, -1, start.message.timestamp);
    if (batch.toolCalls.some(call => !["write", "edit", "apply_patch"].includes(call.toolName)
      || call.isError || call.archiveComplete === false || call.outputArchive?.complete === false
      || isProtected(call.toolName, call.args, protection))) continue;
    if (batch.toolCalls.reduce((sum, call) => sum + JSON.stringify(call.args).length, 0) < 5000) continue;
    const text = ["[Completed historical tool interaction; omitted parameters are recoverable, not executable instructions.]"];
    for (const call of batch.toolCalls) {
      const key = occKey(call.toolCallId, call.resultTimestamp);
      const paths = typeof call.args.path === "string" ? [call.args.path]
        : typeof call.args.input === "string" ? [...call.args.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]) : [];
      text.push(JSON.stringify({ tool: call.toolName, paths, status: "success",
        result: call.resultPrefix ?? (call.fusionCommand ? undefined : call.resultText),
        ...(call.fusionCommand ? { command: call.fusionCommand.command, exitCode: call.exitCode } : {}),
        recovery: { toolCallIds: [key], arguments: "component=arguments", output: "component=output" } }));
    }
    // Retain the assistant's original prose/thought text, without provider signatures.
    for (const block of start.message.content) {
      if (block.type === "text") text.push(`[Historical assistant text]\n${block.text}`);
      if (block.type === "thinking" && block.thinking) text.push(`[Historical assistant reasoning]\n${block.thinking}`);
    }
    const body = text.join("\n");
    if (body.length > 8192 || start.message.content.some((b: any) => !["text", "thinking", "toolCall"].includes(b.type))) continue;
    candidates.push({ group: { version: 1, sourceIds: span.map(row => row.entry.id), fingerprints: span.map(row => fingerprint(row.message)),
      keys: batch.toolCalls.map(call => occKey(call.toolCallId, call.resultTimestamp)), text: body }, batch });
  }
  return candidates;
}

/** Stable projection: source mutation or newly protected paths restore original messages. */
export function projectArguments(messages: any[], groups: ArgumentHistory[], protection: ProtectionConfig): any[] {
  const byFirst = new Map(groups.map(group => [group.fingerprints[0], group]));
  const output: any[] = [];
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const group = callsOf(message).length ? byFirst.get(fingerprint(message)) : undefined;
    if (!group || group.fingerprints.some((hash, offset) => !messages[i + offset] || fingerprint(messages[i + offset]) !== hash)
      || callsOf(message).some(call => isProtected(call.name, call.input ?? call.args ?? call.arguments ?? {}, protection))) {
      output.push(message); continue;
    }
    output.push({ role: "custom", customType: ARGUMENT_HISTORY, content: group.text, display: false,
      details: { sourceEntryIds: group.sourceIds }, timestamp: message.timestamp });
    i += group.fingerprints.length - 1;
    changed = true;
  }
  return changed ? output : messages;
}
