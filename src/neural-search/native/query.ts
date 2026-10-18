import path from "node:path";
import { HOME_DIR, assertEncodableFilter, pathConstraintText } from "./paths.ts";

export function hasGlobSyntax(value: string): boolean { return /[*?[{]/.test(value); }

export function normalizePathConstraint(pathConstraint: string, cwd = process.cwd()): string | null {
  let trimmed = pathConstraintText(pathConstraint);
  if (!trimmed) return null;
  const directory = trimmed.endsWith("/");
  if (trimmed === "~" || trimmed.startsWith("~/")) trimmed = path.join(HOME_DIR, trimmed.slice(1));
  if (path.isAbsolute(trimmed) || trimmed.split("/").some(part => part === "." || part === "..")) {
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
  // A slash also makes basename globs unambiguous to the content parser.
  if (trimmed.startsWith("/") || hasGlobSyntax(trimmed)) return trimmed.includes("/") ? trimmed : `./${trimmed}`;
  const lastSegment = trimmed.split("/").pop() ?? "";
  return /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment) ? trimmed : `${trimmed}/**`;
}

export function normalizeExcludes(exclude: string | string[] | undefined, cwd = process.cwd()): string[] {
  if (!exclude) return [];
  const out: string[] = [];
  const array = Array.isArray(exclude);
  // Arrays retain path whitespace for validation; scalar strings also support
  // whitespace-separated lists. Braces and bracket classes own their commas.
  const tokens = array ? /(?:\{[^}]*\}|\[[^\]]*\]|[^,])+/g : /(?:\{[^}]*\}|\[[^\]]*\]|[^,\s])+/g;
  for (const raw of array ? exclude : [exclude]) {
    for (const part of raw.match(tokens) ?? []) {
      const value = part.trimStart();
      const normalized = normalizePathConstraint(value.startsWith("!") ? value.slice(1) : value, cwd);
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
