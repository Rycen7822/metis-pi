import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Hint = { detail: string; mimeType: string; original?: string; digest?: string; archiveSession?: string; originalData?: string };
const hash = (data: string) => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
function blobs(ctx: ExtensionContext, session = ctx.sessionManager.getSessionId()): string {
  const directory = ctx.sessionManager.getSessionDir();
  if (!directory) throw new Error("Original images require a persisted session");
  return join(directory, `${session}-blobs`);
}
export function registerImageHints(pi: ExtensionAPI): void {
  let requestHints = new Map<string, Hint[]>();
  const nested = new Map<string, Map<string, Hint>>();
  const clear = () => { requestHints.clear(); nested.clear(); };
  pi.on("session_start", clear); pi.on("session_tree", clear); pi.on("session_shutdown", clear);
  pi.on("tool_result", async (event, ctx) => {
    if (!["view_image", "codemode"].includes(event.toolName)) return;
    const inherited = nested.get(event.toolCallId);
    const hints: Hint[] = [];
    for (const item of event.content) {
      if (item.type !== "image") continue;
      const image = item as typeof item & { detail?: string };
      let hint = inherited?.get(hash(image.data));
      if (image.detail) {
        hint = { detail: image.detail, mimeType: image.mimeType };
        if (image.detail === "original") {
          const digest = hash(image.data);
          if (!ctx.sessionManager.getSessionDir()) { hints.push({ ...hint, originalData: image.data, digest }); continue; }
          const name = `image-${digest}`;
          try {
            const directory = blobs(ctx);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, name), Buffer.from(image.data, "base64"), { mode: 0o600 });
          } catch (error) { return { content: [{ type: "text", text: `Cannot archive original image: ${String(error)}` }], isError: true }; }
          hint = { ...hint, original: name, digest, archiveSession: ctx.sessionManager.getSessionId() };
        }
      }
      hints.push(hint ?? { detail: "auto", mimeType: image.mimeType });
    }
    nested.delete(event.toolCallId);
    if (hints.some((hint) => hint.detail === "ambiguous"))
      return {
        content: [
          {
            type: "text",
            text: "Identical nested image bytes carry different detail hints; emit them in separate codemode calls.",
          },
        ],
        isError: true,
      };
    if (!hints.some((hint) => hint.detail !== "auto")) return;
    const details = event.details && typeof event.details === "object" ? event.details : {};
    return { details: { ...details, imageHints: hints } };
  });
  // Native codemode normalizes child images before image(result) emits them. Carry
  // our hints onto that parent's emitted image, then bind requests by call + ordinal.
  pi.on("tool_execution_end", event => {
    if (!event.parentToolCallId || event.isError) return;
    const hints = (event.result.details as { imageHints?: Hint[] } | undefined)?.imageHints;
    if (!hints) return;
    let images = nested.get(event.parentToolCallId);
    if (!images) nested.set(event.parentToolCallId, images = new Map());
    const put = (digest: string, hint: Hint) => {
      const prior = images!.get(digest);
      images!.set(digest, prior && prior.detail !== hint.detail ? { ...hint, detail: "ambiguous" } : hint);
    };
    const structured = event.result.structuredContent;
    if (structured?.type === "image" && typeof structured.data === "string" && hints[0]) put(hash(structured.data), hints[0]);
    event.result.content.filter((item: any) => item.type === "image").forEach((image: any, index: number) => {
      if (hints[index]) put(hash(image.data), hints[index]!);
    });
  });
  pi.on("context_with_system", event => {
    requestHints = new Map();
    for (const message of event.messages) {
      if (message.role !== "toolResult") continue;
      const hints = (message.details as { imageHints?: Hint[] } | undefined)?.imageHints;
      if (hints) requestHints.set(message.toolCallId.split("|")[0]!.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, ""), hints);
    }
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (!ctx.model?.api.includes("responses") || !event.payload || typeof event.payload !== "object") return;
    const payload = event.payload as { input?: any[] };
    if (!Array.isArray(payload.input)) return;
    let changed = false;
    const input = await Promise.all(
      payload.input.map(async (item) => {
        if (!["function_call_output", "custom_tool_call_output"].includes(item.type) || !Array.isArray(item.output))
          return item;
        const hints = requestHints.get(item.call_id);
        if (!hints) return item;
        let ordinal = 0;
        const output = await Promise.all(
          item.output.map(async (block: any) => {
            if (block.type !== "input_image") return block;
            const hint = hints[ordinal++];
            if (!hint || hint.detail === "auto") return block;
            changed = true;
            const image = { ...block, detail: hint.detail };
            try {
              if (hint.original) {
                if (!hint.archiveSession || !/^[a-zA-Z0-9_-]+$/.test(hint.archiveSession))
                  throw new Error("Invalid original image session");
                const directory = blobs(ctx, hint.archiveSession),
                  path = resolve(directory, hint.original);
                if (relative(directory, path).startsWith("..") || !/^image-[a-f0-9]{64}$/.test(hint.original))
                  throw new Error("Invalid original image archive");
                const data = (await readFile(path)).toString("base64");
                if (hash(data) !== hint.digest) throw new Error("Original image archive changed");
                image.image_url = `data:${hint.mimeType};base64,${data}`;
              }
              if (hint.originalData) image.image_url = `data:${hint.mimeType};base64,${hint.originalData}`;
              return image;
            } catch (error) {
              return {
                type: "input_text",
                text: `Original image unavailable: ${String(error)}. Restore its session blobs before requesting the image.`,
              };
            }
          }),
        );
        return { ...item, output };
      }),
    );
    return changed ? { ...payload, input } : undefined;
  });
}
