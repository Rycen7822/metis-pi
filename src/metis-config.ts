import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, linkSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { readLegacyWebAccess, splitWebAccessConfig, WEB_CREDENTIALS_FILE } from "./web-access-config.ts";

export const METIS_CONFIG_FILE = "metis-pi.toml";
export const METIS_CONFIG_GUIDE = "metis-pi-config.md";
const legacyJsonFiles = [
  "metis-pi.json", "settings.json", "dynamic-agents.json",
  "pi-codex-conversion.json", "subagents.json", "session-recall.json",
];
const legacyBackendFile = "subagent-pi/config.toml";
type ObjectValue = Record<string, any>;
export type ReadConfigFile = (path: string) => string | undefined;
export const metisConfigPath = (agentDir: string) => join(agentDir, METIS_CONFIG_FILE);
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const optionalRead: ReadConfigFile = path => {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};
export class MetisConfigError extends Error {
  public readonly path: string;
  public readonly reason: string;
  constructor(path: string, reason: string) {
    super(`Configuration unreadable at ${path}: ${reason}`);
    this.path = path; this.reason = reason; this.name = "MetisConfigError";
  }
}
export function parseMetisConfig(text: string, path = METIS_CONFIG_FILE): ObjectValue {
  try { return parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { throw new MetisConfigError(path, `invalid TOML: ${(error as Error).message}`); }
}
let template: string | undefined;
const bundledTemplate = () => template ??= readFileSync(new URL("../metis-pi.toml", import.meta.url), "utf8");
let defaults: ObjectValue | undefined;
export function defaultMetisConfig(): ObjectValue {
  defaults ??= parseMetisConfig(bundledTemplate());
  return structuredClone(defaults);
}
let annotations: Map<string, string[]> | undefined;
function templateAnnotations(): Map<string, string[]> {
  if (annotations) return annotations;
  const result = new Map<string, string[]>();
  let table = "", pending: string[] = [];
  for (const line of bundledTemplate().split("\n")) {
    if (!line.trim() || line.startsWith("#")) { pending.push(line); continue; }
    const header = line.match(/^\[([\w.]+)\]$/);
    const field = line.match(/^(\w+)\s*=/);
    if (header) {
      if (!table) {
        // Drop the template-only introduction (values below are personalized).
        const borders = pending.flatMap((note, i) => /^# ={3,}/.test(note) ? [i] : []);
        pending = pending.slice(borders.at(-2) ?? pending.length);
      }
      table = header[1]!;
      result.set(`[${table}]`, pending);
    } else if (field) result.set(`${table}.${field[1]}`, pending);
    pending = [];
  }
  annotations = result;
  return result;
}
/** Decorate serializer output, never user TOML: smol-toml escapes string newlines on one line. */
export function renderMetisConfig(config: ObjectValue): string {
  const notes = templateAnnotations(), output: string[] = [];
  let table = "";
  for (const line of stringify(config).split("\n")) {
    const header = line.match(/^\[\[?(.*?)\]\]?$/);
    const field = line.match(/^(\w+)\s*=/);
    if (header) {
      table = header[1]!;
      output.push(...(notes.get(`[${table}]`) ?? notes.get(table) ?? []));
    } else if (field) output.push(...(notes.get(`${table}.${field[1]}`) ?? []));
    output.push(line);
  }
  return `# metis-pi · 全局配置\n# 以下为当前有效设置；包内 metis-pi.toml 提供默认值。\n# 参数说明：同目录 ${METIS_CONFIG_GUIDE}。密钥与 Pi 自有设置仍由 Pi 管理。\n\n${output.join("\n")}`;
}
export function mergeMetisConfig(base: ObjectValue, overrides: ObjectValue): ObjectValue {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    // Retain TOML date/time classes and unknown fields, without mutating the inputs.
    Object.defineProperty(result, key, { value: object(value) && object(result[key]) ? mergeMetisConfig(result[key], value) : value,
      enumerable: true, writable: true, configurable: true });
  }
  return result;
}
const nullable = ["autoBudgetThreshold", "budgetTurnDelta", "frontierGapThresholdTokens", "maxImagesPerRequest"];
export function encodePruneConfig(config: ObjectValue): ObjectValue {
  const copy = { ...config };
  for (const key of nullable) if (copy[key] === null) copy[key] = false;
  return copy;
}
export function decodePruneConfig(config: ObjectValue): ObjectValue {
  const copy = { ...config };
  for (const key of nullable) if (copy[key] === false) copy[key] = null;
  return copy;
}
function readText(path: string, read: ReadConfigFile): string | undefined {
  try { return read(path); }
  catch (error) { throw new MetisConfigError(path, (error as NodeJS.ErrnoException).code ?? String(error)); }
}
function readJson(path: string, read: ReadConfigFile): ObjectValue | undefined {
  const text = readText(path, read);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!object(value)) throw new Error("not a JSON object");
    return value;
  } catch (error) {
    throw new MetisConfigError(path, `invalid legacy JSON: ${(error as Error).message}`);
  }
}
function camelizeTable(raw: ObjectValue): ObjectValue {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}
function legacySubagentBackend(raw: ObjectValue): ObjectValue {
  const result = camelizeTable(raw);
  if (raw["default_run_timeout_seconds"] !== undefined) {
    result["defaultIdleTimeoutSeconds"] ??= raw["default_run_timeout_seconds"];
    delete result["defaultRunTimeoutSeconds"];
  }
  if (object(raw["inheritance"])) result["inheritance"] = camelizeTable(raw["inheritance"]);
  if (object(raw["profiles"]))
    result["profiles"] = Object.fromEntries(
      Object.entries(raw["profiles"]).map(([name, profile]) => [
        name,
        object(profile) ? camelizeTable(profile) : profile,
      ]),
    );
  return result;
}
function readLegacyMetisConfig(agentDir: string, read: ReadConfigFile) {
  const base = defaultMetisConfig(),
    notes: string[] = [];
  const [old, pi, dynamic, conversion, formerAgents, recall] = legacyJsonFiles.map((name) =>
    readJson(join(agentDir, name), read),
  );
  const backendPath = join(agentDir, legacyBackendFile),
    backendText = readText(backendPath, read);
  let subagents: ObjectValue = {};
  if (formerAgents) {
    if (formerAgents["maxConcurrent"] !== undefined) subagents["maxResidentAgents"] = formerAgents["maxConcurrent"];
    for (const key of Object.keys(formerAgents).filter((key) => key !== "maxConcurrent"))
      notes.push(
        "subagents.json." +
          `${key}` +
          ": old provider option is not a native backend setting; original file kept, not installed as an inert knob",
      );
  }
  if (backendText !== undefined)
    subagents = mergeMetisConfig(subagents, legacySubagentBackend(parseMetisConfig(backendText, backendPath)));
  const appearance = Object.fromEntries(
    Object.keys(base["appearance"])
      .filter((key) => old?.[key] !== undefined)
      .map((key) => [key, old![key]]),
  );
  const execution = mergeMetisConfig(
    { tools: conversion?.["tools"] ?? {}, ui: conversion?.["ui"] ?? {} },
    old?.["execution"] ?? {},
  );
  const recallModel = recall?.["queryModel"];
  const sessionRecall = typeof recallModel?.["provider"] === "string" && recallModel["provider"]
    && typeof recallModel["id"] === "string" && recallModel["id"]
    ? { queryModel: `${recallModel["provider"]}/${recallModel["id"]}` } : {};
  const web = readLegacyWebAccess(agentDir, path => readText(path, read));
  const imported = {
    appearance,
    execution,
    mcp: old?.["mcp"] ?? {},
    subagents,
    contextPrune: object(pi?.["contextPrune"]) ? encodePruneConfig(pi["contextPrune"]) : {},
    dynamicAgents: dynamic ? { ...dynamic, enabled: dynamic["enabled"] !== false } : {},
    sessionRecall,
    webAccess: web?.preferences ?? {},
  };
  return {
    imported,
    notes,
    present: !!(old || pi?.["contextPrune"] || dynamic || conversion || formerAgents || recall || web || backendText !== undefined),
  };
}
/** Read-only bridge until the single global TOML exists. Never read project metis settings. */
export function readMetisConfig(
  agentDir: string,
  read: ReadConfigFile = optionalRead,
): { config: ObjectValue; present: boolean; legacy: boolean; notes: string[] } {
  const path = metisConfigPath(agentDir),
    text = readText(path, read);
  if (text !== undefined)
    return {
      config: mergeMetisConfig(defaultMetisConfig(), parseMetisConfig(text, path)),
      present: true,
      legacy: false,
      notes: [],
    };
  const legacy = readLegacyMetisConfig(agentDir, read);
  return {
    config: mergeMetisConfig(defaultMetisConfig(), legacy.imported),
    present: legacy.present,
    legacy: legacy.present,
    notes: legacy.notes,
  };
}

