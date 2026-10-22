import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { PublishedDiagnostics } from "./published-diagnostics.ts";
import { commandPathValue, mergeEnvironment, resolveCommandPath, resolveSpawnCommand } from "./command.ts";
import { directoryUri } from "./files.ts";
import { positionAt } from "./text-edits.ts";
import { isCodeAction, type CodeActionResult } from "./code-actions.ts";
import type { JsonRpcMessage, LspDiagnostic, LspServerAdapter, ServerCommand } from "./types.ts";

const PROCESS_EXIT_GRACE_MS = 500;
const FRAME_SEPARATOR = Buffer.from("\r\n\r\n", "latin1");

export class LspClient {
  #child?: ChildProcessWithoutNullStreams;
  #process?: ChildProcessWithoutNullStreams;
  #processExit?: Promise<void>;
  #frameChunks: Buffer[] = [];
  #headerMatch = 0;
  #bodyRemaining: number | undefined;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (message: JsonRpcMessage) => void;
      reject: (reason: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  #publications: PublishedDiagnostics;
  #stderr = "";
  #serverCapabilities: Record<string, unknown> = {};
  #adapter: LspServerAdapter;
  #command: ServerCommand;
  #cwd: string;
  #timeoutMs: number;

  constructor(adapter: LspServerAdapter, cwd: string, timeoutMs: number) {
    this.#adapter = adapter;
    this.#command = adapter.defaultCommand;
    this.#cwd = cwd;
    this.#timeoutMs = timeoutMs;
    this.#publications = new PublishedDiagnostics(adapter, timeoutMs);
  }

  async start() {
    const commandPath = resolveCommandPath(
      this.#command.command,
      this.#cwd,
      process.platform,
      commandPathValue(this.#adapter.env),
    );
    if (!commandPath) {
      throw new Error(
        `${this.#adapter.name} LSP command not found: ${this.#command.command}. ${this.#adapter.missingCommandHint}`,
      );
    }

    const spawnCommand = resolveSpawnCommand({ ...this.#command, command: commandPath });
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: this.#cwd,
      env: mergeEnvironment(this.#adapter.env),
      stdio: "pipe",
    });
    this.#child = child;
    this.#process = child;
    this.#processExit = new Promise((resolve) => {
      const finish = () => {
        child.off("exit", finish);
        child.off("close", finish);
        resolve();
      };
      child.once("exit", finish);
      child.once("close", finish);
    });
    child.stdout.on("data", (chunk) => {
      try {
        this.#onData(chunk);
      } catch (error) {
        this.#fail(
          `${this.#adapter.name} LSP server sent invalid JSON-RPC data: ${formatErrorMessage(error)}.${this.#formatStderr()}`,
        );
      }
    });
    child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString();
    });
    child.stdin.on("error", (error) => {
      this.#fail(`${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.${this.#formatStderr()}`);
    });
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      if (this.#process === child) this.#process = undefined;
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#rejectPending(
        (id) => `${this.#adapter.name} LSP server exited before response ${id} (${reason}).${this.#formatStderr()}`,
      );
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        const message = `${this.#adapter.name} LSP process failed to start: ${error.message}.${this.#formatStderr()}`;
        this.#rejectPending(message);
        if (this.#child === child) this.#child = undefined;
        if (this.#process === child) this.#process = undefined;
        reject(new Error(message));
      });
    });
  }

  async initialize() {
    const root = this.#cwd;
    const rootUri = directoryUri(root);
    const workspaceFolders = [{ uri: rootUri, name: path.basename(root) || "workspace" }];
    const response = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders,
      initializationOptions: this.#adapter.initialization ?? {},
      capabilities: {
        textDocument: {
          // This spawn-per-call client can't track dynamic registrations, so
          // capabilities must be advertised statically.
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline",
                  "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"],
              },
            },
            resolveSupport: { properties: ["edit"] },
          },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
          publishDiagnostics: {},
          synchronization: { didSave: true },
        },
        workspace: {
          configuration: true,
          workspaceEdit: { documentChanges: true },
          workspaceFolders: true,
        },
      },
    });
    this.#serverCapabilities =
      (response.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.#adapter.initialization) {
      this.notify("workspace/didChangeConfiguration", { settings: this.#adapter.initialization });
    }
  }

  didOpen(uri: string, text: string, languageId: string) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didClose(uri: string) {
    if (!this.#child) return false;
    this.notify("textDocument/didClose", {
      textDocument: { uri },
    });
    return true;
  }

  async diagnostics(uri: string) {
    // Only pull if the server advertised it; otherwise use push diagnostics.
    if (!this.#serverCapabilities.diagnosticProvider) {
      return this.#publications.wait(
        uri,
        this.#adapter.pushDiagnosticsGraceMs
          ? {
              afterVersion: 0,
              diagnostics: [],
              waitMs: this.#adapter.pushDiagnosticsGraceMs,
            }
          : undefined,
      );
    }
    const published = this.#publications.get(uri);
    // Ignore a provisional empty publish, but preserve diagnostics that arrived before the pull.
    const afterVersion = published?.diagnostics.length ? published.version - 1 : (published?.version ?? 0);
    const response = await this.request("textDocument/diagnostic", {
      textDocument: { uri },
    });
    const result = response.result as { items?: LspDiagnostic[] } | undefined;
    const diagnostics = result?.items ?? [];
    if (diagnostics.length > 0 || !this.#adapter.pullDiagnosticsGraceMs) return diagnostics;
    return this.#publications.wait(uri, {
      afterVersion,
      diagnostics,
      waitMs: this.#adapter.pullDiagnosticsGraceMs,
    });
  }

  async codeActions(uri: string, text: string, diagnostics: LspDiagnostic[], kind: string) {
    const response = await this.request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: positionAt(text, text.length) },
      context: { diagnostics, only: [kind] },
    });
    return (response.result as CodeActionResult[] | null | undefined) ?? [];
  }

  async resolveActions(actions: CodeActionResult[]) {
    // Only resolve when the server advertised resolveProvider; otherwise use the
    // action as-is. Any error from an advertised resolve is real and propagates.
    const codeActionProvider = this.#serverCapabilities.codeActionProvider;
    const canResolve =
      typeof codeActionProvider === "object" &&
      codeActionProvider !== null &&
      (codeActionProvider as { resolveProvider?: boolean }).resolveProvider === true;

    const resolvedActions: CodeActionResult[] = [];
    for (const action of actions) {
      if (!isCodeAction(action) || action.disabled || action.edit || !canResolve) {
        resolvedActions.push(action);
        continue;
      }

      const response = await this.request("codeAction/resolve", action);
      resolvedActions.push((response.result as CodeActionResult | undefined) ?? action);
    }

    return resolvedActions;
  }

  async shutdown() {
    const child = this.#process;
    const processExit = this.#processExit;
    if (!child || !processExit) return;

    if (this.#child === child) {
      try {
        await this.request("shutdown", null);
        this.notify("exit", undefined);
        if (await settlesWithin(processExit, PROCESS_EXIT_GRACE_MS)) return;
      } catch {
        // The process may already be gone; terminate it below if needed.
      }
    }

    this.close();
    if (await settlesWithin(processExit, PROCESS_EXIT_GRACE_MS)) return;
    child.kill("SIGKILL");
    await processExit;
  }

  close() {
    this.#fail(`${this.#adapter.name} LSP request cancelled.`);
  }

  #rejectPending(message: string | ((id: number | "diagnostics") => string)) {
    for (const [id, pending] of this.#pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(typeof message === "string" ? message : message(id)));
    }
    this.#pending.clear();
    this.#publications.rejectAll(typeof message === "string" ? message : message("diagnostics"));
  }

  #fail(message: string) {
    // A failed server never delivers the rest of a frame; drop its partial bytes.
    this.#frameChunks = [];
    this.#headerMatch = 0;
    this.#bodyRemaining = undefined;
    this.#rejectPending(message);
    if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
    this.#child = undefined;
  }

  private request(method: string, params: unknown) {
    const id = this.#nextId++;

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.#adapter.name} LSP request timed out: ${method}.${this.#formatStderr()}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });

      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown) {
    this.#send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  #send(message: JsonRpcMessage) {
    if (!this.#child) throw new Error(`${this.#adapter.name} LSP server is not running.`);

    const body = JSON.stringify(message);
    try {
      this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch (error) {
      const errorMessage =
        `${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.` + this.#formatStderr();
      this.#fail(errorMessage);
      throw new Error(errorMessage);
    }
  }

  // Frames arrive as arbitrarily split byte chunks. One accumulator holds the current
  // header or body as views, joining each only once; Content-Length is parsed once per frame.
  #onData(chunk: Buffer) {
    let offset = 0;

    // A zero-length body must complete even when its header ends at the chunk boundary.
    while (offset < chunk.length || this.#bodyRemaining === 0) {
      if (this.#bodyRemaining === undefined) {
        const start = offset;
        while (offset < chunk.length && this.#headerMatch < FRAME_SEPARATOR.length) {
          const byte = chunk[offset++]!;
          // On mismatch, a CR can still begin the next delimiter candidate.
          if (byte === FRAME_SEPARATOR[this.#headerMatch]) this.#headerMatch++;
          else this.#headerMatch = byte === FRAME_SEPARATOR[0] ? 1 : 0;
        }
        this.#frameChunks.push(chunk.subarray(start, offset));
        if (this.#headerMatch < FRAME_SEPARATOR.length) return;

        const header = this.#takeFrameBytes().subarray(0, -FRAME_SEPARATOR.length).toString("utf8");
        this.#headerMatch = 0;
        const contentLength = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
        if (!contentLength) throw new Error(`Invalid LSP response header: ${header}`);
        this.#bodyRemaining = Number(contentLength);
      } else {
        const take = Math.min(this.#bodyRemaining, chunk.length - offset);
        if (take > 0) this.#frameChunks.push(chunk.subarray(offset, offset + take));
        offset += take;
        this.#bodyRemaining -= take;
        if (this.#bodyRemaining !== 0) return;

        const body = this.#takeFrameBytes();
        this.#bodyRemaining = undefined;
        this.#handleMessage(JSON.parse(body.toString("utf8")) as JsonRpcMessage);
      }
    }
  }

  #takeFrameBytes() {
    const bytes = this.#frameChunks.length === 1 ? this.#frameChunks[0]! : Buffer.concat(this.#frameChunks);
    this.#frameChunks = [];
    return bytes;
  }

  #handleMessage(message: JsonRpcMessage) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.#pending.delete(message.id as number);
      if (message.error) {
        pending.reject(new Error(`${this.#adapter.name} LSP error: ${message.error.message}`));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) this.#publications.publish(params.uri, params.diagnostics ?? []);
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.#respondToServerRequest(message);
    }
  }

  #respondToServerRequest(message: JsonRpcMessage) {
    if (message.method === "workspace/configuration") {
      const params = message.params as { items?: Array<{ section?: string }> } | undefined;
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: (params?.items ?? []).map((item) => this.#configurationValue(item.section)),
      });
      return;
    }

    if (message.method === "workspace/workspaceFolders") {
      const rootUri = directoryUri(this.#cwd);
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{ uri: rootUri, name: path.basename(this.#cwd) || "workspace" }],
      });
      return;
    }

    if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
      this.#send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }

    this.#send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method ?? "unknown"}` },
    });
  }

  #configurationValue(section: string | undefined) {
    if (!section) return this.#adapter.initialization ?? {};
    return this.#adapter.initialization?.[section] ?? {};
  }

  #formatStderr() {
    const stderr = this.#stderr.trim();
    return stderr ? `\nServer stderr:\n${stderr}` : "";
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function settlesWithin(promise: Promise<void>, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}
