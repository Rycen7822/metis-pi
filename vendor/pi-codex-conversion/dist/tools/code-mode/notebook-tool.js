import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getExperimentalToolSampling } from "../tool-sampling.js";
import { canExecuteNotebookControlInsideExec } from "../notebook-mode/control-contract.js";
import { notebookRenderers } from "./notebook-rendering.js";
// Local patch (see ../../PATCHES.md): strict providers (DeepSeek and friends) reject a
// function whose parameters schema has no top-level `type: "object"`, and a top-level
// Type.Union serializes without one — the whole request then fails with
// `400 Invalid schema for function 'notebook': schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
// One object schema carrying every variant's fields keeps each previously valid input valid
// (execution normalizes parameters and never validates against this schema).
export const NOTEBOOK_PARAMETERS = Type.Object({
    action: StringEnum(["status", "list", "checkpoint", "restart", "diagnostics", "reset", "save", "load", "pin", "unpin", "release", "prune"]),
    query: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    names: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
}, { additionalProperties: false });
const NOTEBOOK_DESCRIPTION = "Control persistent notebook state: status inspects memory/bindings by query glob; checkpoint; pin/unpin/release names; prune unpinned matches; list/save/load profiles; restart; diagnostics; reset";
export function registerNotebookTool(pi, runtime) {
    const constrainedSampling = getExperimentalToolSampling("notebook");
    pi.registerTool({
        name: "notebook",
        label: "Notebook",
        description: NOTEBOOK_DESCRIPTION,
        promptSnippet: "Inspect, recover, or control notebook state",
        parameters: NOTEBOOK_PARAMETERS,
        ...notebookRenderers,
        ...(constrainedSampling ? { constrainedSampling } : {}),
        async execute(_id, params, signal, _onUpdate, ctx) {
            const result = await executeNotebookControl(runtime, params, {
                cwd: ctx.cwd,
                extensionContext: ctx,
            }, signal);
            return {
                content: [{ type: "text", text: result.message }],
                details: result.details,
            };
        },
    });
}
export function createNotebookControlProxy(runtime) {
    return {
        name: "notebook",
        usage: "await tools.notebook({ action, query?, name?, names? })",
        description: NOTEBOOK_DESCRIPTION,
        deferLoading: true,
        kind: "function",
        inputSchema: NOTEBOOK_PARAMETERS,
        invoke: (input, context, signal) => executeNotebookExecControl(runtime, input, context, signal),
    };
}
export async function executeNotebookControl(runtime, params, context, signal) {
    return executeNormalizedNotebookControl(runtime, normalizeNotebookRequest(params), context, signal);
}
export async function executeNotebookExecControl(runtime, params, context, signal) {
    const request = normalizeNotebookRequest(params);
    if (!canExecuteNotebookControlInsideExec(request))
        return {
            message: `Notebook ${request.action} was not run because it needs the active exec cell to finish. After exec returns, call notebook with ${JSON.stringify(request)}.`,
            details: { notRun: true, action: request.action, retry: request },
        };
    return executeNormalizedNotebookControl(runtime, request, context, signal);
}
function executeNormalizedNotebookControl(runtime, request, context, signal) {
    return runtime.controlNotebook(request, context, signal);
}
export function normalizeNotebookRequest(params) {
    params = {
        action: params.action,
        ...(params.query == null ? {} : { query: params.query }),
        ...(params.name == null ? {} : { name: params.name }),
        ...(params.names == null ? {} : { names: params.names }),
    };
    if (params.action === "status" || params.action === "list") {
        if (params.name !== undefined || params.names !== undefined)
            throw new Error(`notebook ${params.action} accepts query only`);
        return { action: params.action, ...(params.query === undefined ? {} : { query: params.query }) };
    }
    if (params.action === "save" || params.action === "load") {
        if (params.query !== undefined || params.names !== undefined)
            throw new Error(`notebook ${params.action} accepts name only`);
        if (!params.name)
            throw new Error(`notebook ${params.action} requires name`);
        return { action: params.action, name: params.name };
    }
    if (params.action === "release" || params.action === "pin" || params.action === "unpin") {
        if (params.query !== undefined || params.name !== undefined)
            throw new Error(`notebook ${params.action} accepts names only`);
        if (!params.names?.length)
            throw new Error(`notebook ${params.action} requires at least one name`);
        return { action: params.action, names: [...new Set(params.names)] };
    }
    if (params.action === "prune") {
        if (params.name !== undefined || params.names !== undefined)
            throw new Error("notebook prune accepts query only");
        if (!params.query)
            throw new Error("notebook prune requires query");
        return { action: "prune", query: params.query };
    }
    if (params.action !== "checkpoint" && params.action !== "restart" && params.action !== "diagnostics" && params.action !== "reset") {
        throw new Error(`Unsupported notebook action: ${params.action}`);
    }
    if (params.query !== undefined || params.name !== undefined || params.names !== undefined) {
        throw new Error(`notebook ${params.action} accepts only action`);
    }
    return { action: params.action };
}
