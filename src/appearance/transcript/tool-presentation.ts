import type { Component, Palette, Renderers, ShellFactories, ViewContext } from "../../presentation/contracts.ts";
import { highlightBashScript } from "../../presentation/bash-lexer.ts";
import type { CommandHeader } from "../../execution/ui/rendering.ts";
import type { ColorLevel } from "../../presentation/palette.ts";
import { asRecord, isExplorationTool, TOOL_NAMES, type ToolName } from "../../presentation/tool-names.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";
import { fusionRenderers } from "./fusion-view.ts";

export interface OwnedCommandStyle {
  /** Paint command text only; the registered tool retains grouping and execution state. */
  highlightOwnedCommand?: (lines: readonly string[]) => string[];
  renderOwnedCommand?: (command: string, header: CommandHeader, theme: Palette, context: ViewContext) => Component;
}

export function createOwnedCommandStyle(bindings: { makeShell?: ShellFactories; expandHint(): string }, colorLevel: ColorLevel) {
  const shell = bindings.makeShell?.makeShellCall;
  return {
    highlightOwnedCommand: (lines: readonly string[]) => highlightBashScript(lines, colorLevel),
    renderOwnedCommand: shell ? (command: string, { bullet, title, expanded }: CommandHeader, theme: Palette, context: ViewContext) =>
      shell({ name: "bash", args: { command }, options: { expanded, isPartial: context.isPartial === true }, theme, context,
        bullet, title, expandHint: bindings.expandHint(), colorLevel })
      : undefined,
  };
}

/** Ownership is established by the caller: live registration or readonly serialized source facts. */
export function selectToolPresentation(input: {
  name: string; kind: ToolPresentation | undefined; native?: { renderCall?: unknown; renderResult?: unknown }; result(): unknown;
}, options: OwnedCommandStyle & { renderers: Record<ToolName, Renderers>; codemode?: Renderers }): Renderers | undefined {
  const { name, kind, native, result } = input, { renderers, codemode, renderOwnedCommand } = options;
  if ((name === "edit" || name === "write") && kind === "fusion")
    return fusionRenderers(renderers[name], renderers.bash, result);
  const call = native?.renderCall, renderResult = native?.renderResult;
  if (kind === "execution" && name === "exec_command" && options.highlightOwnedCommand
    && typeof call === "function" && typeof renderResult === "function") {
    return {
      renderCall(args, theme, context) {
        const details = asRecord(asRecord(result()).details);
        return call(args, {
          fg: theme.fg.bind(theme), bold: theme.bold.bind(theme),
          highlightCommandLines: options.highlightOwnedCommand,
          renderCommandCall: renderOwnedCommand ? (command: string, header: CommandHeader) =>
            renderOwnedCommand(command, header, theme, context) : undefined,
        }, {
          ...context, posixShell: details.posixShell === true,
          isError: context.isError === true || (typeof details.exit_code === "number" && details.exit_code !== 0),
          isBackground: typeof details.session_id === "number",
        });
      },
      renderResult: (value, opts, theme, context) => renderResult(value, opts, theme, context),
    };
  }
  if (name === "codemode" && kind === "builtin" && codemode) return {
    renderCall(args, theme, ctx) {
      return codemode.renderCall(args, theme, { ...ctx, hasResult: result() !== undefined });
    },
    renderResult(value, opts, theme, ctx) {
      // Pi passes only content/details into renderResult, even for saved tool messages.
      const { nestedCalls, toolCallId } = asRecord(result());
      return codemode.renderResult({ ...asRecord(value), nestedCalls, toolCallId }, opts, theme, ctx);
    }
  };
  if (name === "neural_search") {
    if (kind !== "neural") return;
    const search = renderers.neural_search;
    if (typeof call !== "function" || typeof renderResult !== "function") return search;
    return {
      renderCall: (args, theme, ctx) => isExplorationTool(name, args) ? search.renderCall(args, theme, ctx) : call(args, theme, ctx),
      renderResult: (value, opts, theme, ctx) => isExplorationTool(name, ctx.args)
        ? search.renderResult(value, opts, theme, ctx) : renderResult(value, opts, theme, ctx),
    };
  }
  if (TOOL_NAMES.includes(name as ToolName) && (kind === "builtin" || kind === "fff")) return renderers[name as ToolName];
}
