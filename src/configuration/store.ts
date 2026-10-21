import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, linkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { lockSync } from "proper-lockfile";

export const METIS_CONFIG_FILE = "metis-pi.toml";
export const METIS_CONFIG_GUIDE = "metis-pi-config.md";
export type MetisConfig = Record<string, unknown>;
export type ReadConfigFile = (path: string) => string | undefined;
export const metisConfigPath = (agentDir: string) => join(agentDir, METIS_CONFIG_FILE);
export const isMetisConfigTable = (value: unknown): value is MetisConfig => !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
export const readOptionalConfigFile: ReadConfigFile = path => {
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
export function parseMetisConfig(text: string, path = METIS_CONFIG_FILE): MetisConfig {
  try { return parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { throw new MetisConfigError(path, `invalid TOML: ${(error as Error).message}`); }
}
let template: string | undefined;
const bundledTemplate = () => template ??= readFileSync(new URL("../../metis-pi.toml", import.meta.url), "utf8");
let defaults: MetisConfig | undefined;
export function defaultMetisConfig(): MetisConfig {
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
export function renderMetisConfig(config: MetisConfig): string {
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
export function mergeMetisConfig(base: MetisConfig, overrides: MetisConfig): MetisConfig {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    // Retain TOML date/time classes and unknown fields, without mutating the inputs.
    Object.defineProperty(result, key, { value: isMetisConfigTable(value) && isMetisConfigTable(result[key]) ? mergeMetisConfig(result[key], value) : value,
      enumerable: true, writable: true, configurable: true });
  }
  return result;
}
export function readMetisConfigText(agentDir: string, read: ReadConfigFile = readOptionalConfigFile): string | undefined {
  const path = metisConfigPath(agentDir);
  try { return read(path); }
  catch (error) { throw new MetisConfigError(path, (error as NodeJS.ErrnoException).code ?? String(error)); }
}
/** Read the single global TOML, or defaults when it is absent. */
export function readMetisConfig(
  agentDir: string,
  read: ReadConfigFile = readOptionalConfigFile,
): { config: MetisConfig; present: boolean } {
  const path = metisConfigPath(agentDir), text = readMetisConfigText(agentDir, read);
  return {
    config: text === undefined ? defaultMetisConfig() : mergeMetisConfig(defaultMetisConfig(), parseMetisConfig(text, path)),
    present: text !== undefined,
  };
}

function installGuide(agentDir: string): void {
  try {
    atomicWrite(
      join(agentDir, METIS_CONFIG_GUIDE),
      readFileSync(new URL("../../metis-pi-config.md", import.meta.url), "utf8"),
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

function withConfigLock<T>(agentDir: string, write: () => T): T {
  mkdirSync(agentDir, { recursive: true });
  const path = metisConfigPath(agentDir);
  const deadline = Date.now() + 5_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let release: () => void;
  for (;;) {
    try {
      release = lockSync(path, { realpath: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  try { return write(); }
  finally { release(); }
}

/** Serialize the fresh read, merge and publication across Pi processes. */
export function updateMetisConfig(agentDir: string, patch: MetisConfig): void {
  withConfigLock(agentDir, () => {
    const current = readMetisConfig(agentDir);
    atomicWrite(metisConfigPath(agentDir), renderMetisConfig(mergeMetisConfig(current.config, patch)));
  });
  // A documentation failure must not report a successfully persisted setting as lost.
  try { installGuide(agentDir); } catch { /* /metis-config init can retry guide installation */ }
}
/** Initialize defaults without importing, rewriting or backing up other files. */
export function initializeMetisConfig(agentDir: string): { created: boolean; path: string } {
  const result = withConfigLock(agentDir, () => {
    const state = readMetisConfig(agentDir), path = metisConfigPath(agentDir);
    const created = !state.present && atomicWrite(path, renderMetisConfig(state.config), true);
    return { created, path };
  });
  installGuide(agentDir);
  return result;
}
