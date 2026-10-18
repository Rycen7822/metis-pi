import fs, { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_DIR = path.resolve(os.homedir());
// Match Rust split_whitespace, not JS \s (which differs for U+0085/FEFF).
const FILTER_WHITESPACE = /\p{White_Space}/u;

export function isHomeDir(dir: string): boolean {
  return canonical(dir) === canonical(HOME_DIR);
}

/** Physical notification coverage; lexical index reuse is a separate rule. */
export function coversHomeDir(dir: string): boolean {
  return rootCovers(canonical(dir), canonical(HOME_DIR));
}

export function isFsRoot(dir: string): boolean {
  const resolved = canonical(dir);
  return path.dirname(resolved) === resolved;
}

function canonical(dir: string): string {
  try { return realpathSync.native(dir); }
  catch { return path.resolve(dir); }
}

export function scanOptOutReason(root: string, config: { enableHomeDirScanning: boolean; enableFsRootScanning: boolean }): string | null {
  if (!config.enableHomeDirScanning && isHomeDir(root)) {
    return "Neural search is disabled at $HOME because [neuralSearch].enableHomeDirScanning is false. Use a project directory or enable home scanning in metis-pi.toml.";
  }
  if (!config.enableFsRootScanning && isFsRoot(root)) {
    return "Neural search is disabled at the filesystem root because [neuralSearch].enableFsRootScanning is false. Use a project directory or explicitly enable root scanning in metis-pi.toml.";
  }
  return null;
}

/** Absolute whitespace is path data; only platform separators become '/'. */
export function pathConstraintText(value: string): string {
  return (path.isAbsolute(value) ? value : value.trim()).replaceAll(path.sep, "/");
}

export function resolveAuxRoot(absPath: string): { root: string; suffix: string } | null {
  if (!path.isAbsolute(absPath)) return null;
  const parsedRoot = path.parse(absPath).root;
  const normalized = path.normalize(absPath);
  if (normalized === parsedRoot) return { root: parsedRoot, suffix: "" };
  const parts = normalized.slice(parsedRoot.length).split(path.sep);
  const firstGlob = parts.findIndex(part => /[*?[{]/.test(part));
  const boundary = firstGlob === -1 ? parts.length : firstGlob;
  // Probe the exact path first: an existing filename may contain glob syntax.
  // Otherwise jump to the literal prefix, then walk its ancestors as before.
  for (let i = parts.length; i >= 0; i = i > boundary ? boundary : i - 1) {
    const candidate = path.join(parsedRoot, ...parts.slice(0, i));
    let stat: fs.Stats;
    try { stat = fs.statSync(candidate); } catch { continue; }
    if (stat.isFile()) {
      const suffix = parts.slice(i - 1).join("/");
      return { root: path.dirname(candidate), suffix: i === parts.length ? literalFileGlob(suffix) : suffix };
    }
    if (stat.isDirectory()) return { root: candidate, suffix: parts.slice(i).join("/") };
  }
  return null;
}

/** Bracket literals force exact native glob matches, not filename promotion. */
function literalFileGlob(name: string): string {
  const encoded = name.replace(/[\\*?[\]{},:]/g, char => {
    if (char === "]") return "[]]";
    if (char === "\\") return "[\\\\]";
    // Escape braces inside classes: FFF expands raw pairs before compiling them.
    return char === "{" || char === "}" ? `[\\${char}]` : `[${char}]`;
  });
  if (encoded !== name) return encoded;
  // Force glob classification without putting UTF-8 bytes or ! in a class.
  const ascii = name.search(/[A-Za-z0-9.]/);
  return ascii < 0 ? `{${name},${name}}` : `${name.slice(0, ascii)}[${name[ascii]}]${name.slice(ascii + 1)}`;
}

export function assertEncodableFilter(filter: string): void {
  if (FILTER_WHITESPACE.test(filter)) throw new Error("The native filter grammar cannot encode whitespace inside a filename or glob. Search an existing containing directory, then read the exact file; literal directory paths with spaces use their own index.");
}

/** Reuse a covering index only when its relative filter is representable. */
export function canUseIndexRoot(root: string, target: string): boolean {
  return rootCovers(root, target) && !FILTER_WHITESPACE.test(path.relative(root, target));
}

export function rootCovers(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || !(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`));
}

export function routePathConstraint(pathConstraint: string | undefined, cwd: string): { root: string; suffix: string } | null {
  let candidate = pathConstraint === undefined ? undefined : pathConstraintText(pathConstraint);
  if (!candidate) return null;
  if (candidate === "~" || candidate.startsWith("~/")) candidate = path.join(HOME_DIR, candidate.slice(1));
  if (!path.isAbsolute(candidate)) {
    // Resolve dot segments as well, so ./../sibling and src/../../sibling cannot escape silently.
    if (!candidate.split("/").includes("..") && !FILTER_WHITESPACE.test(candidate)) return null;
    candidate = path.resolve(cwd, candidate);
  }
  if (canUseIndexRoot(cwd, candidate)) return null;
  const route = resolveAuxRoot(candidate);
  if (route) assertEncodableFilter(route.suffix);
  return route;
}
