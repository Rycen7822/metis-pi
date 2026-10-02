import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Tool, Resource, ResourceTemplate } from "@earendil-works/pi-mcp";
import type { McpServerEntry } from "@earendil-works/pi-coding-agent";
import { canonical, isRecord, resolveValues, serverCwd } from "./config.ts";

export interface Catalog { tools: Tool[]; resources: Resource[]; resourceTemplates: ResourceTemplate[]; hasResources: boolean; instructions?: string }
export const emptyCatalog = (): Catalog => ({ tools: [], resources: [], resourceTemplates: [], hasResources: false });
export class CatalogCache {
  private secret: Buffer | undefined;
  readonly dir: string;
  constructor(agentDir: string) {
    this.dir = join(agentDir, "cache", "metis-mcp");
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const key = join(this.dir, ".fingerprint-key");
      try { writeFileSync(key, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      this.secret = readFileSync(key);
      if (this.secret.length !== 32) this.secret = undefined;
    } catch { /* Cache availability never changes config or authorization. */ }
  }
  fingerprint(entry: McpServerEntry, cwd: string, trusted: boolean, authorization: unknown): string | undefined {
    if (!this.secret || ("url" in entry.config && entry.config.auth)) return undefined;
    try {
      const config = entry.config;
      if ("url" in config && config.oauth?.clientSecret?.startsWith("!")) return undefined;
      const values = resolveValues("url" in config ? config.headers : config.env, false);
      return createHmac("sha256", this.secret).update(canonical({ entry, cwd: serverCwd(entry, cwd), roots: cwd,
        trusted, values, environment: process.env, authorization })).digest("hex");
    } catch { return undefined; }
  }
  read(key: string | undefined): Catalog | undefined {
    if (!key) return;
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, `${key}.json`), "utf8"));
      if (raw.version !== 1 || raw.key !== key || !validCatalog(raw.catalog)) return;
      return raw.catalog;
    } catch { return undefined; }
  }
  async write(key: string | undefined, catalog: Catalog, observedAt: number, current: () => boolean): Promise<void> {
    if (!key || !this.secret || !current()) return;
    const path = join(this.dir, `${key}.json`), temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let release: (() => Promise<void>) | undefined;
    let lost = false;
    try {
      release = await lockfile.lock(path, { realpath: false, retries: 3, onCompromised: () => { lost = true; } });
      if (lost || !current()) return;
      try { if (JSON.parse(readFileSync(path, "utf8")).observedAt > observedAt) return; } catch {}
      writeFileSync(temp, JSON.stringify({ version: 1, key, observedAt, catalog }), { mode: 0o600 });
      if (!lost && current()) renameSync(temp, path);
    } catch { /* Discovery still works when the cache cannot be saved. */ }
    finally { rmSync(temp, { force: true }); await release?.().catch(() => {}); }
  }
}
function validCatalog(value: unknown): value is Catalog {
  return isRecord(value) && typeof value.hasResources === "boolean" &&
    Array.isArray(value.tools) && value.tools.every(tool => isRecord(tool) && typeof tool.name === "string" && isRecord(tool.inputSchema)) &&
    Array.isArray(value.resources) && value.resources.every(resource => isRecord(resource) && typeof resource.uri === "string" && typeof resource.name === "string") &&
    Array.isArray(value.resourceTemplates) && value.resourceTemplates.every(resource => isRecord(resource) && typeof resource.uriTemplate === "string" && typeof resource.name === "string") &&
    (value.instructions === undefined || typeof value.instructions === "string");
}
