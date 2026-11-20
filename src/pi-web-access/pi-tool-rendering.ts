import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { toolCall } from "../presentation/components/tool-layout.ts";
import type { ToolState } from "../presentation/terminal-text.ts";
import { normalizeFetchContentParams, type FetchContentParams } from "./fetch-params.ts";
import { formatSeconds } from "./media-errors.ts";
import { buildSearchErrorPlan, type SearchErrorPlan } from "./render-search-error.ts";

/** Shared collapsed/expanded renderer for an error/cancel plan produced by
 * buildSearchErrorPlan(). Used by every tool renderResult's error branch so
 * Ctrl+O (app.tools.expand) reveals diagnostics instead of a dead-end single line. */
export function renderSearchErrorPlan(plan: SearchErrorPlan, expanded: boolean, theme: Theme) {
	if (expanded) {
		return new Text(plan.expanded.map((l, i) => i === 0 ? theme.fg("error", l) : theme.fg("toolOutput", l)).join("\n"), 0, 0);
	}
	const box = new Box(0, 0, (t) => theme.bg("toolErrorBg", t));
	box.addChild(new Text(theme.fg("error", plan.expanded[0]), 0, 0));
	for (const line of plan.collapsed) {
		box.addChild(new Text(theme.fg("dim", line), 0, 0));
	}
	if (plan.expandHint) {
		box.addChild(new Text(theme.fg("muted", plan.expandHint), 0, 0));
	}
	return box;
}

export function renderFetchCall(args: FetchContentParams, theme: Theme, context?: ToolState) {
	let normalized: ReturnType<typeof normalizeFetchContentParams>;
	try {
		normalized = normalizeFetchContentParams(args);
	} catch {
		return toolCall(theme.fg("toolTitle", theme.bold("fetch")), [theme.fg("error", "(invalid parameters)")], theme, context);
	}
	const { urlList, options } = normalized;
	const { prompt, timestamp, frames, model, mode, answerModel, auth } = options;
	const title = theme.fg("toolTitle", theme.bold("fetch "));
	if (urlList.length === 0) return toolCall(title, [theme.fg("error", "(no URL)")], theme, context);
	const count = `${urlList.length} ${urlList.length === 1 ? "URL" : "URLs"}`;
	const color = urlList.length === 1 ? "accent" : "muted";
	const lines = urlList.slice(0, 5).map(url => theme.fg(color, url));
	if (urlList.length > 5) lines.push(theme.fg("muted", `... and ${urlList.length - 5} more`));
	if (mode && mode !== "readable") {
		lines.push(theme.fg("dim", "mode: ") + theme.fg("warning", mode));
	}
	if (timestamp) {
		lines.push(theme.fg("dim", "timestamp: ") + theme.fg("warning", timestamp));
	}
	if (typeof frames === "number") {
		lines.push(theme.fg("dim", "frames: ") + theme.fg("warning", String(frames)));
	}
	if (prompt) {
		const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
		lines.push(theme.fg("dim", "prompt: ") + theme.fg("muted", `"${display}"`));
	}
	if (model) {
		lines.push(theme.fg("dim", "model: ") + theme.fg("warning", model));
	}
	if (answerModel) {
		lines.push(theme.fg("dim", "answer model: ") + theme.fg("warning", answerModel));
	}
	if (auth !== undefined) {
		lines.push(theme.fg("dim", "auth: ") + theme.fg("warning", auth === true ? "true" : auth));
	}
	return toolCall(title + theme.fg("accent", count), lines, theme, context);
}

export function renderFetchResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	getSearchContentEnabled: boolean,
) {
	const details = result.details as {
		urlCount?: number;
		successful?: number;
		totalChars?: number;
		error?: string;
		title?: string;
		truncated?: boolean;
		responseId?: string;
		phase?: string;
		progress?: number;
		hasImage?: boolean;
		imageCount?: number;
		prompt?: string;
		timestamp?: string;
		frames?: number;
		duration?: number;
	};

	if (isPartial) {
		const progress = details?.progress ?? 0;
		const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
		return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
	}

	if (details?.error) {
		const fd = details as typeof details & { urls?: string[] };
		const extras: string[] = [];
		if (typeof fd.urlCount === "number" || typeof fd.successful === "number") {
			extras.push(`urls: ${fd.successful ?? 0}/${fd.urlCount ?? 0} succeeded`);
		}
		if (fd.responseId) extras.push(`response id: ${fd.responseId}`);
		if (fd.urls && fd.urls.length > 0) {
			for (const u of fd.urls.slice(0, 8)) extras.push(`  \u25b8 ${u}`);
			if (fd.urls.length > 8) extras.push(`  ... and ${fd.urls.length - 8} more`);
		}
		const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
		if (plan) return renderSearchErrorPlan(plan, expanded, theme);
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	if (details?.urlCount === 1) {
		const title = details?.title || "Untitled";
		const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
		const imageBadge = imgCount > 1
			? theme.fg("accent", ` [${imgCount} images]`)
			: imgCount === 1
				? theme.fg("accent", " [image]")
				: "";
		let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
		if (details?.truncated) {
			statusLine += theme.fg("warning", " [truncated]");
		}
		if (typeof details?.duration === "number") {
			statusLine += theme.fg("muted", ` | ${formatSeconds(Math.floor(details.duration))} total`);
		}
		const textContent = result.content.find((c) => c.type === "text")?.text || "";
		if (!expanded) {
			const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
		}
		const lines = [statusLine];
		if (details?.prompt) {
			const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
			lines.push(theme.fg("dim", `prompt: "${display}"`));
		}
		if (details?.timestamp) {
			lines.push(theme.fg("dim", `timestamp: ${details.timestamp}`));
		}
		if (typeof details?.frames === "number") {
			lines.push(theme.fg("dim", `frames: ${details.frames}`));
		}
		const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
		lines.push(theme.fg("dim", preview));
		return new Text(lines.join("\n"), 0, 0);
	}

	const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
	const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`)
		+ theme.fg("muted", getSearchContentEnabled ? " (content stored)" : " (content fetched)");
	if (!expanded) {
		return new Text(statusLine, 0, 0);
	}
	const textContent = result.content.find((c) => c.type === "text")?.text || "";
	const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
	return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
}
