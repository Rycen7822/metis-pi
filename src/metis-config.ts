import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, linkSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "smol-toml";

export const METIS_CONFIG_FILE = "metis-pi.toml";
export const METIS_CONFIG_GUIDE = "metis-pi-config.md";
const legacyJsonFiles = ["metis-pi.json", "settings.json", "dynamic-agents.json", "pi-codex-conversion.json", "subagents.json"];
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
  } catch (error) { throw new MetisConfigError(path, `invalid legacy JSON: ${(error as Error).message}`); }
}
function camelizeTable(raw: ObjectValue): ObjectValue {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
}
function legacySubagentBackend(raw: ObjectValue): ObjectValue {
  const result = camelizeTable(raw);
  if (raw["default_run_timeout_seconds"] !== undefined) {
    result["defaultIdleTimeoutSeconds"] ??= raw["default_run_timeout_seconds"];
    delete result["defaultRunTimeoutSeconds"];
  }
  if (object(raw["inheritance"])) result["inheritance"] = camelizeTable(raw["inheritance"]);
  if (object(raw["profiles"])) result["profiles"] = Object.fromEntries(Object.entries(raw["profiles"]).map(([name, profile]) => [name, object(profile) ? camelizeTable(profile) : profile]));
  return result;
}
function readLegacyMetisConfig(agentDir: string, read: ReadConfigFile) {
  const base = defaultMetisConfig(), notes: string[] = [];
  const [old, pi, dynamic, conversion, formerAgents] = legacyJsonFiles.map(name => readJson(join(agentDir, name), read));
  const backendPath = join(agentDir, legacyBackendFile), backendText = readText(backendPath, read);
  let subagents: ObjectValue = {};
  if (formerAgents) {
    if (formerAgents["maxConcurrent"] !== undefined) subagents["maxResidentAgents"] = formerAgents["maxConcurrent"];
    for (const key of Object.keys(formerAgents).filter(key => key !== "maxConcurrent"))
      notes.push(`subagents.json.${key}: old provider option is not a native backend setting; original file kept (migrate also backs it up), not installed as an inert knob`);
  }
  if (backendText !== undefined) subagents = mergeMetisConfig(subagents, legacySubagentBackend(parseMetisConfig(backendText, backendPath)));
  const appearance = Object.fromEntries(Object.keys(base["appearance"]).filter(key => old?.[key] !== undefined).map(key => [key, old![key]]));
  const execution = mergeMetisConfig({ tools: conversion?.["tools"] ?? {}, ui: conversion?.["ui"] ?? {} }, old?.["execution"] ?? {});
  const imported = { appearance, execution, mcp: old?.["mcp"] ?? {}, subagents,
    contextPrune: object(pi?.["contextPrune"]) ? encodePruneConfig(pi["contextPrune"]) : {},
    dynamicAgents: dynamic ? { ...dynamic, enabled: dynamic["enabled"] !== false } : {} };
  return { imported, notes, present: !!(old || pi?.["contextPrune"] || dynamic || conversion || formerAgents || backendText !== undefined) };
}
/** Read-only bridge until the single global TOML exists. Never read project metis settings. */
export function readMetisConfig(agentDir: string, read: ReadConfigFile = optionalRead): { config: ObjectValue; present: boolean; legacy: boolean; notes: string[] } {
  const path = metisConfigPath(agentDir), text = readText(path, read);
  if (text !== undefined) return { config: mergeMetisConfig(defaultMetisConfig(), parseMetisConfig(text, path)), present: true, legacy: false, notes: [] };
  const legacy = readLegacyMetisConfig(agentDir, read);
  return { config: mergeMetisConfig(defaultMetisConfig(), legacy.imported), present: legacy.present, legacy: legacy.present, notes: legacy.notes };
}
function installGuide(agentDir: string, replace = false): void {
  try { atomicWrite(join(agentDir, METIS_CONFIG_GUIDE), readFileSync(new URL("../metis-pi-config.md", import.meta.url), "utf8"), !replace); }
  catch (error) { throw new Error(`Configuration ready at ${metisConfigPath(agentDir)}, but parameter guide could not be installed: ${(error as Error).message}`); }
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
/** All in-process writers use one synchronous read/merge/atomic-write boundary. */
export function updateMetisConfig(agentDir: string, patch: ObjectValue): void {
  const current = readMetisConfig(agentDir).config;
  atomicWrite(metisConfigPath(agentDir), renderMetisConfig(mergeMetisConfig(current, patch)));
  // A documentation failure must not report a successfully persisted setting as lost.
  try { installGuide(agentDir); } catch { /* /metis-config init can retry guide installation */ }
}
/** Upgrade an existing TOML without letting old preferences replace current customized values. */
export function migrateMetisConfig(agentDir: string): { path: string; backup: string; notes: string[] } {
  const path = metisConfigPath(agentDir), text = readText(path, optionalRead);
  const raw = text === undefined ? {} : parseMetisConfig(text, path);
  const defaults = defaultMetisConfig(), legacy = readLegacyMetisConfig(agentDir, optionalRead);
  const config = mergeMetisConfig(mergeMetisConfig(defaults, legacy.imported), raw);
  // The predecessor shortcut was omitted by the first migration. Repair only untouched defaults.
  const oldUi = legacy.imported.execution["ui"], currentUi = raw["execution"]?.["ui"];
  if (object(oldUi)) for (const [key, value] of Object.entries(oldUi)) {
    const current = currentUi?.[key], fallback = defaults["execution"]["ui"][key];
    if (current === undefined || current === fallback) config["execution"]["ui"][key] = value;
    else if (current !== value) legacy.notes.push(`execution.ui.${key}: kept current TOML override instead of predecessor value`);
  }
  const backup = join(agentDir, "backups", `metis-config-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const name of [METIS_CONFIG_FILE, METIS_CONFIG_GUIDE, ...legacyJsonFiles, legacyBackendFile]) {
    const target = join(backup, name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    try { copyFileSync(join(agentDir, name), target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  atomicWrite(path, renderMetisConfig(config));
  installGuide(agentDir, true);
  return { path, backup, notes: legacy.notes };
}
/** Explicit initialization; legacy files remain intact for rollback to old code. */
export function initializeMetisConfig(agentDir: string): { created: boolean; legacy: boolean; path: string; notes: string[] } {
  const state = readMetisConfig(agentDir), path = metisConfigPath(agentDir);
  // The snapshot identifies absence; exclusive publication also guards another process's init.
  const created = (!state.present || state.legacy) && atomicWrite(path, renderMetisConfig(state.config), true);
  installGuide(agentDir);
  return { created, legacy: created && state.legacy, path, notes: created ? state.notes : [] };
}
