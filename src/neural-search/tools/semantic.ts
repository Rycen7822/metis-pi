import { spawn } from "node:child_process";
import { statSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSemanticRequestSettings } from "../config.ts";
import { HOME_DIR, scanOptOutReason } from "../native/paths.ts";
import type { SearchRuntime } from "../session.ts";
import { safeText } from "../../presentation/terminal-text.ts";
import { CollapsedText, renderTextResult } from "../ui/render.ts";

const OUTPUT_BYTES = 50_000;
const WIRE_BYTES = 16 << 20;
const DIAGNOSTIC_BYTES = 16 << 10;
export const semanticSchema = Type.Object({
  query: Type.String({ minLength: 1,
    description: "Natural-language description or concept to locate. "
      + "Searches the complete selected scope; exact text/regex belongs in grep." }),
  path: Type.Optional(Type.String({ minLength: 1,
    description: "Existing file or directory, relative to cwd or absolute (default cwd). ~/ is supported. "
      + "This is a literal scope, not a filename glob or FFF filter; every chunk in it is scored." })),
  model: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("code")], {
    description: "Default auto: text only for prose-only scope, otherwise code for the entire scope." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100,
    description: "Maximum ranked results (default5, maximum100). Does not prefilter candidates. No pagination cursor." })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600,
    description: "Whole request deadline including service startup, queue waiting and complete scoring (default1800 seconds). "
      + "Timeout is an error, not partial results." })),
}, { additionalProperties: false });

type SemanticScores = {
  bm25: number;
  semantic: number;
  bm25_relative: number;
  semantic_relative: number;
  fused: number;
  exact_identifier: boolean;
};
type SemanticChunk = { path: string; start: number; end: number; content: string; scores: SemanticScores };

export function createSemanticAction(runtime: SearchRuntime, toolName: string): ToolDefinition<typeof semanticSchema> {
  return {
    name: toolName, label: "Semantic",
    description: "按含义搜索代码和文档，适用于自然语言功能描述、实现位置和相关概念检索；"
      + "使用全范围语义评分与 BM25 混合排序。精确文本或正则匹配使用 grep，文件路径查找使用 find。"
      + "No FFF prefilter/frecency or automatic fallback. Requires a prepared CPU runtime.",
    parameters: semanticSchema,
    outputSchema: Type.Unknown(),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const started = performance.now();
      signal?.throwIfAborted();
      if (!params.query.trim() || params.query.includes("\0")) throw new Error("Semantic query must be non-empty and contain no NUL characters.");
      const scope = runtime.bind(ctx);
      const combined = AbortSignal.any([scope.controller.signal, ...(signal ? [signal] : [])]);
      const requested = params.path ?? scope.cwd;
      const expanded = requested === "~" ? HOME_DIR : requested.startsWith("~/") ? path.join(HOME_DIR, requested.slice(2)) : requested;
      const root = path.resolve(scope.cwd, expanded);
      const stat = statSync(root);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("Semantic scope must be an existing regular file or directory.");
      const refusal = scanOptOutReason(root, runtime.config);
      if (refusal) throw new Error(refusal);
      const { selection, idleTimeoutSeconds } = loadSemanticRequestSettings();
      const model = params.model ?? "auto", limit = params.limit ?? 5;
      const wire = await runSemanticCli(root, scope.cwd, params.query, model, limit,
        params.timeoutSeconds ?? 1800, JSON.stringify(selection), idleTimeoutSeconds, combined);
      runtime.assertCurrent(scope);
      combined.throwIfAborted();
      const chunks = parseChunks(wire.stdout, limit);
      const results: SemanticChunk[] = [];
      let bytes = 0;
      for (const chunk of chunks) {
        // UTF-16 length is a lower bound on the record's serialized UTF-8 bytes.
        if (chunk.content.length > OUTPUT_BYTES - bytes) break;
        bytes += Buffer.byteLength(JSON.stringify(chunk));
        if (bytes > OUTPUT_BYTES) break;
        results.push(chunk);
      }
      const outputTruncated = results.length !== chunks.length;
      const next = outputTruncated ? chunks[results.length] : undefined;
      const omitted = next ? { path: next.path, start: next.start, end: next.end } : undefined;
      const notice = next
        ? `\n[Output truncated at ${OUTPUT_BYTES} bytes; only complete ranked-prefix records retained. `
          + `Next result: ${safeText(next.path)}:${next.start}-${next.end}. Read that source or narrow the scope.]` : "";
      const body = results.map(chunk => `${safeText(chunk.path)}:${chunk.start}-${chunk.end}\n${safeText(chunk.content)}`).join("\n\n");
      const diagnostics = wire.stderr ? `\n[CLI diagnostics: ${safeText(wire.stderr)}]` : "";
      const text = (body || (chunks.length ? "No complete result fits the display budget." : "No semantic results.")) + notice + diagnostics;
      const details = { root: stat.isFile() ? path.dirname(root) : root, scope: root,
        protocol: 1, modelRequested: model, cacheBudgetRequestedMiB: selection.budget_mib,
        resultsReturned: results.length, limitReached: chunks.length === limit, outputTruncated, nextOmitted: omitted ?? null,
        elapsedMs: performance.now() - started };
      return { content: [{ type: "text", text }], details,
        structuredContent: { ...details, results, diagnostics: wire.stderr || null } };
    },
    renderCall(args, theme) {
      return new CollapsedText(theme.fg("toolTitle", theme.bold("Semantic")) + " " + theme.fg("accent", safeText(args.query ?? ""))
        + theme.fg("toolOutput", safeText(` in ${args.path ?? "."}`)), "", theme.fg("muted", "..."));
    },
    renderResult: renderTextResult,
  };
}

