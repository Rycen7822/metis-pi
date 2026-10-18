import path from "node:path";
import { HOME_DIR, assertEncodableFilter } from "./paths.ts";

export function hasGlobSyntax(value: string): boolean { return /[*?[{]/.test(value); }

export function normalizePathConstraint(pathConstraint: string, cwd = process.cwd()): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return null;
  const directory = trimmed.endsWith("/") || trimmed.endsWith(path.sep);
  if (trimmed === "~" || trimmed.startsWith("~/")) trimmed = path.join(HOME_DIR, trimmed.slice(1));
  if (path.isAbsolute(trimmed) || trimmed.split(/[\\/]/).some(part => part === "." || part === "..")) {
    const relative = path.relative(cwd, path.resolve(cwd, trimmed)).replaceAll(path.sep, "/");
    if (!relative) return "**/*";
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`Path constraint must be relative to the search root: ${pathConstraint}`);
    }
    trimmed = directory ? `${relative}/` : relative;
  }
  assertEncodableFilter(trimmed);
  if (trimmed === "**" || trimmed === "**/" || trimmed === "**/*") return "**/*";
  // fileSearch treats a bare directory token as fuzzy text, unlike grep.
  // Explicit globs enforce the same directory constraint for both APIs.
  if (trimmed.endsWith("/")) return `${trimmed}**`;
  if (trimmed.startsWith("/") || hasGlobSyntax(trimmed)) return trimmed;
  const lastSegment = trimmed.split("/").pop() ?? "";
  return /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment) ? trimmed : `${trimmed}/**`;
}

export function normalizeExcludes(exclude: string | string[] | undefined, cwd = process.cwd()): string[] {
  if (!exclude) return [];
  const out: string[] = [];
  for (const raw of Array.isArray(exclude) ? exclude : [exclude]) {
    // Commas inside braces belong to the glob, not to the list separator.
    const parts = raw.match(/(?:\{[^}]*\}|[^,\s])+/g) ?? [];
    for (const part of parts) {
      const normalized = normalizePathConstraint(part.startsWith("!") ? part.slice(1) : part, cwd);
      if (normalized) out.push(`!${normalized}`);
    }
  }
  return out;
}

export function buildQuery(
  pathConstraint: string | undefined,
  pattern: string,
  exclude?: string | string[],
  cwd = process.cwd(),
): string {
  const constraint = pathConstraint ? normalizePathConstraint(pathConstraint, cwd) : null;
  return [constraint === "**/*" ? null : constraint, ...normalizeExcludes(exclude, cwd), pattern].filter(value => value !== null && value !== "").join(" ");
}
