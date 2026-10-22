import type { AssistantMessage } from "@earendil-works/pi-ai";

const METHOD = "_isRetryableError";
const SLOT = Symbol.for("Rycen7822.metis-pi.gateway-retry");
const GATEWAY_CODE = /\bworkspace_billing_scope_unavailable\b/;
type Retry = (this: { sessionManager: object }, message: AssistantMessage) => boolean;
interface Hook {
  descriptor: PropertyDescriptor;
  wrapped: Retry;
  owners: Map<object, Set<object>>;
}

/** Pi 1.4 has no retry-classifier event. Lease its host method for this session
 * only; Pi still owns overflow/quota exclusions, budget, backoff and aborts. */
export function installGatewayRetry(sessionClass: unknown, owner: object): () => void {
  const target = (sessionClass as { prototype?: object } | undefined)?.prototype;
  const descriptor = target && Object.getOwnPropertyDescriptor(target, METHOD);
  if (!target || !descriptor || typeof descriptor.value !== "function")
    throw new Error("Metis gateway retry hook unavailable");
  let hook = Reflect.get(target, SLOT) as Hook | undefined;
  if (hook && descriptor.value !== hook.wrapped)
    throw new Error("Metis gateway retry hook was replaced");
  if (!hook) {
    if (!descriptor.writable || !descriptor.configurable)
      throw new Error("Metis gateway retry hook unavailable");
    const original = descriptor.value as Retry;
    const owners: Hook["owners"] = new Map();
    const wrapped: Retry = function (message) {
      const text = message.errorMessage;
      // Pi's broad `billing` veto mistakes this transient lookup failure for
      // exhausted quota. Adjust only a classification copy, never the stored
      // error. Re-enter Pi's classifier so other quota/overflow vetoes survive.
      return original.call(this, owners.has(this.sessionManager) && message.stopReason === "error"
        && text && GATEWAY_CODE.test(text)
        ? { ...message, errorMessage: `503: ${text.replace(/billing/gi, "")}` }
        : message);
    };
    hook = { descriptor, wrapped, owners };
    // Reserve ownership first: a non-extensible prototype must stay untouched.
    if (!Reflect.defineProperty(target, SLOT, { value: hook, configurable: true }))
      throw new Error("Metis gateway retry hook unavailable");
    if (!Reflect.defineProperty(target, METHOD, { ...descriptor, value: wrapped })) {
      Reflect.deleteProperty(target, SLOT);
      throw new Error("Metis gateway retry hook unavailable");
    }
  }
  const owned = hook, lease = {};
  const leases = owned.owners.get(owner) ?? new Set<object>();
  leases.add(lease);
  owned.owners.set(owner, leases);
  return () => {
    if (!leases.delete(lease)) return;
    if (!leases.size) owned.owners.delete(owner);
    const current = Object.getOwnPropertyDescriptor(target, METHOD);
    if (owned.owners.size || current?.value !== owned.wrapped || !current.configurable || !current.writable
      || current.enumerable !== owned.descriptor.enumerable) return;
    Object.defineProperty(target, METHOD, owned.descriptor);
    Reflect.deleteProperty(target, SLOT);
  };
}