let cachedWebToml: { path: string; text: string; config: ObjectValue } | undefined;
export function readWebAccessConfig(agentDir: string): ObjectValue {
  try {
    const path = metisConfigPath(agentDir), text = readText(path, optionalRead);
    const legacy = readLegacyWebAccess(agentDir, optionalRead);
    if (text !== undefined && (cachedWebToml?.path !== path || cachedWebToml.text !== text)) {
      cachedWebToml = { path, text, config: parseMetisConfig(text, path) };
    }
    const config = text === undefined ? legacy?.preferences ?? {} : cachedWebToml!.config["webAccess"] ?? {};
    if (!object(config)) throw new MetisConfigError(metisConfigPath(agentDir), "webAccess must be a table");
    const { preferences, credentials } = splitWebAccessConfig(config);
    if (text !== undefined && Object.keys(credentials).length) {
      throw new MetisConfigError(metisConfigPath(agentDir), `webAccess credentials belong in ${WEB_CREDENTIALS_FILE}`);
    }
    return structuredClone({
      ...defaultMetisConfig()["webAccess"], ...preferences,
      ...(legacy ? splitWebAccessConfig(legacy.config).credentials : {}),
    });
  } catch (error) {
    if (error instanceof MetisConfigError) throw new Error(`Failed to parse ${error.path}: ${error.reason}`, { cause: error });
    throw error;
  }
}

