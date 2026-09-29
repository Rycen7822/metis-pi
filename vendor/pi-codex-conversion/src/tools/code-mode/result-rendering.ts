import {
	type Component,
	Container,
} from "@earendil-works/pi-tui";
import {
	imagesByMimeType,
	previewText,
	renderTextAndImages,
	type RenderedToolContent,
} from "./render-content.ts";
import type { CodeModeRenderTracker } from "./render-tracker.ts";
import {
	type CodeModeNestedRenderStore,
	renderTraceAndOutput,
} from "./trace-rendering.ts";
import type {
	CodeModeRenderContext,
	CodeModeRenderTheme,
	CodeModeToolDefinition,
	RuntimeToolTrace,
} from "./types.ts";

interface CodeModeResultDetails {
	cellId?: string | undefined;
	status?: "running" | "yielded" | "terminated" | "result" | undefined;
	notification?: boolean | undefined;
	traces?: RuntimeToolTrace[] | undefined;
	droppedTraceCount?: number | undefined;
	scriptError?: string | undefined;
}

export function renderTrackedCodeModeResult(
	result: { content: RenderedToolContent[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: CodeModeRenderTheme,
	context: CodeModeRenderContext | undefined,
	tracker: CodeModeRenderTracker,
	renderStore: CodeModeNestedRenderStore,
	tools: CodeModeToolDefinition[] = [],
	richRendering = true,
	minimalOutput = false,
): Component {
	if (!options.isPartial && context?.toolCallId) {
		const details = asDetails(result.details);
		tracker.finish(context.toolCallId, details.status === "yielded" ? "yielded" : "done");
	}
	return renderCodeModeResult(
		result,
		options,
		theme,
		context,
		tools,
		renderStore,
		richRendering,
		minimalOutput,
	);
}

function renderCodeModeResult(
	result: { content: RenderedToolContent[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: CodeModeRenderTheme,
	context: CodeModeRenderContext | undefined,
	tools: CodeModeToolDefinition[],
	renderStore: CodeModeNestedRenderStore,
	richRendering: boolean,
	minimalOutput: boolean,
): Component {
	const details = asDetails(result.details);
	const content = details.notification || details.status === undefined ? result.content : result.content.slice(1);
	const text = content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
	const scriptErrorRenderedByTrace = Boolean(
		details.scriptError
		&& details.traces?.some((trace) => trace.status === "error" && trace.error === details.scriptError),
	);
	const status = scriptErrorRenderedByTrace ? "" : statusText(details);
	const outputText = [text, status].filter(Boolean).join("\n");
	const tone = context?.isError ? "error" : details.status === "yielded" ? "accent" : "dim";
	const renderedText = outputText ? theme.fg(tone, outputText) : "";
	const images = content.filter(
		(item): item is RenderedToolContent & { data: string; mimeType: string } =>
			item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string",
	);
	const emittedImages = imagesByMimeType(images);
	const showOutput = richRendering
		|| Boolean(details.scriptError && !scriptErrorRenderedByTrace)
		|| details.notification === true
		|| images.length > 0;
	const hidePreview = minimalOutput && !options.expanded
		&& !context?.isError && !details.scriptError && !details.notification;
	const displayText = !showOutput ? "" : hidePreview
		? [
			previewText(text ? theme.fg(tone, text) : "", theme, true),
			status ? theme.fg(tone, status) : "",
		].filter(Boolean).join("\n")
		: options.expanded || options.isPartial ? renderedText : previewText(renderedText, theme);
	const output = showOutput ? renderTextAndImages(displayText, [], theme) : new Container();
	const body = renderTraceAndOutput(
		details.traces ?? [],
		details.droppedTraceCount ?? 0,
		tools,
		output,
		showOutput && Boolean(renderedText),
		options,
		theme,
		context,
		emittedImages,
		renderStore,
	);
	return body;
}

function asDetails(value: unknown): CodeModeResultDetails {
	return value && typeof value === "object" ? value as CodeModeResultDetails : {};
}

function statusText(details: CodeModeResultDetails): string {
	if (details.scriptError) return `Script error: ${details.scriptError}`;
	if (details.status === "yielded" && details.cellId) return `Cell #${details.cellId} still running`;
	if (details.status === "terminated") return details.cellId ? `Cell #${details.cellId} terminated` : "Cell terminated";
	return "";
}
