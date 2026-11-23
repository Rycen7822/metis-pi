import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUMMARY_INPUT_CHARS } from "./batch-capture.ts";
import type { ContextPruneConfig } from "./types.ts";

function resolveModel(identifier: string, ctx: ExtensionContext): Model<Api> | undefined {
  if (identifier === "default") return ctx.model;
  const slash = identifier.indexOf("/");
  if (slash <= 0 || slash === identifier.length - 1) {
    ctx.ui.notify(`pruner: invalid summarizer model "${identifier}", expected "provider/model-id". Skipping model.`, "warning");
    return undefined;
  }
  const model = ctx.modelRegistry.find(identifier.slice(0, slash), identifier.slice(slash + 1));
  if (!model) ctx.ui.notify(`pruner: model "${identifier}" not found in registry. Skipping model.`, "warning");
  return model;
}

export function modelKey(model: Model<Api> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "unavailable";
}

export function summarizerModels(config: ContextPruneConfig, ctx: ExtensionContext): (Model<Api> | undefined)[] {
  // Keep the primary slot even when unresolved; recovery probes still start here.
  const models = [resolveModel(config.summarizerModel, ctx)];
  const seen = new Set([modelKey(models[0])]);
  for (const identifier of config.summarizerFallbackModels ?? []) {
    const model = resolveModel(identifier, ctx);
    const key = modelKey(model);
    if (!model || seen.has(key) || key === modelKey(ctx.model)) continue;
    seen.add(key);
    models.push(model);
  }
  if (ctx.model && !seen.has(modelKey(ctx.model))) models.push(ctx.model);
  return models;
}

export function summarizerLimits(model: Model<Api> | undefined) {
  const window = model && model.contextWindow > 0 ? model.contextWindow : Infinity;
  const maxTokens = Math.max(16, Math.min(model && model.maxTokens > 0 ? model.maxTokens : 8192, Math.floor(window / 4)));
  // Reserve output and prompt overhead, then allow up to three UTF-8 bytes per code unit.
  const inputChars = Math.max(0, Math.min(SUMMARY_INPUT_CHARS, Math.floor((window - maxTokens - 2048) / 3)));
  return { inputChars, maxTokens };
}

export function summarizerInputBudget(config: ContextPruneConfig, ctx: ExtensionContext): number {
  return Math.min(...summarizerModels(config, ctx).map(model => summarizerLimits(model).inputChars));
}
