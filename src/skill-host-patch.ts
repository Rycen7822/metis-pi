export type SkillPatchResult = "patched" | "already" | "missing";

/** Any host method we wrap: called with the host component as `this`. */
type HostMethod = (...args: never[]) => unknown;

const patchedHosts = new WeakMap<object, Set<string>>();

/** Guard each prototype/method pair so independent decorations can coexist. */
export function patchHostPrototype(
  component: unknown,
  method: string,
  wrap: (original: unknown) => HostMethod | undefined,
): SkillPatchResult {
  const prototype = (component as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!prototype || typeof prototype !== "object") return "missing";
  const done = patchedHosts.get(prototype);
  if (done?.has(method)) return "already";
  const replacement = wrap(prototype[method]);
  if (replacement === undefined) return "missing";
  prototype[method] = replacement;
  if (done) done.add(method);
  else patchedHosts.set(prototype, new Set([method]));
  return "patched";
}
