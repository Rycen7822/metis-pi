// Read-only Codex quota via the locally logged-in Codex CLI's app-server:
//   spawn codex app-server --listen stdio://  (argv array — never a shell)
//   → request initialize → notify initialized → request account/rateLimits/read
//   → normalize → dispose child
// Safety contract: bounded stderr (Bearer/access_token redacted), startup +
// per-RPC timeouts, early-exit rejection, pending cleanup, always dispose.
// No credentials are read, no private HTTP endpoint is contacted, the Codex
// TUI is never scraped.

import { spawn } from "node:child_process";
import { normalizeAppServerRateLimits } from "./normalize-codex.ts";
import type { CodexQuotaSnapshot, QuotaErrorClass } from "./types.ts";

const MAX_ERROR_BODY_CHARS = 600;

export class QuotaError extends Error {
  readonly #errorClass: QuotaErrorClass;
  constructor(errorClass: QuotaErrorClass, message: string) {
    super(message);
    this.#errorClass = errorClass;
  }
  get errorClass(): QuotaErrorClass {
    return this.#errorClass;
  }
}

export function redactErrorBody(body: string): string {
  const trimmed = body
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
    .trim();
  return trimmed.length <= MAX_ERROR_BODY_CHARS ? trimmed : `${trimmed.slice(0, MAX_ERROR_BODY_CHARS - 1)}…`;
}

interface SpawnLike {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: { write: (chunk: string) => void; end: () => void; writable: boolean };
  once: (event: string, handler: (...args: never[]) => void) => unknown;
  kill: () => void;
  killed: boolean;
}

export interface CodexQuotaQueryOptions {
  timeoutMs: number;
  /** Injectable spawn for tests (default: real `codex app-server`). */
  spawnFn?: (command: string, args: string[]) => SpawnLike;
  clientVersion?: string;
}

/** One-shot query: start → initialize → initialized → read → dispose. */
export async function queryCodexQuota(options: CodexQuotaQueryOptions): Promise<CodexQuotaSnapshot> {
  const client = new CodexAppServerClient(options.timeoutMs, options.spawnFn, options.clientVersion);
  try {
    await client.start();
    await client.request("initialize", {
      clientInfo: { name: "pi_codex_appearance", title: "Pi Codex Appearance", version: options.clientVersion ?? "0.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] },
    });
    client.notify("initialized");
    const result = await client.request("account/rateLimits/read", undefined);
    const snapshot = normalizeAppServerRateLimits(result, Date.now());
    if (!snapshot) throw new QuotaError("no-data", "codex app-server returned no displayable rate-limit data");
    return snapshot;
  } finally {
    client.dispose();
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

class CodexAppServerClient {
  readonly #timeoutMs: number;
  readonly #spawnFn: (command: string, args: string[]) => SpawnLike;
  readonly #clientVersion: string | undefined;
  #child: SpawnLike | undefined;
  #nextId = 1;
  #stderr = "";
  readonly #pending = new Map<number, Pending>();
  #startPromise: Promise<void> | undefined;
  #exitError: Error | undefined;

  constructor(timeoutMs: number, spawnFn: CodexQuotaQueryOptions["spawnFn"], clientVersion: string | undefined) {
    this.#timeoutMs = timeoutMs;
    this.#spawnFn = spawnFn ?? ((command, args) =>
      spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as SpawnLike);
    this.#clientVersion = clientVersion;
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = new Promise<void>((resolve, reject) => {
      let child: SpawnLike;
      try {
        child = this.#spawnFn("codex", ["app-server", "--listen", "stdio://"]);
      } catch (error) {
        reject(new QuotaError("codex-missing", `codex CLI not available: ${(error as Error).message}`));
        return;
      }
      this.#child = child;
      const startupTimeout = setTimeout(() => {
        reject(new QuotaError("startup-timeout", `timed out starting codex app-server after ${this.#timeoutMs}ms`));
        this.#rejectAllPending();
        child.kill();
      }, this.#timeoutMs);

      child.once("spawn", () => {
        clearTimeout(startupTimeout);
        resolve();
      });
      child.once("error", (error: Error) => {
        clearTimeout(startupTimeout);
        reject(new QuotaError("codex-missing", `failed to start codex app-server: ${error.message}`));
        this.#rejectAllPending();
      });
      child.once("exit", ((code: number | null, signal: string | null) => {
        clearTimeout(startupTimeout);
        const suffix = this.#stderr ? ` stderr: ${redactErrorBody(this.#stderr)}` : "";
        this.#exitError = new QuotaError(
          "early-exit",
          `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"})${suffix}`,
        );
        this.#rejectAllPending();
        reject(this.#exitError);
      }) as never);

      child.stderr.on("data", (chunk: string | Buffer) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.#stderr = (this.#stderr + text).length > MAX_ERROR_BODY_CHARS
          ? (this.#stderr + text).slice(-MAX_ERROR_BODY_CHARS)
          : this.#stderr + text;
      });

      // Newline-delimited JSON-RPC over stdout (manual split — no stream
      // requirements on injectable test doubles).
      let buffer = "";
      child.stdout.on("data", (chunk: string | Buffer) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        buffer += text;
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl === -1) break;
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.#handleLine(line);
        }
      });
    });
    return this.#startPromise;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (!child?.stdin.writable) throw new QuotaError("early-exit", "codex app-server is not running");
    if (this.#exitError) throw this.#exitError;
    const id = this.#nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new QuotaError("rpc-timeout", `timed out after ${this.#timeoutMs}ms waiting for ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(new QuotaError("early-exit", `codex app-server stdin closed: ${(error as Error).message}`));
      }
    });
  }

  notify(method: string): void {
    const child = this.#child;
    if (!child?.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify({ method })}\n`);
    } catch { /* dispose path — pending requests are rejected on exit */ }
  }

  dispose(): void {
    this.#rejectAllPending(new QuotaError("early-exit", "codex app-server request cancelled"));
    const child = this.#child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch { /* already closed */ }
    if (!child.killed) child.kill();
    this.#child = undefined;
  }

  #handleLine(line: string): void {
    let parsed: { id?: unknown; error?: { message?: unknown }; result?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // app-server noise / keepalives — not RPC frames
    }
    if (typeof parsed.id !== "number") return;
    const pending = this.#pending.get(parsed.id);
    if (!pending) return;
    this.#pending.delete(parsed.id);
    if (parsed.error) {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
      pending.reject(new QuotaError("rpc-error", `codex app-server request failed: ${message}`));
      return;
    }
    pending.resolve(parsed.result);
  }

  #rejectAllPending(error: Error = this.#exitError ?? new QuotaError("early-exit", "codex app-server closed")): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