/** Own only the IPC client's process group. Its disconnect cancels its request;
 * the detached same-user service and other clients are never killed here. */
function runSemanticCli(root: string, cwd: string, query: string, model: string, limit: number,
  timeoutSeconds: number, policy: string, idleTimeoutSeconds: number, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("The semantic CPU runtime currently requires Linux x64; no alternate backend is selected.");
  }
  const runtimeDir = process.env.SGREP_RUNTIME_DIR
    ? path.resolve(process.env.SGREP_RUNTIME_DIR)
    : fileURLToPath(new URL("../assets/semantic/linux-x64/", import.meta.url));
  const binary = path.join(runtimeDir, "bin", "sgrep");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      "--shared-service", "--idle-timeout-seconds", String(idleTimeoutSeconds),
      "--service-timeout-seconds", String(timeoutSeconds), "--json", "--explain", "--metis-protocol", "1",
      "--model", model, "-n", String(limit), "--", query, root,
    ], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SGREP_RUNTIME_DIR: runtimeDir, SGREP_CACHE_POLICY_REQUEST: policy },
    });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let size = 0, errorSize = 0, failure: unknown, killTimer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    function kill(kind: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    function stop(reason: unknown): void {
      if (failed) return;
      failed = true; failure = reason;
      try { kill("SIGTERM"); }
      catch (error) { failure = new Error("Cannot terminate semantic process group", { cause: error }); child.kill("SIGKILL"); }
      killTimer = setTimeout(() => {
        try { kill("SIGKILL"); }
        catch (error) { failure = new Error("Cannot kill semantic process group", { cause: error }); child.kill("SIGKILL"); }
      }, 1000);
    }
    const onAbort = () => stop(signal.reason);
    const deadline = setTimeout(() => stop(new Error(
      `Semantic search timed out after ${timeoutSeconds}s; no partial results returned.`,
    )), timeoutSeconds * 1000);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.on("error", error => stop(new Error(
      `Semantic runtime could not start at ${binary}; install a qualified prepared runtime. No build or fallback was attempted.`,
      { cause: error },
    )));
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > WIRE_BYTES) stop(new Error(
        "Semantic CLI JSON exceeds the16MiB transport limit; reduce result limit or scope. No partial JSON returned.",
      ));
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorSize >= DIAGNOSTIC_BYTES) return;
      const kept = chunk.subarray(0, DIAGNOSTIC_BYTES - errorSize); errors.push(kept); errorSize += kept.length;
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (failed || code !== 0) {
        const reason = failed ? failure : new Error(`Semantic CLI failed (${exitSignal ?? code}): ${stderr || "no diagnostic"}`);
        // Leader close does not mean group exit: a descendant may have ignored
        // SIGTERM and closed its inherited pipes. Finish cleanup before reject.
        void (async () => {
          try {
            kill("SIGKILL");
            if (child.pid !== undefined) await waitForGroupExit(child.pid);
            reject(reason);
          } catch (error) {
            reject(new AggregateError([reason, error], "Semantic request failed and process-group cleanup could not be confirmed."));
          }
        })();
        return;
      }
      resolve({ stdout: Buffer.concat(output).toString("utf8"), stderr });
    });
  });
}

/** Only the exceptional cleanup path inspects process metadata, not FDs. The
 * fixed CLI/rg group retains our UID. Zombies have exited; init owns reaping. */
async function waitForGroupExit(group: number): Promise<void> {
  const until = performance.now() + 5000;
  let delay = 10;
  while (hasLiveGroup(group)) {
    if (performance.now() >= until) throw new Error(`Semantic process group ${group} still has live members after SIGKILL.`);
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 100);
  }
}
function hasLiveGroup(group: number): boolean {
  try { process.kill(-group, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Semantic process-group cleanup requires Linux UID metadata.");
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const root = `/proc/${entry.name}`;
      if (statSync(root).uid !== uid) continue;
      const stat = readFileSync(`${root}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid semantic CLI score.");
  return value;
}
function parseChunks(text: string, limit: number): SemanticChunk[] {
  const wire: unknown = JSON.parse(text);
  if (!isRecord(wire) || wire.protocol !== 1 || !Array.isArray(wire.results) || wire.results.length > limit)
    throw new Error("Unsupported semantic CLI JSON protocol/result count; no fallback attempted.");
  return wire.results.map((chunk: unknown) => {
    if (!isRecord(chunk) || typeof chunk.path !== "string" || !chunk.path || typeof chunk.content !== "string"
      || typeof chunk.start !== "number" || !Number.isSafeInteger(chunk.start) || chunk.start < 1
      || typeof chunk.end !== "number" || !Number.isSafeInteger(chunk.end) || chunk.end < chunk.start
      || !isRecord(chunk.scores) || typeof chunk.scores.exact_identifier !== "boolean") throw new Error("Invalid semantic CLI chunk/range.");
    const scores = chunk.scores;
    return { path: chunk.path, start: chunk.start, end: chunk.end, content: chunk.content,
      scores: { bm25: finite(scores.bm25), semantic: finite(scores.semantic), bm25_relative: finite(scores.bm25_relative),
        semantic_relative: finite(scores.semantic_relative), fused: finite(scores.fused), exact_identifier: chunk.scores.exact_identifier } };
  });
}
