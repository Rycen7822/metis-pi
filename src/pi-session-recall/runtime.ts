import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { isMetisConfigTable, readMetisConfig } from "../configuration/store.ts";

export const recallScope = Type.Union([
  Type.Object({ kind: Type.Literal("all") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("project") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("session"), sessionPath: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("branch"), sessionPath: Type.String({ minLength: 1 }), leafId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

type RecallScope = Static<typeof recallScope>;
type NativeScope =
  | { kind: "all" }
  | { kind: "project"; cwd: string }
  | { kind: "session"; path: string }
  | { kind: "branch"; path: string; leaf: string };
type Operation = { type: "refresh" } | { type: "search"; scope: NativeScope; query: string; refreshMillis: number };

const count = Type.Integer({ minimum: 0 });
const response = Type.Object({
  protocol: Type.Literal(1),
  coverage: Type.Object({
    indexedSources: count, pendingSources: count, incompleteSources: count, complete: Type.Boolean(),
  }),
  results: Type.Union([Type.Null(), Type.Object({
    engine: Type.Union([Type.Literal("exact"), Type.Literal("hnsw")]),
    staleCandidates: count,
    sessions: Type.Array(Type.Object({
      sessionPath: Type.String(), sessionId: Type.String(),
      hits: Type.Array(Type.Object({
        entryId: Type.String(),
        parentId: Type.Union([Type.String(), Type.Null()]),
        role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
        text: Type.String(),
        score: Type.Number(),
      }), { maxItems: 3 }),
    }), { maxItems: 10 }),
  })]),
  reason: Type.Union([Type.String(), Type.Null()]),
});
type RecallResponse = Static<typeof response>;

export function backgroundRecallEnabled(agentDir: string): boolean {
  const section = readMetisConfig(agentDir).config.sessionRecall;
  return isMetisConfigTable(section) && section.backgroundIndex === true;
}

function scopedPath(root: string, requested: string): string {
  const file = relative(root, resolve(root, requested));
  if (!file || file === ".." || file.startsWith(`..${sep}`) || isAbsolute(file) || !file.endsWith(".jsonl")) {
    throw new Error("Recall scope must refer to a JSONL session inside the current session store.");
  }
  return file;
}

export async function searchRecall(
  agentDir: string, sessionDir: string, cwd: string, query: string, scope: RecallScope = { kind: "all" }, signal?: AbortSignal,
): Promise<RecallResponse> {
  const root = await realpath(sessionDir);
  let range: NativeScope;
  switch (scope.kind) {
    case "all": range = scope; break;
    case "project": range = { kind: "project", cwd: resolve(cwd) }; break;
    case "session": range = { kind: "session", path: scopedPath(root, scope.sessionPath) }; break;
    case "branch": range = { kind: "branch", path: scopedPath(root, scope.sessionPath), leaf: scope.leafId }; break;
  }
  return runNative(agentDir, root, {
    type: "search", query, scope: range, refreshMillis: backgroundRecallEnabled(agentDir) ? 0 : 200,
  }, signal);
}

export async function refreshRecall(agentDir: string, sessionDir: string, signal: AbortSignal): Promise<RecallResponse> {
  return runNative(agentDir, await realpath(sessionDir), { type: "refresh" }, signal);
}

async function readSmall(file: string): Promise<string> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid local model asset selection.");
  return readFile(file, "utf8");
}

/** The installer publishes Bekko as a separate physical model object; no sgrep process is involved. */
async function locateBekko(agentDir: string): Promise<string> {
  if (process.env.METIS_BEKKO_DIR) return resolve(process.env.METIS_BEKKO_DIR);
  const base = join(agentDir, "metis/neural-search/semantic/linux-x64");
  const selected = (await readSmall(join(base, "current"))).trim();
  if (!/^runtime-[A-Za-z0-9]+$/.test(selected)) throw new Error("Invalid local model asset selection.");
  const catalog: unknown = JSON.parse(await readSmall(join(base, selected, "assets.json")));
  if (typeof catalog !== "object" || !catalog || !("models" in catalog)) throw new Error("Missing local Bekko128 asset.");
  const models = catalog.models;
  if (typeof models !== "object" || !models || !("bekko128" in models)) throw new Error("Missing local Bekko128 asset.");
  const model = models.bekko128;
  if (typeof model !== "object" || !model || !("directory" in model) || typeof model.directory !== "string") {
    throw new Error("Missing local Bekko128 asset directory.");
  }
  return model.directory;
}

let active = 0;

async function runNative(agentDir: string, root: string, operation: Operation, signal?: AbortSignal): Promise<RecallResponse> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Hybrid Recall currently requires Linux x64. Use literal search on this platform.");
  }
  const local = process.env.METIS_RECALL_RUNTIME_DIR;
  const executable = local ? join(resolve(local), "bin/metis-session-recall") :
    fileURLToPath(new URL("./assets/linux-x64/bin/metis-session-recall", import.meta.url));
  if (!(await lstat(executable).catch(() => undefined))?.isFile()) {
    throw new Error("The native Recall worker is not present. Use literal search or install a package with the Recall runtime.");
  }
  const modelDir = await locateBekko(agentDir).catch(() => { throw new Error("No local Bekko128 asset. Use literal search."); });
  const payload = JSON.stringify({ protocol: 1, root, cacheBase: join(agentDir, "cache/session-recall"), modelDir, operation });
  if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("Recall request is too large.");
  const deadline = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  requestSignal.throwIfAborted();
  // Allow a query to start while one refresh is active.
  if (active >= 3) throw new Error("Recall workers are busy; retry the query.");
  active++;
  try {
    const JSONText = await execute(executable, payload, requestSignal);
    const value: unknown = JSON.parse(JSONText);
    if (!Check(response, value)) throw new Error("Unexpected Recall worker response or protocol version.");
    return value;
  } finally {
    active--;
  }
}

function execute(executable: string, payload: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const text: Buffer[] = [], diagnostic: Buffer[] = [];
    let size = 0, errors = 0, failure: unknown;
    const stop = (reason: unknown) => {
      failure ??= reason;
      child.kill("SIGKILL");
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024) stop(new Error("Recall result exceeds the wire budget."));
      else text.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors >= 4096) return;
      const prefix = chunk.subarray(0, 4096 - errors);
      errors += prefix.length;
      diagnostic.push(prefix);
    });
    child.stdin.on("error", stop);
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(Buffer.concat(diagnostic).toString().trim() || "Recall worker failed."));
      else resolve(Buffer.concat(text).toString());
    });
    child.stdin.end(`${payload}\n`);
  });
}
