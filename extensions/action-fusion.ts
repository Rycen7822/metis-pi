import { Text } from "@earendil-works/pi-tui";
import { Type, type TProperties, type TObject, type Static } from "typebox";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { executeFusion, fusionFailed, THEN_RUN_SCHEMA } from "../src/execution/action-fusion.ts";
import { runNativeFusionCommand } from "../src/execution/action-fusion-command.ts";
import { ACTION_FUSION_AVAILABILITY } from "../src/execution/action-fusion-availability.ts";
import { snapshotFile, computeWriteDiff } from "../src/write-tracker.ts";
import { resolveNativeMutationPath } from "../src/native-tool-path.ts";
export { resolveNativeMutationPath } from "../src/native-tool-path.ts";

function wrapNative<P extends TProperties, D, S>(base: ToolDefinition<TObject<P>, D, S>) {
  const parameters = Type.Object({ ...base.parameters.properties, then_run: THEN_RUN_SCHEMA });
  return defineTool({
    ...base,
    parameters,
    prepareArguments(args) {
      const prepared = base.prepareArguments?.(args) ?? args;
      const raw = args && typeof args === "object" ? args as Record<string, unknown> : {};
      return { ...(prepared as object), ...(Object.hasOwn(raw, "then_run") ? { then_run: raw.then_run } : {}) } as Static<typeof parameters>;
    },
    async execute(id, params, signal, onUpdate, ctx) {
      const raw = params as Record<string, unknown>;
      if (typeof raw.path !== "string") throw new Error("Mutation requires a path");
      const path = resolveNativeMutationPath(ctx.cwd, raw.path);
      return executeFusion({
        paths: [path],
        thenRun: raw.then_run,
        signal,
        async mutate() {
          const before = base.name === "write" ? snapshotFile(path) : undefined;
          const result = await base.execute(
            id,
            params as Static<TObject<P>>,
            signal,
            raw.then_run === undefined ? onUpdate : undefined,
            ctx,
          );
          if (!before || typeof raw.content !== "string") return result;
          return {
            ...result,
            details: {
              ...(result.details && typeof result.details === "object" ? result.details : {}),
              metisWriteDiff: computeWriteDiff(before, snapshotFile(path), raw.content),
            },
          };
        },
        run: (input, abort, update) => runNativeFusionCommand(input, ctx, abort, update),
        onUpdate,
      });
    },
    renderCall: (args, theme, context) => base.renderCall!(args as Static<TObject<P>>, theme, context as never),
    renderResult: (result, options, theme, context) => {
      if (result.details && typeof result.details === "object" && "metisActionFusion" in result.details) {
        return new Text(result.content.filter(b => b.type === "text").map(b => b.text).join("\n"), 0, 0);
      }
      return base.renderResult!(result as never, options, theme, context as never);
    },
  } satisfies ToolDefinition<typeof parameters, unknown, S>);
}

export function createNativeFusionTool(name: "edit" | "write", cwd: string) {
  return name === "write" ? wrapNative(createWriteToolDefinition(cwd)) : wrapNative(createEditToolDefinition(cwd));
}


export default function actionFusion(pi: ExtensionAPI): void {
  const unsubscribe = pi.events.on(ACTION_FUSION_AVAILABILITY, (request) => {
    if (request && typeof request === "object" && "enabled" in request) request.enabled = true;
  });
  const owned = new Set<string>();
  const active = new Set<AbortController>();
  pi.on("session_start", (_event, ctx) => {
    for (const name of ["edit", "write"] as const) {
      if (owned.has(name)) continue;
      const tool = pi.getAllTools().find(tool => tool.name === name);
      if (tool?.sourceInfo?.source !== "builtin" || tool.sourceInfo.path !== `builtin:${name}`) continue;
      const definition = createNativeFusionTool(name, ctx.cwd);
      pi.registerTool({ ...definition, async execute(id, input, signal, update, context) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort, { once: true });
        active.add(controller);
        try { return await definition.execute(id, input, controller.signal, update, context); }
        finally { active.delete(controller); signal?.removeEventListener("abort", abort); }
      } });
      owned.add(name);
    }
  });
  pi.on("tool_result", event => {
    if (owned.has(event.toolName) && fusionFailed(event.details)) return { isError: true };
    return undefined;
  });
  pi.on("session_shutdown", () => { unsubscribe(); for (const controller of active) controller.abort(); });
}
