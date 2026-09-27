import type { ErrorPurgeConfig } from "./types.js";
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
export declare function purgeErroredArgs(messages: any[], config: ErrorPurgeConfig): any[];
