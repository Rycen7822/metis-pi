import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSkillInput, type SkillInput, type SkillSummary } from "./skill-input.ts";
export { createSkillAutocompleteWrapper, matchSkillContext } from "./skill-input.ts";
export type { SkillContext, SkillListFn, SkillSummary } from "./skill-input.ts";

export interface SkillMux extends SkillInput {
  listSkills(): SkillSummary[];
}

export function createSkillMux(pi: Pick<ExtensionAPI, "getCommands">): SkillMux {
  // Read lazily: the core API is unbound during extension loading, and /reload
  // can replace the resource list. Discovery and precedence belong to Pi.
  const skills = () => pi.getCommands().filter(command => command.source === "skill" && command.name.startsWith("skill:"));
  return {
    ...createSkillInput(name => {
      const filePath = skills().find(command => command.name === `skill:${name}`)?.sourceInfo.path;
      if (!filePath) return null;
      try {
        const body = stripFrontmatter(readFileSync(filePath, "utf-8")).trim();
        return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${body}\n</skill>`;
      } catch {
        return null; // Unreadable skills retain their original token.
      }
    }),
    listSkills: () => skills()
      .map(command => ({ name: command.name.slice(6), description: command.description ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
