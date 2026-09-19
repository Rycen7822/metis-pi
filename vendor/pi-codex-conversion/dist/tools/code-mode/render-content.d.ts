import { Container, Text } from "@earendil-works/pi-tui";
import type { CodeModeRenderTheme } from "./types.js";
export interface RenderedToolContent {
    type: string;
    text?: string | undefined;
    data?: string | undefined;
    mimeType?: string | undefined;
}
export declare function imagesByMimeType(contents: Array<RenderedToolContent & {
    data: string;
    mimeType: string;
}>): Map<string, Set<string>>;
export declare function previewText(text: string, theme: CodeModeRenderTheme, hideBody?: boolean): string;
export declare function expandHint(): string;
export declare function renderTextAndImages(text: string, images: Array<RenderedToolContent & {
    data: string;
    mimeType: string;
}>, theme: CodeModeRenderTheme): Text | Container;
