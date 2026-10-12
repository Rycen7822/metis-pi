import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export type ActionTool = ToolDefinition<any, any>;

export function createDeferredActionTool(
  name: string,
  description: string,
  actions: ReadonlyMap<string, ActionTool>,
) {
  const names = [...actions.keys()];
  const parameters = Type.Object({
    action: Type.Unsafe<string>({ type: "string", enum: ["describe", ...names] }),
    target: Type.Optional(Type.Unsafe<string>({ type: "string", enum: names })),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  });
  const tool: ToolDefinition<typeof parameters, Record<string, unknown>> = {
    name,
    label: name,
    description: `${description} Actions: ${names.join(", ")}. ` +
      "Use action=describe with target set to an action to read its exact parameters, then supply params.",
    parameters,
    outputSchema: Type.Unknown(),
    exposure: "deferred",
    async execute(id, input, signal, onUpdate, ctx) {
      const action = input.action === "describe" ? input.target : input.action;
      const definition = action ? actions.get(action) : undefined;
      if (!definition) throw new Error(`Choose an available action: ${names.join(", ")}`);
      if (input.action === "describe") {
        const text = JSON.stringify({
          action, description: definition.description, parameters: definition.parameters,
          outputSchema: definition.outputSchema ?? Type.String(),
        });
        return {
          content: [{ type: "text", text }],
          structuredContent: JSON.parse(text),
          details: { metisAction: "describe", target: action },
        };
      }
      const params = input.params ?? {};
      const prepared = definition.prepareArguments ? definition.prepareArguments(params) : params;
      const args = validateToolArguments(definition, {
        type: "toolCall", id, name: definition.name, arguments: prepared as JsonObject,
      });
      const decorate = (result: Awaited<ReturnType<ToolDefinition["execute"]>>) => ({
        ...result,
        details: { ...(result.details && typeof result.details === "object" ? result.details : {}), metisAction: action },
      });
      const result = await definition.execute(id, args, signal, onUpdate && (update => onUpdate(decorate(update))), ctx);
      return {
        ...decorate(result),
        structuredContent: definition.outputSchema && result.structuredContent !== undefined
          ? result.structuredContent
          : result.content.filter(item => item.type === "text").map(item => item.text).join("\n"),
      };
    },
    renderCall(input, theme, ctx) {
      const definition = actions.get(input.action);
      if (definition?.renderCall) return definition.renderCall(input.params ?? {}, theme, ctx);
      return new Text(theme.fg("toolTitle", `${name} ${input.action}`), 0, 0);
    },
    renderResult(result, options, theme, ctx) {
      const action = result.details?.metisAction;
      const definition = typeof action === "string" ? actions.get(action) : undefined;
      if (definition?.renderResult) return definition.renderResult(result, options, theme, ctx);
      const target = result.details?.target ?? "";
      const text = action === "describe" && !options.expanded
        ? `${name}: ${target} parameters`
        : result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      return new Text(theme.fg(ctx?.isError ? "error" : "toolOutput", text), 0, 0);
    },
  };
  return tool;
}
