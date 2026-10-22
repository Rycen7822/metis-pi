import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Stream = ModelRuntime["streamSimple"];
type Limits = WeakMap<AbortSignal, number>;
interface Hook {
  original: Stream;
  wrapped: Stream;
  owners: Set<Limits>;
}
const SLOT = Symbol.for("metis-pi.compaction-output-limit.v1");

function currentHook(): Hook {
  const target = ModelRuntime.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(target, "streamSimple");
  if (!descriptor?.configurable || !descriptor.writable || typeof descriptor.value !== "function")
    throw new Error("Compaction output hook unavailable");
  const previous = Reflect.get(target, SLOT) as Hook | undefined;
  if (previous && previous.wrapped === descriptor.value) return previous;
  // A later owner may retain our old wrapper. Share registrations when wrapping
  // it, so in-flight signals stay capped; applying min twice is harmless.
  const owners = previous?.owners ?? new Set<Limits>();
  const original = descriptor.value as Stream;
  const wrapped: Stream = function (this: ModelRuntime, model, context, options) {
    let ceiling: number | undefined;
    if (options?.signal && options.cacheRetention === "none") {
      for (const limits of owners) {
        const limit = limits.get(options.signal);
        if (limit !== undefined) ceiling = Math.min(ceiling ?? Infinity, limit);
      }
    }
    if (ceiling === undefined) return original.call(this, model, context, options);
    ceiling = Math.min(ceiling, options?.maxTokens ?? Infinity, model.maxTokens > 0 ? model.maxTokens : Infinity);
    return original.call(this, model, context, { ...options, maxTokens: ceiling });
  };
  const hook = { original, wrapped, owners };
  // Reserve metadata first; the validated own method can then be replaced synchronously.
  Object.defineProperty(target, SLOT, { value: hook, configurable: true });
  Object.defineProperty(target, "streamSimple", { ...descriptor, value: wrapped });
  return hook;
}

/** One activation owns weak request registrations, not a single current request.
 * Pi 1.4 forwards each native summary's signal and cacheRetention:none through
 * this public runtime. Weak keys survive overlapping history/prefix/retry calls
 * without retaining completed signals or depending on signal-less end events. */
export function createCompactionOutputLimiter() {
  const limits: Limits = new WeakMap();
  const owners = currentHook().owners;
  owners.add(limits);
  return {
    limit(signal: AbortSignal, limit: number) {
      if (!owners.has(limits) || signal.aborted) throw new Error("Compaction was cancelled");
      if (!Number.isFinite(limit) || limit <= 0) throw new Error("Invalid compaction output limit");
      currentHook();
      limits.set(signal, limit);
    },
    release() {
      if (!owners.delete(limits) || owners.size) return;
      const target = ModelRuntime.prototype, hook = Reflect.get(target, SLOT) as Hook | undefined;
      if (!hook || hook.owners !== owners) return;
      const current = Object.getOwnPropertyDescriptor(target, "streamSimple");
      // Restore only our method, preserving any later descriptor restrictions.
      if (current?.value === hook.wrapped)
        Reflect.defineProperty(target, "streamSimple", { ...current, value: hook.original });
      // Retained wrappers now have an empty owner set and become native passthrough.
      Reflect.deleteProperty(target, SLOT);
    },
  };
}
