import type { ExecutePatchResult } from "../../patch/types.ts";
import { buildApplyPatchPreviews, type FilePreview, formatApplyPatchCollapsedDiff, formatApplyPatchSummary, renderApplyPatchCall } from "./rendering.ts";

export interface ApplyPatchRenderSnapshot {
	readonly files: readonly FilePreview[];
	readonly status: "pending" | "partial_failure" | "failed";
	readonly failedTargets?: readonly string[] | undefined;
}

interface ApplyPatchRenderState extends ApplyPatchRenderSnapshot {
	cwd: string;
}

export interface ApplyPatchSuccessDetails {
	status: "success";
	result: ExecutePatchResult;
}

export interface ApplyPatchPartialFailureDetails {
	status: "partial_failure";
	result: ExecutePatchResult;
	failedTargets?: string[] | undefined;
}

export type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

export function getApplyPatchRenderSnapshot(toolCallId: string): ApplyPatchRenderSnapshot | undefined {
	return applyPatchRenderStates.get(toolCallId);
}

export function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails {
	if (!details || typeof details !== "object") return false;
	const record = details as Record<string, unknown>;
	if (record["status"] !== "success" && record["status"] !== "partial_failure") return false;
	const result = record["result"];
	if (!result || typeof result !== "object") return false;
	const patchResult = result as Record<string, unknown>;
	if (
		!isStringArray(patchResult["changedFiles"]) ||
		!isStringArray(patchResult["createdFiles"]) ||
		!isStringArray(patchResult["deletedFiles"]) ||
		!isStringArray(patchResult["movedFiles"]) ||
		typeof patchResult["fuzz"] !== "number" ||
		!Number.isFinite(patchResult["fuzz"])
	)
		return false;
	return (
		record["status"] === "success" ||
		record["failedTargets"] === undefined ||
		isStringArray(record["failedTargets"])
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

export function setApplyPatchRenderState(
	toolCallId: string,
	patchText: string,
	cwd: string,
	status: "pending" | "partial_failure" | "failed" = "pending",
	failedTargets?: string[],
): void {
	const files = buildApplyPatchPreviews(patchText, cwd);
	applyPatchRenderStates.set(toolCallId, { cwd, files, status, failedTargets });
}

export function markApplyPatchPartialFailure(toolCallId: string, failedTargets?: string[]): void {
	markApplyPatchFailure(toolCallId, "partial_failure", failedTargets);
}

export function markApplyPatchFailure(toolCallId: string, status: "partial_failure" | "failed", failedTargets?: string[]): void {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (!existing) return;
	applyPatchRenderStates.set(toolCallId, { ...existing, status, failedTargets });
}

function markFailedTargetLine(line: string, failedTarget: string): string | undefined {
	const suffixMatch = line.match(/ \(\+\d+ -\d+\)$/);
	if (!suffixMatch) return undefined;
	const suffix = suffixMatch[0]!;
	const prefixAndTarget = line.slice(0, -suffix.length);
	const candidatePrefixes = ["• Edit partially failed ", "• Added ", "• Edited ", "• Deleted ", "  └ ", "    "];
	for (const prefix of candidatePrefixes) {
		if (prefixAndTarget === `${prefix}${failedTarget}`) {
			return `${prefix}${failedTarget} failed${suffix}`;
		}
	}
	return undefined;
}

function renderPartialFailureCall(text: string, theme: { fg(role: string, text: string): string }, failedTargets?: readonly string[]): string {
	const lines = text.split("\n");
	if (lines.length === 0) return theme.fg("warning", "• Edit partially failed");
	lines[0] = lines[0]!.replace(/^• (Added|Edited|Deleted)\b/, "• Edit partially failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i]!, failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines.map((line, index) => {
		if (failedLineIndexes.has(index)) return theme.fg("error", line);
		if (index === 0) return theme.fg("warning", line);
		return line;
	}).join("\n");
}

function renderFailedCall(text: string, theme: { fg(role: string, text: string): string }, failedTargets?: readonly string[]): string {
	const lines = text.split("\n");
	if (lines.length === 0) return theme.fg("error", "• Edit failed");
	lines[0] = lines[0]!.replace(/^• (Added|Edited|Deleted)\b/, "• Edit failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i]!, failedTarget);
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

export function renderApplyPatchCallFromState(args: { input?: unknown | undefined }, theme: { fg(role: string, text: string): string; bold(text: string): string }, context?: { toolCallId?: string | undefined; cwd?: string | undefined; expanded?: boolean | undefined; argsComplete?: boolean | undefined; showCollapsedDiff?: boolean | undefined }): string {
	if (context?.argsComplete === false) return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
	const patchText = typeof args.input === "string" ? args.input : "";
	if (patchText.trim().length === 0) return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
	const cached = context?.toolCallId ? applyPatchRenderStates.get(context.toolCallId) : undefined;
	const cwd = cached?.cwd ?? context?.cwd;
	const baseText = context?.expanded
		? renderApplyPatchCall(patchText, cwd, cached?.files)
		: context?.showCollapsedDiff
			? formatApplyPatchCollapsedDiff(patchText, cwd, undefined, cached?.files)
			: formatApplyPatchSummary(patchText, cwd, cached?.files);
	if (baseText.trim().length === 0) {
		if (cached?.status === "failed") return theme.fg("error", "• Edit failed");
		return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
	}
	return cached?.status === "partial_failure"
		? renderPartialFailureCall(baseText, theme, cached.failedTargets)
		: cached?.status === "failed"
			? renderFailedCall(baseText, theme, cached.failedTargets)
			: baseText;
}
