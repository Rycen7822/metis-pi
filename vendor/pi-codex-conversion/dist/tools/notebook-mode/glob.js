export function globMatcher(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const expression = new RegExp(`^${escaped}$`, "i");
    return (value) => expression.test(value);
}
