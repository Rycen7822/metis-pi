import type { Component, Palette, Renderers, ShellFactories, ViewContext } from "../../presentation/contracts.ts";
import { highlightBashScript } from "../../presentation/bash-lexer.ts";
import type { ColorLevel } from "../../presentation/palette.ts";
import { asRecord, isExplorationTool, TOOL_NAMES, type ToolName } from "../../presentation/tool-names.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";
import { fusionRenderers } from "./fusion-view.ts";

export interface OwnedCommandStyle {
  /** Paint command text only; the registered tool retains grouping and execution state. */
  highlightOwnedCommand?: (lines: readonly string[]) => string[];
  renderOwnedCommand?: (command: string, state: "running" | "done", expanded: boolean, theme: Palette, context: ViewContext) => Component;
}

export function createOwnedCommandStyle(bindings: { makeShell?: ShellFactories; expandHint(): string }, colorLevel: ColorLevel) {
  const shell = bindings.makeShell?.makeShellCall;
  return {
    highlightOwnedCommand: (lines: readonly string[]) => highlightBashScript(lines, colorLevel),
    renderOwnedCommand: shell ? (command: string, state: "running" | "done", expanded: boolean, theme: Palette, context: ViewContext) =>
      shell({ name: "bash", args: { command }, options: { expanded }, theme, context,
        bullet: theme.fg("dim", "•"), title: state === "running" ? "Running" : "Ran", expandHint: bindings.expandHint(), colorLevel })
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
  if (kind === "execution" && options.highlightOwnedCommand && typeof call === "function" && typeof renderResult === "function") {
    return {
      renderCall: (args, theme, context) => call(args, {
        fg: (role: string, text: string) => theme.fg(role, text), bold: (text: string) => theme.bold(text),
        highlightCommandLines: options.highlightOwnedCommand,
        renderCommandCall: renderOwnedCommand ? (command: string, state: "running" | "done", expanded: boolean) =>
          renderOwnedCommand(command, state, expanded, theme, context) : undefined,
      }, context),
      renderResult: (value, opts, theme, context) => renderResult(value, opts, theme, context),
    };
  }
  if (name === "codemode" && kind === "builtin" && codemode) return {
    renderCall: codemode.renderCall,
    renderResult: (value, opts, theme, ctx) => codemode.renderResult(
      { ...asRecord(value), nestedCalls: asRecord(result()).nestedCalls }, opts, theme, ctx),
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
