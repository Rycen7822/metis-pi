import {
	type AgentToolResult,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getBundledToolBinaryPath } from "../native/binary.ts";
import { imageContentFromViewImageOutput, imageContentsFromViewImageDetails, type ViewImageContent } from "./output.ts";
import { renderTextWithImages } from "../ui/media.ts";
import { runBundledTool } from "../native/runner.ts";
import { renderCodexToolCell } from "../ui/tool-cell.ts";
import { supportsViewImageInputs } from "./support.ts";

const VIEW_IMAGE_UNSUPPORTED_MESSAGE = "view_image is not allowed because you do not support image inputs";
const IMAGE_DESCRIPTION_MODEL = "gpt-5.6-luna";
const IMAGE_DESCRIPTION_PROMPT = "Describe this image in detail. Output only the image description, no other commentary";
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

function createViewImageParameters() {
	const properties: Record<string, TSchema> = { path: Type.String(), detail: Type.Optional(Type.Literal("original")) };
	return Type.Object(properties);
}

export function parseViewImageParams(params: unknown): ViewImageParams {
	if (!params || typeof params !== "object" || !("path" in params) || typeof params.path !== "string") {
		throw new Error("view_image requires a string 'path' parameter");
	}
	if ("detail" in params) {
		const rawDetail = params.detail;
		if (rawDetail !== null && rawDetail !== undefined && typeof rawDetail !== "string") {
			throw new Error("view_image.detail must be a string when provided");
		}
		if (typeof rawDetail === "string" && rawDetail !== "original") {
			throw new Error(`view_image.detail only supports \`original\`, got \`${rawDetail}\``);
		}
	}
	return { path: params.path.startsWith("@") ? params.path.slice(1) : params.path };
}

function prepareViewImageArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") {
		return args as Record<string, unknown>;
	}

	const record = args as Record<string, unknown>;
	const prepared: Record<string, unknown> = { ...record };
	if (!("path" in prepared)) {
		if ("file_path" in prepared) {
			prepared["path"] = prepared["file_path"]!;
		} else if ("image_path" in prepared) {
			prepared["path"] = prepared["image_path"]!;
		}
	}
	return prepared;
}

async function executeRustViewImageContent(params: ViewImageParams, cwd: string, signal: AbortSignal | undefined, customRustBinariesDir?: string | undefined): Promise<ViewImageContent> {
	const binary = getBundledToolBinaryPath("view_image", {}, customRustBinariesDir);
	if (!binary) {
		throw new Error(`view_image binary is not bundled for ${process.platform}-${process.arch}`);
	}
	const child = await runBundledTool({
		binary,
		args: [JSON.stringify(params)],
		cwd,
		signal,
		label: "view_image",
	});
	if (child.status !== 0) {
		throw new Error((child.stderr || child.stdout || "view_image failed").trim());
	}
	const imageContent = imageContentFromViewImageOutput(child.stdout);
	if (!imageContent) {
		throw new Error("view_image expected an image file. Use exec_command for text files");
	}
	return imageContent;
}

async function executeRustViewImage(params: ViewImageParams, cwd: string, signal: AbortSignal | undefined, customRustBinariesDir?: string | undefined): Promise<AgentToolResult<unknown>> {
	const imageContent = await executeRustViewImageContent(params, cwd, signal, customRustBinariesDir);
	return { content: [imageContent], details: { viewImage: true }, structuredContent: { type: "image", data: imageContent.data, mimeType: imageContent.mimeType } };
}

function isUsableDescriptionModel(model: ExtensionContext["model"]): boolean {
  return model?.provider === "openai-codex" && !!model.input?.includes("image");
}

function modelVersionScore(id: string): number[] {
	return [...id.matchAll(/\d+/g)].map((match) => Number.parseInt(match[0]!, 10));
}

function compareModelIdsDescending(left: string, right: string): number {
	const a = modelVersionScore(left);
	const b = modelVersionScore(right);
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (b[index] ?? 0) - (a[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return right.localeCompare(left);
}

export function resolveImageDescriptionModel(ctx: ExtensionContext): NonNullable<ExtensionContext["model"]> {
  const models = ctx.modelRegistry.getAvailable().filter(isUsableDescriptionModel);
  const model = models.filter(model => model.id.toLowerCase().includes("mini"))
    .sort((a, b) => compareModelIdsDescending(a.id, b.id))[0]
    ?? models.find(model => model.id === IMAGE_DESCRIPTION_MODEL);
  if (!model) throw new Error("view_image fallback requires an authenticated OpenAI Codex image model");
  return model;
}
export async function describeImageContentForTextModel(image: ViewImageContent, ctx: ExtensionContext, signal: AbortSignal | undefined) {
  const model = resolveImageDescriptionModel(ctx);
  const message = await ctx.modelRegistry.streamSimple(model, {
    systemPrompt: IMAGE_DESCRIPTION_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: "Describe the image" }, image], timestamp: Date.now() }],
  }, { ...(signal ? { signal } : {}), onPayload(payload) {
    if (!image.detail || !payload || typeof payload !== "object") return;
    const request = payload as { input?: any[] };
    if (!Array.isArray(request.input)) return;
    return { ...request, input: request.input.map(item => item.role !== "user" || !Array.isArray(item.content) ? item
      : { ...item, content: item.content.map((block: any) => block.type !== "input_image" ? block
        : { ...block, detail: image.detail, image_url: `data:${image.mimeType};base64,${image.data}` }) }) };
  } }).result();
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? "Image description failed");
  const text = message.content.filter(item => item.type === "text").map(item => item.text).join("").trim();
  if (!text) throw new Error("view_image description returned no text");
  return { text, usage: message.usage };
}

export function createViewImageTool(options: CreateViewImageToolOptions = {}): ToolDefinition<ViewImageParameters> {
	const parameters = createViewImageParameters();

	return {
		name: "view_image",
		label: "view_image",
		description: "View image",
		...(options.promptSnippet === false ? {} : { promptSnippet: "View image" }),
		parameters,
		outputSchema: Type.Union([Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }), Type.Object({ description: Type.String() })]),
		prepareArguments: prepareViewImageArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!supportsViewImageInputs(ctx.model) && !options.describeForTextModels) {
				throw new Error(VIEW_IMAGE_UNSUPPORTED_MESSAGE);
			}
			const typedParams = parseViewImageParams(params);
			if (!supportsViewImageInputs(ctx.model)) {
				const image = await executeRustViewImageContent(typedParams, ctx.cwd, signal, options.customRustBinariesDir);
				const { text: description, usage } = await describeImageContentForTextModel(image, ctx, signal);
				return { content: [{ type: "text", text: description }], structuredContent: { description }, usage, details: { viewImageDescription: { image, path: typedParams.path, description } } };
			}
			return executeRustViewImage(typedParams, ctx.cwd, signal, options.customRustBinariesDir);
		},
		...(options.customRendering === false ? {} : {
		renderCall(args, theme) {
			return renderCodexToolCell("Viewed Image", typeof args["path"]! === "string" ? args["path"]! : undefined, theme);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Loading image..."), 0, 0);
			}
			const textBlock = result.content.find((item) => item.type === "text");
			const text = theme.fg("dim", textBlock?.type === "text" ? textBlock.text : "");
			const content = result.content.some((item) => item.type === "image") ? result.content : [...result.content, ...imageContentsFromViewImageDetails(result.details)];
			return renderTextWithImages(text, content, theme);
		},
		}),
	};
}
