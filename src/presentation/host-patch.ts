// Leases for native presentation hooks. Wrapper metadata shares ownership
// across fresh module copies without a process-wide registry.
export type HostPatchState = "patched" | "already" | "missing";
export interface HostPatch { readonly state: HostPatchState; release(): void }
type HostMethod = (...args: never[]) => unknown;
interface Owner { decorate: HostMethod }
interface Installed {
  prototype: object;
  method: string;
  descriptor: PropertyDescriptor | undefined;
  original: unknown;
  wrapper: HostMethod;
  owners: Owner[];
}
const OWNER = Symbol.for("Rycen7822.metis-pi.skill-decoration");
const missing = (): HostPatch => ({ state: "missing", release() {} });

function lease(entry: Installed, owner: Owner, state: HostPatchState): HostPatch {
  return {
    state,
    release() {
      const index = entry.owners.indexOf(owner);
      if (index < 0) return;
      entry.owners.splice(index, 1);
      if (entry.owners.length > 0) return;
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
): HostPatch {
  const prototype = (component as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!prototype || typeof prototype !== "object") return missing();
  const original = prototype[method];
  const existing = typeof original === "function"
    ? (original as unknown as Record<symbol, unknown>)[OWNER] as Installed | undefined : undefined;
  if (existing?.prototype === prototype && existing.method === method && existing.owners.length > 0) {
    const decorate = wrap(existing.original);
    if (!decorate) return missing();
    const owner = { decorate };
    existing.owners.push(owner);
    return lease(existing, owner, "already");
  }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  if (descriptor ? !("value" in descriptor) || !descriptor.writable : !Object.isExtensible(prototype)) return missing();
  const decorate = wrap(original);
  if (!decorate) return missing();
  const owner = { decorate };
  const entry: Installed = {
    prototype, method, descriptor, original, owners: [owner],
    wrapper: function (this: unknown, ...args: never[]) {
      // Only a live lease supplies context; release reveals the preceding owner.
      const current = entry.owners.at(-1);
      if (current) return current.decorate.apply(this, args);
      return typeof original === "function" ? original.apply(this, args) : undefined;
    },
  };
  Object.defineProperty(entry.wrapper, OWNER, { value: entry });
  if (!Reflect.defineProperty(prototype, method, descriptor
    ? { ...descriptor, value: entry.wrapper }
    : { value: entry.wrapper, writable: true, configurable: true, enumerable: true })) return missing();
  return lease(entry, owner, "patched");
}
