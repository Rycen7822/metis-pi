const DEFAULT_TOOL_NAMESPACE = "functions";
export function codeModeGlobalName(toolKey) {
    let identifier = "";
    let index = 0;
    for (const character of toolKey) {
        const valid = character === "_" || character === "$" ||
            (index === 0
                ? /[A-Za-z]/.test(character)
                : /[A-Za-z0-9]/.test(character));
        identifier += valid ? character : "_";
        index += 1;
    }
    return identifier || "_";
}
export function translateCodeModeUsage(usage, toolName) {
    return translateCodeModeToolReferences(usage, toolName);
}
export function translateCodeModeToolReferences(text, toolName) {
    const globalName = codeModeGlobalName(toolName);
    if (globalName === toolName)
        return text;
    const replacement = () => `tools.${globalName}`;
    const escapedName = escapeRegExp(toolName);
    let translated = text.replace(new RegExp(`\\btools\\s*\\.\\s*${escapedName}(?![A-Za-z0-9_$-])`, "g"), replacement);
    for (const literal of [
        JSON.stringify(toolName),
        `'${toolName.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`,
    ]) {
        translated = translated.replace(new RegExp(`\\btools\\s*\\[\\s*${escapeRegExp(literal)}\\s*\\]`, "g"), replacement);
    }
    return translated;
}
export function translateCodeModeGuideline(guideline, toolName) {
    const globalName = codeModeGlobalName(toolName);
    const translated = translateCodeModeToolReferences(guideline, toolName);
    return globalName !== toolName && translated.startsWith(`${toolName}:`)
        ? `${globalName}${translated.slice(toolName.length)}`
        : translated;
}
export function resolveCodeModeToolIdentity(tool) {
    return tool.toolName ?? { name: tool.name };
}
export function codeModeNameForToolIdentity(identity) {
    const namespace = identity.namespace;
    if (!namespace || namespace === DEFAULT_TOOL_NAMESPACE)
        return identity.name;
    return namespace.endsWith("_") || identity.name.startsWith("_")
        ? `${namespace}${identity.name}`
        : `${namespace}__${identity.name}`;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