export function updateWebAccessConfig(agentDir: string, patch: ObjectValue): void {
  const { preferences, credentials } = splitWebAccessConfig(patch);
  if (Object.keys(credentials).length) throw new Error(`Store Web Access credentials in ${WEB_CREDENTIALS_FILE}`);
  updateMetisConfig(agentDir, { webAccess: preferences });
}
function installGuide(agentDir: string): void {
  try {
    atomicWrite(
      join(agentDir, METIS_CONFIG_GUIDE),
      readFileSync(new URL("../metis-pi-config.md", import.meta.url), "utf8"),
      true,
    );
  } catch (error) {
    throw new Error(
      `Configuration ready at ${metisConfigPath(agentDir)}, but parameter guide could not be installed: ${(error as Error).message}`,
    );
  }
}
function atomicWrite(path: string, text: string, exclusive = false): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    if (exclusive) {
      try { linkSync(temp, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    } else renameSync(temp, path);
    return true;
  }
  finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

function persistWebCredentials(agentDir: string): void {
  const legacy = readLegacyWebAccess(agentDir, optionalRead);
  if (!legacy) return;
  const { preferences, credentials } = splitWebAccessConfig(legacy.config);
  const target = join(agentDir, WEB_CREDENTIALS_FILE);
  if (legacy.path === target && !Object.keys(preferences).length) return;
  if (legacy.path === target) {
    const directory = join(agentDir, "backups", `web-search-${Date.now()}-${randomBytes(3).toString("hex")}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    copyFileSync(target, join(directory, WEB_CREDENTIALS_FILE));
  } else if (!Object.keys(credentials).length) return;
  atomicWrite(target, `${JSON.stringify(credentials, null, 2)}\n`, legacy.path !== target);
}
/** All in-process writers use one synchronous read/merge/atomic-write boundary. */
export function updateMetisConfig(agentDir: string, patch: ObjectValue): void {
  const current = readMetisConfig(agentDir);
  atomicWrite(metisConfigPath(agentDir), renderMetisConfig(mergeMetisConfig(current.config, patch)));
  if (current.legacy) persistWebCredentials(agentDir);
  // A documentation failure must not report a successfully persisted setting as lost.
  try { installGuide(agentDir); } catch { /* /metis-config init can retry guide installation */ }
}
/** Explicit initialization; mixed credential JSON is backed up before splitting. */
export function initializeMetisConfig(agentDir: string): { created: boolean; legacy: boolean; path: string; notes: string[] } {
  const state = readMetisConfig(agentDir), path = metisConfigPath(agentDir);
  // The snapshot identifies absence; exclusive publication also guards another process's init.
  const created = (!state.present || state.legacy) && atomicWrite(path, renderMetisConfig(state.config), true);
  if (created) persistWebCredentials(agentDir);
  installGuide(agentDir);
  return { created, legacy: created && state.legacy, path, notes: created ? state.notes : [] };
}
