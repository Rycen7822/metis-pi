import { Container, Text } from "@earendil-works/pi-tui";
interface ImageContentLike {
    type: "image";
    data: string;
    mimeType: string;
}
type ToolContentLike = {
    type: string;
    text?: string | undefined;
} | ImageContentLike;
export declare function renderTextWithImages(text: string, content: ToolContentLike[], theme: {
    fg(role: string, text: string): string;
}, options?: {
    paddingX?: number | undefined;
}): Text | Container;
export {};
