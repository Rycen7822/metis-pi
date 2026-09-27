// Compile-once: pattern -> RegExp is pure, so the cache never needs
// invalidation. Patterns only come from config arrays, so growth is bounded.
const patternCache = new Map();
export function globToRegExp(pattern) {
    const cached = patternCache.get(pattern);
    if (cached)
        return cached;
    let re = "";
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                if (pattern[i + 2] === "/") {
                    re += "(?:[^/]*/)*"; // `**/` — zero or more whole directories
                    i += 3;
                }
                else {
                    re += ".*"; // bare `**`
                    i += 2;
                }
            }
            else {
                re += "[^/]*"; // `*` — segment-local
                i += 1;
            }
        }
        else if (ch === "?") {
            re += "[^/]";
            i += 1;
        }
        else {
            re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            i += 1;
        }
    }
    const compiled = new RegExp(`^${re}$`);
    patternCache.set(pattern, compiled);
    return compiled;
}
/** Identity normalization shared by protection matching and supersession: slash direction only, no resolution. */
export function normalizePath(path) {
    return path.replace(/\\/g, "/");
}
export function isProtected(toolName, args, config) {
    if (config.protectedTools.includes(toolName))
        return true;
    if (config.protectedPaths.length === 0)
        return false;
    const path = args?.path;
    if (typeof path !== "string")
        return false;
    const normalized = normalizePath(path);
    return config.protectedPaths.some((p) => globToRegExp(p).test(normalized));
}
