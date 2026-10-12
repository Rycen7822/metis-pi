import type { ErrorPurgeConfig } from "./types.ts";
import { hasProtectedNestedResults, isSubagentControl } from "./protected.ts";

/**
 * Replaces the `arguments` body of failed toolCall blocks with a compact stub
 * once the error is old enough to be beyond the cooldown window.
 *
 * Why only the arguments, not the whole toolCall or its toolResult:
 *   - The toolResult content (e.g. "Error: file not found") is small and carries
 *     the failure signal the model needs to understand what went wrong.
 *   - The toolCall block itself must remain so the provider can pair it with its
 *     result and avoid injecting a synthetic "No result provided" error.
 *   - The arguments body is what grows large — failed `write` / `edit` calls
 *     embed the full file content that will never be acted on again.
 *
 * Why the cooldown:
 *   - Gives the model 1–2 turns to retry before context is mutated. Purging
 *     immediately would remove the call detail before the model has had a
 *     chance to see the error and adapt.
 *
 * Turn index is computed internally by counting AssistantMessages in the input.
 * This avoids threading a turn counter through index.ts.
 */
export function purgeErroredArgs(messages: any[], config: ErrorPurgeConfig): any[] {
  // Pair results within their assistant turn. Provider IDs can repeat later;
  // only the actual failed call block earns permission to purge its arguments.
  const erroredAtTurn = new Map<object, number>();
  let open = new Map<string, any>();
  let turnCount = 0;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      turnCount++;
      open = new Map((msg.content ?? []).filter((block: any) => block.type === "toolCall")
        .map((block: any) => [block.id, block]));
    } else if (msg.role === "toolResult") {
      const block = open.get(msg.toolCallId);
      if (!block) continue;
      open.delete(msg.toolCallId);
      if (msg.isError === true && !hasProtectedNestedResults(msg.details)) erroredAtTurn.set(block, turnCount);
    } else {
      open.clear();
    }
  }

  if (erroredAtTurn.size === 0) return messages;

  const currentTurnIndex = turnCount;

  let anyModified = false;
  const result = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    let contentModified = false;
    const newContent = (msg.content as any[]).map((block) => {
      if (block.type !== "toolCall" || isSubagentControl(block.name)) return block;

      const errorTurn = erroredAtTurn.get(block);
      if (errorTurn === undefined) return block;

      const age = currentTurnIndex - errorTurn;
      if (age < config.cooldownTurns) return block;

      const argBody = JSON.stringify(block.arguments);
      if (argBody.length < config.minArgChars) return block;

      contentModified = true;
      return { ...block, arguments: { _purged: `<purged-errored-args size="${argBody.length}"/>` } };
    });

    if (!contentModified) return msg;
    anyModified = true;
    return { ...msg, content: newContent };
  });

  return anyModified ? result : messages;
}
