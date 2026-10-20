import fs from "node:fs";
import path from "node:path";
import { assertEncodableFilter, literalFileGlob, pathConstraintText } from "./paths.ts";

export function hasGlobSyntax(value: string): boolean { return /[*?[{]/.test(value); }

export function normalizePathConstraint(pathConstraint: string, cwd = process.cwd()): string | null {
  let trimmed = pathConstraintText(pathConstraint);
  if (!trimmed) return null;
  const directory = trimmed.endsWith("/");
  const literal = !directory && absoluteFileConstraint(trimmed, cwd);
  if (literal) return literal;
  if (path.isAbsolute(trimmed) || trimmed.split("/").some(part => part === "." || part === "..")) {
    const relative = relativeConstraint(trimmed, cwd);
    if (!relative) return "**/*";
    trimmed = directory ? `${relative}/` : relative;
  }
  assertEncodableFilter(trimmed);
  if (trimmed === "**" || trimmed === "**/" || trimmed === "**/*") return "**/*";
  // fileSearch treats a bare directory token as fuzzy text, unlike grep.
  // Explicit globs enforce the same directory constraint for both APIs.
  if (trimmed.endsWith("/")) return `${trimmed}**`;
  // A slash also makes basename globs unambiguous to the content parser.
  if (hasGlobSyntax(trimmed)) return trimmed.includes("/") ? trimmed : `./${trimmed}`;
  const lastSegment = trimmed.split("/").pop() ?? "";
  return /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment) ? trimmed : `${trimmed}/**`;
}

export function normalizeExcludes(exclude: string | string[] | undefined, cwd = process.cwd()): string[] {
  if (!exclude) return [];
  const out: string[] = [];
  const array = Array.isArray(exclude);
  for (const raw of array ? exclude : [exclude]) {
    // An existing absolute filename owns its commas before list tokenization.
    const value = raw.trimStart();
    const literal = absoluteFileConstraint(pathConstraintText(value.startsWith("!") ? value.slice(1) : value), cwd);
    if (literal) { out.push(`!${literal}`); continue; }
    for (const part of excludeTokens(raw, !array)) {
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

/** Split lists only outside native glob structure; class backslashes are data. */
function excludeTokens(raw: string, whitespace: boolean): string[] {
  const tokens: string[] = [];
  let start = 0, braces = 0, classFirst = -1, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (classFirst >= 0) {
      if (char === "]" && i > classFirst) classFirst = -1;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    // A first ']' after '[' or its negation marker is literal, not a closer.
    if (char === "[") classFirst = i + 1 + Number(raw[i + 1] === "!" || raw[i + 1] === "^");
    else if (char === "{") braces++;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (!braces && (char === "," || whitespace && /\s/.test(char))) {
      tokens.push(raw.slice(start, i)); start = i + 1;
    }
  }
  tokens.push(raw.slice(start));
  return tokens;
}

function relativeConstraint(value: string, cwd: string): string {
  const relative = path.relative(cwd, path.resolve(cwd, value));
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
    throw new Error(`Path constraint must be relative to the search root: ${value}`);
  return relative;
}

/** Literal file identity is independent of main/auxiliary index selection. */
function absoluteFileConstraint(value: string, cwd: string): string | undefined {
  if (!path.isAbsolute(value) || value.endsWith("/")) return;
  let file = false;
  try { file = fs.statSync(value).isFile(); } catch { /* A missing path may still be a glob. */ }
  if (!file) return;
  const relative = relativeConstraint(value, cwd);
  assertEncodableFilter(relative);
  return `./${literalFileGlob(relative)}`;
}
