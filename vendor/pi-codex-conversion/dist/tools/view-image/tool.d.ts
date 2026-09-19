import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ViewImageContent } from "./output.ts";
interface ViewImageParams {
    path: string;
}
interface CreateViewImageToolOptions {
    customRustBinariesDir?: string | undefined;
    describeForTextModels?: boolean | undefined;
    customRendering?: boolean | undefined;
    promptSnippet?: boolean | undefined;
}
type ViewImageParameters = ReturnType<typeof createViewImageParameters>;
declare function createViewImageParameters(): Type.TObject<Record<string, Type.TSchema>>;
export declare function parseViewImageParams(params: unknown): ViewImageParams;
export declare function resolveImageDescriptionModel(ctx: ExtensionContext): string;
export declare function describeImageContentForTextModel(image: ViewImageContent, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<string>;
export declare function createViewImageTool(options?: CreateViewImageToolOptions): ToolDefinition<ViewImageParameters>;
export declare function registerViewImageTool(pi: ExtensionAPI, options?: CreateViewImageToolOptions): void;
export {};
