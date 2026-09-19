import { keyHint, truncateToVisualLines, } from "@earendil-works/pi-coding-agent";
import { Container, Image, Spacer, Text, } from "@earendil-works/pi-tui";
export function imagesByMimeType(contents) {
    const images = new Map();
    for (const item of contents) {
        const data = images.get(item.mimeType) ?? new Set();
        data.add(item.data);
        images.set(item.mimeType, data);
    }
    return images;
}
export function previewText(text, theme, hideBody = false) {
    if (!text)
        return "";
    const preview = truncateToVisualLines(text, 5, 100, 0);
    if (hideBody) {
        const lines = preview.skippedCount + preview.visualLines.length;
        return theme.fg("muted", `... (${lines} ${lines === 1 ? "line" : "lines"}, ${expandHint()})`);
    }
    if (preview.skippedCount <= 0)
        return preview.visualLines.join("\n");
    return `${theme.fg("muted", `... (${preview.skippedCount} more lines, ${expandHint()})`)}\n${preview.visualLines.join("\n")}`;
}
export function expandHint() {
    try {
        return keyHint("app.tools.expand", "to expand");
    }
    catch {
        return "ctrl+o to expand";
    }
}
export function renderTextAndImages(text, images, theme) {
    if (images.length === 0)
        return new Text(text, text ? 4 : 0, 0);
    const container = new Container();
    if (text)
        container.addChild(new Text(text, 4, 0));
    for (const [index, image] of images.entries()) {
        if (text || index > 0)
            container.addChild(new Spacer(1));
        container.addChild(new Image(image.data, image.mimeType, { fallbackColor: (value) => theme.fg("dim", value) }, { maxWidthCells: 60, maxHeightCells: 20 }));
    }
    return container;
}
