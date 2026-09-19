import { Container, Spacer, Text, } from "@earendil-works/pi-tui";
import { imagesByMimeType, previewText, renderTextAndImages, } from "./render-content.js";
import { formatNotebookMemoryWarning } from "./tool-result.js";
import { renderTraceAndOutput, } from "./trace-rendering.js";
export function renderTrackedCodeModeResult(result, options, theme, context, tracker, renderStore, tools = [], richRendering = true, minimalOutput = false) {
    if (!options.isPartial && context?.toolCallId) {
        const details = asDetails(result.details);
        tracker.finish(context.toolCallId, details.status === "yielded" ? "yielded" : "done");
    }
    return renderCodeModeResult(result, options, theme, context, tools, renderStore, richRendering, minimalOutput);
}
function renderCodeModeResult(result, options, theme, context, tools, renderStore, richRendering, minimalOutput) {
    const details = asDetails(result.details);
    const content = details.notification || details.status === undefined ? result.content : result.content.slice(1);
    const notebookMemoryText = details.notebookMemory ? formatNotebookMemoryWarning(details.notebookMemory) : undefined;
    const renderedContent = notebookMemoryText
        && content[0]?.type === "text"
        && content[0].text === notebookMemoryText
        ? content.slice(1)
        : content;
    const text = renderedContent
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
    const scriptErrorRenderedByTrace = Boolean(details.scriptError
        && details.traces?.some((trace) => trace.status === "error" && trace.error === details.scriptError));
    const status = scriptErrorRenderedByTrace ? "" : statusText(details);
    const outputText = [text, status].filter(Boolean).join("\n");
    const tone = context?.isError ? "error" : details.status === "yielded" ? "accent" : "dim";
    const renderedText = outputText ? theme.fg(tone, outputText) : "";
    const images = renderedContent.filter((item) => item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string");
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
    const body = renderTraceAndOutput(details.traces ?? [], details.droppedTraceCount ?? 0, tools, output, showOutput && Boolean(renderedText), options, theme, context, emittedImages, renderStore);
    if (!details.notebookMemory || !notebookMemoryText)
        return body;
    const container = new Container();
    const ratio = details.notebookMemory.heapLimitBytes > 0
        ? details.notebookMemory.heapUsedBytes / details.notebookMemory.heapLimitBytes
        : 0;
    container.addChild(new Text(theme.fg(ratio >= 0.9 ? "error" : ratio >= 0.8 ? "accent" : "muted", notebookMemoryText), 0, 0));
    if (details.traces?.length || details.droppedTraceCount || renderedText || images.length) {
        container.addChild(new Spacer(1));
        container.addChild(body);
    }
    return container;
}
function asDetails(value) {
    return value && typeof value === "object" ? value : {};
}
function statusText(details) {
    if (details.scriptError)
        return `Script error: ${details.scriptError}`;
    if (details.status === "yielded" && details.cellId)
        return `Cell #${details.cellId} still running`;
    if (details.status === "terminated")
        return details.cellId ? `Cell #${details.cellId} terminated` : "Cell terminated";
    return "";
}
