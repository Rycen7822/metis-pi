import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";

type Stream = ModelRuntime["streamSimple"];
interface Mailbox {
  sessionId: string;
  signal(): AbortSignal | undefined;
  pending(): boolean;
  take(timestamp: number): Promise<boolean | undefined>;
}
interface Hook {
  descriptor: PropertyDescriptor;
  wrapped: Stream;
  owners: Map<string, Mailbox>;
}
const SLOT = Symbol.for("metis-pi.subagent-sampling.v1");

function isBoundary(event: AssistantMessageEvent): event is Extract<AssistantMessageEvent, { type: "thinking_end" | "text_end" }> {
  if (event.type !== "thinking_end" && event.type !== "text_end") return false;
  if (event.partial.content.some(block => block.type === "toolCall")) return false;
  if (event.type === "thinking_end") return true;
  const block = event.partial.content[event.contentIndex];
  if (block?.type !== "text" || !block.textSignature) return false;
  // Only the public v1 signature distinguishes commentary from a final answer.
  try {
    const signature = JSON.parse(block.textSignature);
    return signature.v === 1 && typeof signature.id === "string" && signature.phase === "commentary";
  } catch { return false; }
}

function sampling(
  model: Parameters<Stream>[0],
  source: ReturnType<Stream>,
  cancel: AbortController,
  signal: AbortSignal,
  mailbox: Mailbox,
) {
  const output = createAssistantMessageEventStream();
  let latest: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    content: [],
    stopReason: "error",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  void (async () => {
    try {
      for await (const event of source) {
        if ("partial" in event) latest = event.partial;
        if (mailbox.pending() && !signal.aborted && isBoundary(event)) {
          // Provider partials remain mutable: snapshot the closed item before claiming.
          const completed = structuredClone(event.partial);
          if (await mailbox.take(completed.timestamp)) {
            // Cancel only this provider request, never the agent/tool operation signal.
            // Drain the terminal result for usage and finalized reasoning signatures.
            cancel.abort();
            const result = await source.result();
            if (signal.aborted || result.stopReason === "error") {
              const reason = signal.aborted ? "aborted" : "error";
              const error: AssistantMessage = reason === "aborted" ? { ...result, stopReason: reason, errorMessage: "Operation aborted" } : result;
              output.push({ type: "error", reason, error }); output.end(error);
            } else {
              const content = completed.content.map((block, index) => {
                const final = result.content[index];
                return (block.type === "thinking" && final?.type === "thinking" && final.thinking === block.thinking)
                  || (block.type === "text" && final?.type === "text" && final.text === block.text) ? final : block;
              });
              const message: AssistantMessage = { ...completed, content, usage: result.usage, stopReason: "stop" };
              delete message.errorMessage;
              output.push({ ...event, partial: message });
              output.push({ type: "done", reason: "stop", message }); output.end(message);
            }
            return;
          }
        }
        output.push(event);
      }
      output.end(await source.result());
    } catch (error) {
      cancel.abort();
      // Preserve the provider's own terminal error instead of manufacturing success.
      const result = await source.result().catch(() => latest);
      const reason = signal.aborted ? "aborted" : "error";
      const failed: AssistantMessage = { ...result, stopReason: reason, errorMessage: String(error) };
      output.push({ type: "error", reason, error: failed }); output.end(failed);
    }
  })();
  return output;
}

/** A transparent public-runtime hook, scoped to the exact frontend request signal.
 * Nested summaries, other sessions and later wrapper owners are not intercepted. */
export function installSamplingMailbox(mailbox: Mailbox): () => void {
  const target = ModelRuntime.prototype;
  let hook = Reflect.get(target, SLOT) as Hook | undefined;
  if (hook && target.streamSimple !== hook.wrapped)
    throw new Error("Subagent sampling hook was replaced; using turn-end delivery");
  if (!hook) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "streamSimple");
    if (!descriptor?.configurable || !descriptor.writable || typeof descriptor.value !== "function")
      throw new Error("Subagent sampling hook unavailable; using turn-end delivery");
    const original = descriptor.value as Stream;
    const owners = new Map<string, Mailbox>();
    const wrapped: Stream = function (this: ModelRuntime, model, context, options) {
      const owner = options?.sessionId ? owners.get(options.sessionId) : undefined;
      const signal = options?.signal;
      if (!owner || !signal || signal.aborted || signal !== owner.signal()) return original.call(this, model, context, options);
      const cancel = new AbortController();
      const source = original.call(this, model, context, { ...options, signal: AbortSignal.any([signal, cancel.signal]) });
      return sampling(model, source, cancel, signal, owner);
    };
    hook = { descriptor, wrapped, owners };
    try {
      Object.defineProperty(target, SLOT, { value: hook, configurable: true });
      Object.defineProperty(target, "streamSimple", { ...descriptor, value: wrapped });
    } catch (error) {
      if (target.streamSimple === wrapped) Object.defineProperty(target, "streamSimple", descriptor);
      if (Reflect.get(target, SLOT) === hook) Reflect.deleteProperty(target, SLOT);
      throw error;
    }
  }
  if (hook.owners.has(mailbox.sessionId)) throw new Error("Subagent sampling session already attached");
  hook.owners.set(mailbox.sessionId, mailbox);
  const owned = hook;
  return () => {
    if (owned.owners.get(mailbox.sessionId) === mailbox) owned.owners.delete(mailbox.sessionId);
    const current = Object.getOwnPropertyDescriptor(target, "streamSimple");
    if (owned.owners.size || current?.value !== owned.wrapped || current.configurable !== owned.descriptor.configurable
      || current.writable !== owned.descriptor.writable || current.enumerable !== owned.descriptor.enumerable) return;
    Object.defineProperty(target, "streamSimple", owned.descriptor);
    if (Reflect.get(target, SLOT) === owned) Reflect.deleteProperty(target, SLOT);
  };
}
