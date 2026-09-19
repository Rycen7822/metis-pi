import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { renderCodexToolCell } from "./codex-tool-cell.js";
import { renderTextWithImages } from "./media.js";
/** Presentation only: never replace the tool's model-visible content or details. */
export function auxiliaryToolRenderers(failureTitle, present) {
    return {
        renderCall(args, theme, context) {
            const view = present(displayRecord(args));
            const title = context.isError ? theme.fg("error", failureTitle) : context.isPartial ? view.active : view.complete;
            return renderCodexToolCell(title, inlineToolText(view.target), theme);
        },
        renderResult(result, { expanded, isPartial }, theme, context) {
            if (isPartial)
                return new Text("", 0, 0);
            const view = present(displayRecord(context.args), result);
            const body = context.isError ? toolResultText(result) : view.body ?? toolResultText(result);
            const summary = context.isError ? undefined : view.summary;
            const warning = context.isError ? undefined : view.warning;
            const hint = keyHint("app.tools.expand", "to expand");
            return {
                render(width) {
                    const lines = [];
                    if (summary)
                        lines.push(theme.fg("muted", summary));
                    if (warning)
                        lines.push(theme.fg("warning", warning));
                    if (expanded || context.isError || (!summary && !warning)) {
                        const preview = expanded ? undefined : truncateToVisualLines(body, 3, Math.max(1, width - 4), 0);
                        lines.push(theme.fg(context.isError ? "error" : "dim", preview ? preview.visualLines.join("\n") : body));
                        if (preview && preview.skippedCount > 0)
                            lines.push(theme.fg("muted", `… ${preview.skippedCount} more lines · ${hint}`));
                    }
                    else if (body && body !== summary)
                        lines.push(theme.fg("dim", hint));
                    const text = lines.filter(Boolean).join("\n");
                    return renderTextWithImages(text, context.showImages ? result.content : [], theme, { paddingX: text ? 2 : 0 }).render(width);
                },
                invalidate() { },
            };
        },
    };
}
export function displayRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function inlineToolText(value) {
    return typeof value === "string" && value.trim() ? truncateToWidth(value.replace(/\s+/g, " ").trim(), 100, "…") : undefined;
}
function toolResultText(result) {
    return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
