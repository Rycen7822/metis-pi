import type { Model, ModelCost, ModelInputModality, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export type ResponsesApi = "openai-responses" | "openai-codex-responses";
type ModelRoute = Pick<Model<ResponsesApi>, "api" | "provider" | "baseUrl">;
type RecordValue = Record<string, unknown>;
type Manifest = RecordValue & { slug: string };
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

export function catalogRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

export function readManifest(json: unknown): Manifest[] | undefined {
  const values = catalogRecord(json)?.models;
  if (!Array.isArray(values)) return;
  const rows = values.flatMap((value): Manifest[] => {
    const row = catalogRecord(value);
    const slug = row?.slug;
    return row && typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(slug) ? [{ ...row, slug }] : [];
  });
  return rows.length || !values.length ? rows : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function inputModalities(value: unknown): ModelInputModality[] | undefined {
  if (!Array.isArray(value)) return;
  const inputs = value.filter((input): input is ModelInputModality => input === "text" || input === "image");
  return inputs.length ? [...new Set(inputs)] : undefined;
}

function thinking(value: unknown): ThinkingLevelMap | undefined {
  if (!Array.isArray(value)) return;
  const efforts = new Set(value.map(item => catalogRecord(item)?.effort));
  const levels: ThinkingLevelMap = {};
  for (const level of thinkingLevels) {
    const effort = level === "off" ? "none" : level;
    levels[level] = efforts.has(effort) ? effort : null;
  }
  return levels;
}

function rates(value: unknown): ModelCost | undefined {
  const data = catalogRecord(value);
  if (!data) return;
  const { input, output } = data;
  const cacheRead = data.cacheRead ?? data.cache_read;
  const cacheWrite = data.cacheWrite ?? data.cache_write;
  const isRate = (rate: unknown): rate is number => typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
  if (isRate(input) && isRate(output) && isRate(cacheRead) && isRate(cacheWrite)) {
    return { input, output, cacheRead, cacheWrite };
  }
}

// Published standard API rates per MTok. The account catalog supplies the
// route's context and reasoning limits, while these specs fill required gaps.
const publishedSpecs = new Map<string, { maxTokens: number; cost: ModelCost }>([
  // https://developers.openai.com/api/docs/models/gpt-6.2-sol
  ["gpt-6.2-sol", { maxTokens: 128_000, cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] } }],
  // https://developers.openai.com/api/docs/models/gpt-6.2-astra
  ["gpt-6.2-astra", { maxTokens: 128_000, cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
    tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }] } }],
]);

function toModel(
  row: Manifest, known: Model<ResponsesApi> | undefined, extra: Manifest | undefined,
  route: ModelRoute,
): Model<ResponsesApi> | undefined {
  const published = publishedSpecs.get(row.slug);
  const contextWindow = positive(row.context_window) ?? known?.contextWindow ?? positive(extra?.context_window);
  const maxTokens = positive(row.max_output_tokens) ?? known?.maxTokens ?? positive(extra?.max_output_tokens) ?? published?.maxTokens;
  const cost = rates(row.cost) ?? known?.cost ?? rates(extra?.cost) ?? published?.cost;
  const input = inputModalities(row.input_modalities) ?? known?.input ?? inputModalities(extra?.input_modalities);
  const levels = thinking(row.supported_reasoning_levels) ?? thinking(extra?.supported_reasoning_levels);
  const reasoning = levels ? thinkingLevels.some(level => level !== "off" && levels[level] !== null) : known?.reasoning;
  if (!contextWindow || !maxTokens || !cost || !input || reasoning === undefined) return;
  return {
    ...known, ...route, id: row.slug,
    name: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name : known?.name ?? row.slug,
    contextWindow, maxTokens, cost, input, reasoning, thinkingLevelMap: levels ?? known?.thinkingLevelMap,
  };
}

export function isStoredModel(value: unknown, route: ModelRoute): value is Model<ResponsesApi> {
  const model = catalogRecord(value);
  return model?.api === route.api && model.provider === route.provider && model.baseUrl === route.baseUrl
    && typeof model.id === "string" && typeof model.name === "string" && typeof model.reasoning === "boolean"
    && positive(model.contextWindow) !== undefined && positive(model.maxTokens) !== undefined
    && inputModalities(model.input) !== undefined && rates(model.cost) !== undefined;
}

export async function buildAccountModels(
  manifest: Manifest[], knownModels: readonly Model<ResponsesApi>[],
  route: ModelRoute,
  getCodexManifest: () => Promise<Manifest[] | undefined>,
): Promise<Model<ResponsesApi>[]> {
  const visible = new Map(manifest.filter(row => row.visibility === "list").map(row => [row.slug, row]));
  const known = new Map(knownModels.map(model => [model.id, model]));
  const models: Model<ResponsesApi>[] = [];
  let codex: Map<string, Manifest> | undefined;
  for (const row of visible.values()) {
    const base = known.get(row.slug);
    let model = toModel(row, base, undefined, route);
    if (!model) {
      codex ??= new Map((await getCodexManifest())?.map(extra => [extra.slug, extra]));
      model = toModel(row, base, codex.get(row.slug), route);
    }
    if (model) models.push(model);
  }
  return models;
}
