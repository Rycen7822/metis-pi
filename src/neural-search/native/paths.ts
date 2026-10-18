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

export function resolveAuxRoot(absPath: string): { root: string; suffix: string } | null {
  if (!path.isAbsolute(absPath)) return null;
  const parsedRoot = path.parse(absPath).root;
  const trimmed = path.normalize(absPath.trim()).replace(/[\\/]+$/, "") || parsedRoot;
  if (trimmed === parsedRoot.replace(/[\\/]+$/, "") || trimmed === parsedRoot) return { root: parsedRoot, suffix: "" };
  const parts = trimmed.slice(parsedRoot.length).split(path.sep);
  const firstGlob = parts.findIndex(part => /[*?[{]/.test(part));
  const boundary = firstGlob === -1 ? parts.length : firstGlob;
  for (let i = boundary; i >= 0; i--) {
    const candidate = path.join(parsedRoot, ...parts.slice(0, i));
    let stat: fs.Stats;
    try { stat = fs.statSync(candidate); } catch { continue; }
    if (stat.isFile()) return { root: path.dirname(candidate), suffix: parts.slice(i - 1).join("/") };
    if (stat.isDirectory()) return { root: candidate, suffix: parts.slice(i).join("/") };
  }
  return null;
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
  let candidate = pathConstraint?.trim();
  if (!candidate) return null;
  if (candidate === "~" || candidate.startsWith("~/")) candidate = path.join(HOME_DIR, candidate.slice(1));
  if (!path.isAbsolute(candidate)) {
    // Resolve dot segments as well, so ./../sibling and src/../../sibling cannot escape silently.
    if (!candidate.split(/[\\/]/).includes("..") && !FILTER_WHITESPACE.test(candidate)) return null;
    candidate = path.resolve(cwd, candidate);
  }
  if (canUseIndexRoot(cwd, candidate)) return null;
  const route = resolveAuxRoot(candidate);
  if (route) assertEncodableFilter(route.suffix);
  return route;
}
