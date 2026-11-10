// Native presentation hooks keep skill names out of Markdown bodies and
// transformers. Pi owns both layouts, themes, key hints and mouse handling.
import { patchHostPrototype, type HostPatch } from "../presentation/host-patch.ts";

interface SkillBlock { name?: unknown; content?: unknown }
const NESTED_SKILL = /<skill\s+name="([^"]+)"/g;

/** The block's own name plus nested invocations, deduplicated in order. */
export function skillNames(block: SkillBlock | undefined): string[] {
  const names: string[] = [];
  const own = typeof block?.name === "string" ? block.name.trim() : "";
  if (own) names.push(own);
  const content = typeof block?.content === "string" ? block.content : "";
  for (const match of content.matchAll(NESTED_SKILL)) {
    const name = match[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Missing native presentation capability leaves stock Pi 1.5.1 unchanged. */
export function installSkillLabelNames(component: unknown): HostPatch {
  return patchHostPrototype(component, "getDisplayName", original => {
    if (typeof original !== "function") return undefined;
    const previous = original as (block: SkillBlock) => string;
    return function (this: unknown, block: SkillBlock): string {
      const names = skillNames(block);
      return names.length < 2 ? previous.call(this, block) : names.join(" + ");
    };
  });
}
