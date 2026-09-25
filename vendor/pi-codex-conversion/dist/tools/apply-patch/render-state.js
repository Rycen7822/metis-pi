import { buildApplyPatchPreviews, formatApplyPatchCollapsedDiff, formatApplyPatchSummary, renderApplyPatchCall } from "./rendering.js";
// Pi loads extension entries in separate Jiti module contexts when host peers
// aren't installed beside a package. Keep one store per physical module URL so
// appearance and the tool read the same pre-mutation snapshot in normal installs.
// Existing session cleanup still clears this store; separate checkouts stay isolated.
const renderStateKey = Symbol.for(`metis-pi.apply-patch-render-state:${import.meta.url}`);
const sharedRenderState = globalThis;
const applyPatchRenderStates = sharedRenderState[renderStateKey] ??= new Map();
export function getApplyPatchRenderSnapshot(toolCallId) {
    return applyPatchRenderStates.get(toolCallId);
}
export function isApplyPatchToolDetails(details) {
    if (!details || typeof details !== "object")
        return false;
    const record = details;
    if (record["status"] !== "success" && record["status"] !== "partial_failure")
        return false;
    const result = record["result"];
    if (!result || typeof result !== "object")
        return false;
    const patchResult = result;
    if (!isStringArray(patchResult["changedFiles"]) ||
        !isStringArray(patchResult["createdFiles"]) ||
        !isStringArray(patchResult["deletedFiles"]) ||
        !isStringArray(patchResult["movedFiles"]) ||
        typeof patchResult["fuzz"] !== "number" ||
        !Number.isFinite(patchResult["fuzz"]))
        return false;
    return (record["status"] === "success" ||
        record["failedTargets"] === undefined ||
        isStringArray(record["failedTargets"]));
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
export function clearApplyPatchRenderState() {
    applyPatchRenderStates.clear();
}
export function setApplyPatchRenderState(toolCallId, patchText, cwd, status = "pending", failedTargets, showDiffWhenCollapsed = false) {
    const files = buildApplyPatchPreviews(patchText, cwd);
    applyPatchRenderStates.set(toolCallId, { cwd, files, status, failedTargets, showDiffWhenCollapsed });
}
export function markApplyPatchPartialFailure(toolCallId, failedTargets) {
    markApplyPatchFailure(toolCallId, "partial_failure", failedTargets);
}
export function markApplyPatchFailure(toolCallId, status, failedTargets) {
    const existing = applyPatchRenderStates.get(toolCallId);
    if (!existing)
        return;
    applyPatchRenderStates.set(toolCallId, { ...existing, status, failedTargets });
}
function markFailedTargetLine(line, failedTarget) {
    const suffixMatch = line.match(/ \(\+\d+ -\d+\)$/);
    if (!suffixMatch)
        return undefined;
    const suffix = suffixMatch[0];
    const prefixAndTarget = line.slice(0, -suffix.length);
    const candidatePrefixes = ["• Edit partially failed ", "• Added ", "• Edited ", "• Deleted ", "  └ ", "    "];
    for (const prefix of candidatePrefixes) {
        if (prefixAndTarget === `${prefix}${failedTarget}`) {
            return `${prefix}${failedTarget} failed${suffix}`;
        }
    }
    return undefined;
}
function renderPartialFailureCall(text, theme, failedTargets) {
    const lines = text.split("\n");
    if (lines.length === 0)
        return theme.fg("warning", "• Edit partially failed");
    lines[0] = lines[0].replace(/^• (Added|Edited|Deleted)\b/, "• Edit partially failed");
    const failedLineIndexes = new Set();
    if (failedTargets) {
        for (let i = 0; i < lines.length; i += 1) {
            for (const failedTarget of failedTargets) {
                const failedLine = markFailedTargetLine(lines[i], failedTarget);
                if (failedLine) {
                    lines[i] = failedLine;
                    failedLineIndexes.add(i);
                    break;
                }
            }
        }
    }
    return lines.map((line, index) => {
        if (failedLineIndexes.has(index))
            return theme.fg("error", line);
        if (index === 0)
            return theme.fg("warning", line);
        return line;
    }).join("\n");
}
function renderFailedCall(text, theme, failedTargets) {
    const lines = text.split("\n");
    if (lines.length === 0)
        return theme.fg("error", "• Edit failed");
    lines[0] = lines[0].replace(/^• (Added|Edited|Deleted)\b/, "• Edit failed");
    const failedLineIndexes = new Set();
    if (failedTargets) {
        for (let i = 0; i < lines.length; i += 1) {
            for (const failedTarget of failedTargets) {
                const failedLine = markFailedTargetLine(lines[i], failedTarget);
                if (failedLine) {
                    lines[i] = failedLine;
                    failedLineIndexes.add(i);
                    break;
                }
            }
        }
    }
    return lines.map((line, index) => failedLineIndexes.has(index) || index === 0 ? theme.fg("error", line) : line).join("\n");
}
export function renderApplyPatchCallFromState(args, theme, context) {
    if (context?.argsComplete === false)
        return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
    const patchText = typeof args.input === "string" ? args.input : "";
    if (patchText.trim().length === 0)
        return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
    const cached = context?.toolCallId ? applyPatchRenderStates.get(context.toolCallId) : undefined;
    const cwd = cached?.cwd ?? context?.cwd;
    const baseText = context?.expanded
        ? renderApplyPatchCall(patchText, cwd, cached?.files)
        : context?.showCollapsedDiff
            ? formatApplyPatchCollapsedDiff(patchText, cwd, undefined, cached?.files)
            : formatApplyPatchSummary(patchText, cwd, cached?.files);
    if (baseText.trim().length === 0) {
        if (cached?.status === "failed")
            return theme.fg("error", "• Edit failed");
        return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
    }
    return cached?.status === "partial_failure"
        ? renderPartialFailureCall(baseText, theme, cached.failedTargets)
        : cached?.status === "failed"
            ? renderFailedCall(baseText, theme, cached.failedTargets)
            : baseText;
}
