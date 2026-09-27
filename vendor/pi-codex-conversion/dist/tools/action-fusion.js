import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Type } from "typebox";
export const THEN_RUN_SCHEMA = Type.Optional(Type.Object({
    command: Type.String({ description: "Already-chosen command to run after the entire mutation succeeds" }),
    timeout: Type.Optional(Type.Number({ description: "Execution timeout in seconds; no default timeout" })),
}, { additionalProperties: false, description: "Fuse a known follow-up command. Failure keeps the mutation. Omit when the next command requires inspecting the mutation result." }));
export function validateThenRun(input) {
    if (input === undefined)
        return undefined;
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("then_run must be an object");
    const value = input;
    if (Object.keys(value).some(key => key !== "command" && key !== "timeout") || typeof value["command"] !== "string" || !value["command"].trim())
        throw new Error("then_run requires a nonempty command and optional timeout");
    if (value["timeout"] !== undefined && (typeof value["timeout"] !== "number" || !Number.isFinite(value["timeout"]) || value["timeout"] <= 0 || value["timeout"] * 1000 > 2_147_483_647))
        throw new Error("then_run timeout must be a finite positive number of seconds within the timer limit");
    return { command: value["command"], ...(value["timeout"] === undefined ? {} : { timeout: value["timeout"] }) };
}
export function fusionReceipt(details) {
    if (!details || typeof details !== "object")
        return undefined;
    const receipt = details["metisActionFusion"];
    return receipt?.version === 1 && ["success", "failed", "partial_failure"].includes(receipt.mutationStatus)
        && receipt.command && typeof receipt.command.command === "string"
        && ["running", "succeeded", "failed", "timed_out", "cancelled", "skipped"].includes(receipt.command.status)
        && Number.isInteger(receipt.command.outputBlock) && receipt.command.outputBlock >= 0 ? receipt : undefined;
}
export function fusionFailed(details) {
    const receipt = fusionReceipt(details);
    return !!receipt && (receipt.mutationStatus !== "success" || !["succeeded", "running"].includes(receipt.command.status));
}
// Same physical package shares queues across Pi's independent entry loaders.
const queueKey = Symbol.for(`metis-pi.fusion-queues:${import.meta.url}`);
const shared = globalThis;
const queues = shared[queueKey] ??= new Map();
async function canonicalPath(path) {
    let current = resolve(path);
    const suffix = [];
    for (;;) {
        try {
            return resolve(await realpath(current), ...suffix);
        }
        catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes(error.code ?? ""))
                throw error;
            const parent = dirname(current);
            if (parent === current)
                return resolve(path);
            suffix.unshift(basename(current));
            current = parent;
        }
    }
}
function abortError() { return new Error("Action Fusion aborted"); }
async function waitForQueue(previous, signal) {
    if (!signal)
        return previous;
    if (signal.aborted)
        throw abortError();
    let abort;
    try {
        await Promise.race([previous, new Promise((_, reject) => {
                abort = () => reject(abortError());
                signal.addEventListener("abort", abort, { once: true });
            })]);
    }
    finally {
        signal.removeEventListener("abort", abort);
    }
}
/** Separate from Pi's mutation locks: no recursive acquisition of those locks. */
async function withFusionPaths(paths, signal, work) {
    const keys = [...new Set(await Promise.all(paths.map(canonicalPath)))].sort();
    const acquire = async (index) => {
        if (signal?.aborted)
            throw abortError();
        if (index === keys.length)
            return work();
        const key = keys[index];
        const previous = queues.get(key) ?? Promise.resolve();
        let release;
        const owned = new Promise(done => { release = done; });
        const tail = previous.then(() => owned);
        queues.set(key, tail);
        try {
            await waitForQueue(previous, signal);
            return await acquire(index + 1);
        }
        finally {
            release();
            void tail.then(() => { if (queues.get(key) === tail)
                queues.delete(key); });
        }
    };
    return acquire(0);
}
function combined(mutation, input, commandResult) {
    const details = mutation.details && typeof mutation.details === "object" ? mutation.details : {};
    const mutationStatus = details["status"] === "partial_failure" ? "partial_failure" : details["status"] === "failed" ? "failed" : "success";
    const { output, ...command } = commandResult;
    const status = [`[then_run:${command.status}] ${input.command}`, command.error,
        command.fullOutputPath ? `Full output: ${command.fullOutputPath}` : undefined, command.fullOutputError].filter(Boolean).join("\n");
    const content = [...mutation.content, { type: "text", text: status }, { type: "text", text: output }];
    return { content, details: { ...details, metisActionFusion: { version: 1, mutationStatus, command: { ...command, command: input.command, outputBlock: content.length - 1 } } } };
}
export async function executeFusion(options) {
    const input = validateThenRun(options.thenRun); // Validate before any side effect.
    return withFusionPaths(options.paths, options.signal, async () => {
        let mutation;
        try {
            mutation = await options.mutate();
        }
        catch (error) {
            if (!input)
                throw error;
            mutation = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { status: "failed" } };
        }
        if (!input)
            return mutation;
        const status = mutation.details?.status;
        if (status === "failed" || status === "partial_failure")
            return combined(mutation, input, { status: "skipped", output: "", error: "Mutation did not fully succeed; command not run." });
        if (options.signal?.aborted)
            return combined(mutation, input, { status: "cancelled", output: "", error: "Cancelled after mutation; command not run." });
        const update = (command) => {
            try {
                options.onUpdate?.(combined(mutation, input, command));
            }
            catch { /* Presentation failure must not erase completed mutation evidence. */ }
        };
        update({ status: "running", output: "" });
        let command;
        try {
            command = await options.run(input, options.signal, update);
        }
        catch (error) {
            command = { status: options.signal?.aborted ? "cancelled" : "failed", output: "", error: error instanceof Error ? error.message : String(error) };
        }
        if (command.status === "running" || (command.status === "succeeded" && command.exitCode !== 0))
            command = { ...command, status: "failed", error: "Command completion was not confirmed." };
        return combined(mutation, input, command);
    });
}
