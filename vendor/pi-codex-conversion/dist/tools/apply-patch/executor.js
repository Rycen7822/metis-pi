import { relative, resolve as resolveNativePath } from "node:path";
import { parsePatchActions } from "../../patch/parser.js";
import { ExecutePatchError } from "../../patch/types.js";
import { getBundledApplyPatchBinaryPath } from "./binary.js";
import { parseSingleJsonLine, runBundledTool } from "../native/runner.js";
function parseRustApplyPatchJson(stdout) {
    const parsed = parseSingleJsonLine(stdout, "apply_patch");
    if (!parsed || typeof parsed !== "object" || !parsed.result) {
        throw new Error("apply_patch returned invalid structured JSON output");
    }
    return parsed;
}
function displayPatchPath(cwd, path) {
    if (!path.startsWith("/")) {
        return path;
    }
    const relativePath = relative(cwd, path);
    return relativePath && !relativePath.startsWith("..") && !relativePath.startsWith("/") ? relativePath : path;
}
function errorMentionsAction(error, action) {
    return error.includes(action.path) || (action.movePath ? error.includes(action.movePath) : false);
}
function collapseDuplicatedError(message) {
    const separator = ": ";
    const halfLength = (message.length - separator.length) / 2;
    if (!Number.isInteger(halfLength) || halfLength <= 0)
        return message;
    const first = message.slice(0, halfLength);
    return message.slice(halfLength, halfLength + separator.length) === separator && message.slice(halfLength + separator.length) === first
        ? first
        : message;
}
function windowsAsciiPathIdentity(path) {
    return path.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
function duplicateSourceError(path) {
    return new Error(`apply_patch rejected: multiple file sections resolve to ${path}. Combine changes for each source file into one section; use multiple @@ hunks for one update`);
}
const SOURCE_FILE_HEADERS = [
    ["*** Add File: ", "add"],
    ["*** Delete File: ", "delete"],
    ["*** Update File: ", "update"],
];
function hasPatchBoundaries(lines) {
    return (lines[0] !== undefined &&
        trimRustWhitespace(lines[0]) === "*** Begin Patch" &&
        trimRustWhitespace(lines.at(-1)) === "*** End Patch");
}
function trimRustWhitespace(text, endOnly = false) {
    // Rust str::trim uses Unicode White_Space (not JavaScript's BOM whitespace).
    return text.replace(endOnly ? /\p{White_Space}+$/u : /^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
function patchLinesForHeaderScan(patchText) {
    const trimmedPatch = trimRustWhitespace(patchText);
    if (!trimmedPatch)
        return undefined;
    const lines = trimmedPatch
        .split("\n")
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (hasPatchBoundaries(lines))
        return lines;
    const first = lines[0];
    const last = lines.at(-1);
    if (lines.length < 4 ||
        (first !== "<<EOF" && first !== "<<'EOF'" && first !== '<<"EOF"') ||
        !last?.endsWith("EOF")) {
        return undefined;
    }
    const innerLines = lines.slice(1, -1);
    return hasPatchBoundaries(innerLines) ? innerLines : undefined;
}
function sourceFileHeader(line) {
    for (const [marker, section] of SOURCE_FILE_HEADERS) {
        if (line.startsWith(marker)) {
            return { path: line.slice(marker.length), section };
        }
    }
    return undefined;
}
function sourcePathsFromPatchHeaders(patchText) {
    const lines = patchLinesForHeaderScan(patchText);
    if (!lines)
        return undefined;
    const paths = [];
    let section = "started";
    let sawEnvironmentId = false;
    // The final marker was trimmed above, as in StreamingPatchParser::finish.
    for (let index = 1; index < lines.length - 1; index += 1) {
        const originalLine = lines[index];
        const line = trimRustWhitespace(originalLine, section === "update");
        if (line === "*** End Patch")
            return undefined;
        const header = sourceFileHeader(line);
        if (header) {
            if (!header.path)
                return undefined;
            paths.push(header.path);
            section = header.section;
            continue;
        }
        if (section === "started") {
            if (!line.startsWith("*** Environment ID:"))
                return undefined;
            const environmentId = trimRustWhitespace(line.slice("*** Environment ID:".length));
            if (sawEnvironmentId || !environmentId)
                return undefined;
            sawEnvironmentId = true;
            continue;
        }
        if (section === "add") {
            if (!originalLine.startsWith("+"))
                return undefined;
            continue;
        }
        if (section === "delete")
            return undefined;
        if (originalLine === "" ||
            originalLine.startsWith(" ") ||
            originalLine.startsWith("+") ||
            originalLine.startsWith("-") ||
            line === "@@" ||
            line.startsWith("@@ ") ||
            line === "*** End of File" ||
            line.startsWith("*** Move to: ")) {
            continue;
        }
        return undefined;
    }
    return paths;
}
function assertUniqueResolvedSourcePaths(cwd, patchText) {
    const sourcePaths = sourcePathsFromPatchHeaders(patchText);
    if (!sourcePaths)
        return;
    const seen = new Set();
    for (const sourcePath of sourcePaths) {
        const resolvedPath = resolveNativePath(cwd, sourcePath);
        const identity = process.platform === "win32"
            ? windowsAsciiPathIdentity(resolvedPath)
            : resolvedPath;
        if (seen.has(identity))
            throw duplicateSourceError(resolvedPath);
        seen.add(identity);
    }
}
export async function executePatchWithRust({ cwd, patchText, signal, customRustBinariesDir }) {
    const binary = getBundledApplyPatchBinaryPath(customRustBinariesDir);
    if (!binary) {
        throw new Error(`apply_patch binary is not bundled for ${process.platform}-${process.arch}`);
    }
    assertUniqueResolvedSourcePaths(cwd, patchText);
    const child = await runBundledTool({
        binary,
        args: [],
        stdin: patchText,
        cwd,
        env: { ...process.env, PI_APPLY_PATCH_JSON: "1" },
        signal,
        label: "apply_patch",
    });
    const parsed = parseRustApplyPatchJson(child.stdout);
    if (parsed.status === "success" && child.status === 0) {
        return parsed.result;
    }
    const result = parsed.result ?? { changedFiles: [], createdFiles: [], deletedFiles: [], movedFiles: [], fuzz: 0 };
    const errorMessage = collapseDuplicatedError(parsed.error ?? child.stderr ?? "apply_patch failed");
    let parsedActions = [];
    try {
        parsedActions = parsePatchActions({ text: patchText }).map((action) => ({
            ...action,
            path: displayPatchPath(cwd, action.path),
            movePath: action.movePath ? displayPatchPath(cwd, action.movePath) : action.movePath,
        }));
    }
    catch {
        // Rust already produced the authoritative parse error.
    }
    const failureAction = parsedActions.find((action) => errorMentionsAction(errorMessage, action));
    const failures = failureAction ? [{ action: failureAction, message: errorMessage }] : [];
    throw new ExecutePatchError(errorMessage, result, failures);
}
