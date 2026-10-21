// Leases for the two host skill decorations. Metadata lives on the wrapper,
// so fresh module copies share ownership without a process-wide registry.
export type SkillPatchState = "patched" | "already" | "missing";
export interface SkillPatch { readonly state: SkillPatchState; release(): void }
type HostMethod = (...args: never[]) => unknown;
interface Installed {
  prototype: object;
  method: string;
  descriptor: PropertyDescriptor | undefined;
  wrapper: HostMethod;
  owners: number;
}
const OWNER = Symbol.for("Rycen7822.metis-pi.skill-decoration");
const missing = (): SkillPatch => ({ state: "missing", release() {} });

function lease(entry: Installed, state: SkillPatchState): SkillPatch {
  let live = true;
  return {
    state,
    release() {
      if (!live) return;
      live = false;
      if (--entry.owners > 0) return;
      const current = Object.getOwnPropertyDescriptor(entry.prototype, entry.method);
      // Preserve later owners and descriptor changes. Even if they retained our
      // wrapper, its zero-owner path delegates without applying the decoration.
      if (current?.value !== entry.wrapper
        || current.writable !== (entry.descriptor?.writable ?? true)
        || current.configurable !== (entry.descriptor?.configurable ?? true)
        || current.enumerable !== (entry.descriptor?.enumerable ?? true)) return;
      if (entry.descriptor) Reflect.defineProperty(entry.prototype, entry.method, entry.descriptor);
      else Reflect.deleteProperty(entry.prototype, entry.method);
    },
  };
}

/** Install eagerly, before component construction; the factory owns release. */
export function patchHostPrototype(
  component: unknown,
  method: string,
  wrap: (original: unknown) => HostMethod | undefined,
): SkillPatch {
  const prototype = (component as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!prototype || typeof prototype !== "object") return missing();
  const original = prototype[method];
  const existing = typeof original === "function"
    ? (original as unknown as Record<symbol, unknown>)[OWNER] as Installed | undefined : undefined;
  if (existing?.prototype === prototype && existing.method === method && existing.owners > 0) {
    existing.owners++;
    return lease(existing, "already");
  }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  if (descriptor ? !("value" in descriptor) || !descriptor.writable : !Object.isExtensible(prototype)) return missing();
  const decorate = wrap(original);
  if (!decorate) return missing();
  const entry: Installed = {
    prototype, method, descriptor, owners: 1,
    wrapper: function (this: unknown, ...args: never[]) {
      if (entry.owners > 0) return decorate.apply(this, args);
      return typeof original === "function" ? original.apply(this, args) : undefined;
    },
  };
  Object.defineProperty(entry.wrapper, OWNER, { value: entry });
  if (!Reflect.defineProperty(prototype, method, descriptor
    ? { ...descriptor, value: entry.wrapper }
    : { value: entry.wrapper, writable: true, configurable: true, enumerable: true })) return missing();
  return lease(entry, "patched");
}
