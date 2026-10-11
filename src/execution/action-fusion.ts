import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface ThenRunInput { command: string; timeout?: number }
export const THEN_RUN_SCHEMA = Type.Optional(
  Type.Object(
    {
      command: Type.String({ description: "Already-chosen command to run after the entire mutation succeeds" }),
      timeout: Type.Optional(Type.Number({ description: "Execution timeout in seconds; no default timeout" })),
    },
    {
      additionalProperties: false,
      description:
        "Fuse a known follow-up command. Failure keeps the mutation. Omit when the next command requires inspecting the mutation result.",
    },
  ),
);

export interface FusionCommandResult {
  status: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "skipped";
  output: string;
  exitCode?: number | undefined;
  error?: string | undefined;
  fullOutputPath?: string | undefined;
  fullOutputBytes?: number | undefined;
  fullOutputComplete?: boolean | undefined;
  fullOutputAppendOnly?: boolean | undefined;
  fullOutputError?: string | undefined;
}
export interface FusionReceipt {
  version: 1;
  mutationStatus: "success" | "failed" | "partial_failure";
  command: Omit<FusionCommandResult, "output"> & { command: string; outputBlock: number };
}
export type FusionResult = AgentToolResult<Record<string, unknown> & { metisActionFusion?: FusionReceipt }>;
export type FusionCommandRunner = (
  input: ThenRunInput,
  signal?: AbortSignal,
  update?: (result: FusionCommandResult) => void,
) => Promise<FusionCommandResult>;

export function validateThenRun(input: unknown): ThenRunInput | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("then_run must be an object");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== "command" && key !== "timeout") ||
    typeof value["command"] !== "string" ||
    !value["command"].trim()
  )
    throw new Error("then_run requires a nonempty command and optional timeout");
  if (
    value["timeout"] !== undefined &&
    (typeof value["timeout"] !== "number" ||
      !Number.isFinite(value["timeout"]) ||
      value["timeout"] <= 0 ||
      value["timeout"] * 1000 > 2_147_483_647)
  )
    throw new Error("then_run timeout must be a finite positive number of seconds within the timer limit");
  return {
    command: value["command"],
    ...(value["timeout"] === undefined ? {} : { timeout: value["timeout"] as number }),
  };
}

export function fusionReceipt(details: unknown): FusionReceipt | undefined {
  if (!details || typeof details !== "object") return undefined;
  const receipt = (details as Record<string, unknown>)["metisActionFusion"] as FusionReceipt | undefined;
  return receipt?.version === 1 &&
    ["success", "failed", "partial_failure"].includes(receipt.mutationStatus) &&
    receipt.command &&
    typeof receipt.command.command === "string" &&
    ["running", "succeeded", "failed", "timed_out", "cancelled", "skipped"].includes(receipt.command.status) &&
    Number.isInteger(receipt.command.outputBlock) &&
    receipt.command.outputBlock >= 0
    ? receipt
    : undefined;
}

export function fusionFailed(details: unknown): boolean {
  const receipt = fusionReceipt(details);
  return (
    !!receipt && (receipt.mutationStatus !== "success" || !["succeeded", "running"].includes(receipt.command.status))
  );
}

// Same physical package shares queues across Pi's independent entry loaders.
const queueKey = Symbol.for(`metis-pi.fusion-queues:${import.meta.url}`);
const shared = globalThis as typeof globalThis & { [queueKey]?: Map<string, Promise<void>> };
const queues = (shared[queueKey] ??= new Map<string, Promise<void>>());

async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...suffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function abortError(): Error {
  return new Error("Action Fusion aborted");
}
async function waitForQueue(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) throw abortError();
  let abort!: () => void;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        abort = () => reject(abortError());
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Separate from Pi's mutation locks: no recursive acquisition of those locks. */
async function withFusionPaths<T>(
  paths: string[],
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(await Promise.all(paths.map(canonicalPath)))].sort();
  const acquire = async (index: number): Promise<T> => {
    if (signal?.aborted) throw abortError();
    if (index === keys.length) return work();
    const key = keys[index]!;
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>((done) => {
      release = done;
    });
    const tail = previous.then(() => owned);
    queues.set(key, tail);
    try {
      await waitForQueue(previous, signal);
      return await acquire(index + 1);
    } finally {
      release();
      void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
      });
    }
  };
  return acquire(0);
}

function combined(
  mutation: AgentToolResult<unknown>,
  input: ThenRunInput,
  commandResult: FusionCommandResult,
): FusionResult {
  const details =
    mutation.details && typeof mutation.details === "object" ? (mutation.details as Record<string, unknown>) : {};
  const mutationStatus =
    details["status"] === "partial_failure" ? "partial_failure" : details["status"] === "failed" ? "failed" : "success";
  const { output, ...command } = commandResult;
  const status = [
    `[then_run:${command.status}] ${input.command}`,
    command.exitCode !== undefined && command.exitCode !== 0 ? `Exit code: ${command.exitCode}` : undefined,
    command.error,
    command.fullOutputPath ? `Full output: ${command.fullOutputPath}` : undefined,
    command.fullOutputError,
  ]
    .filter(Boolean)
    .join("\n");
  const content = [
    ...mutation.content,
    { type: "text" as const, text: status },
    { type: "text" as const, text: output },
  ];
  return {
    content,
    details: {
      ...details,
      metisActionFusion: {
        version: 1,
        mutationStatus,
        command: { ...command, command: input.command, outputBlock: content.length - 1 },
      },
    },
  };
}

export async function executeFusion(options: {
  paths: string[];
  thenRun?: unknown;
  signal?: AbortSignal | undefined;
  mutate(): Promise<AgentToolResult<unknown>>;
  run: FusionCommandRunner;
  onUpdate?: ((result: FusionResult) => void) | undefined;
}): Promise<AgentToolResult<unknown>> {
  const input = validateThenRun(options.thenRun); // Validate before any side effect.
  return withFusionPaths(options.paths, options.signal, async () => {
    let mutation: AgentToolResult<unknown>;
    try {
      mutation = await options.mutate();
    } catch (error) {
      if (!input) throw error;
      mutation = {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        details: { status: "failed" },
      };
    }
    if (!input) return mutation;
    const status = (mutation.details as { status?: string } | undefined)?.status;
    if (status === "failed" || status === "partial_failure")
      return combined(mutation, input, {
        status: "skipped",
        output: "",
        error: "Mutation did not fully succeed; command not run.",
      });
    if (options.signal?.aborted)
      return combined(mutation, input, {
        status: "cancelled",
        output: "",
        error: "Cancelled after mutation; command not run.",
      });
    const update = (command: FusionCommandResult) => {
      try {
        options.onUpdate?.(combined(mutation, input, command));
      } catch {
        /* Presentation failure must not erase completed mutation evidence. */
      }
    };
    update({ status: "running", output: "" });
    let command: FusionCommandResult;
    try {
      command = await options.run(input, options.signal, update);
    } catch (error) {
      command = {
        status: options.signal?.aborted ? "cancelled" : "failed",
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (command.status === "running" || (command.status === "succeeded" && command.exitCode !== 0))
      command = { ...command, status: "failed", error: "Command completion was not confirmed." };
    return combined(mutation, input, command);
  });
}
