import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AppearanceConfig } from "../../appearance/config.ts";
import { CodemodeViewStore, makeCodemodeRenderers } from "../../appearance/transcript/codemode-view.ts";
import { fusionRenderers } from "../../appearance/transcript/fusion-view.ts";
import type { TranscriptState } from "../../appearance/transcript/state.ts";
import { renderExecCall, renderExecResult } from "../../execution/exec/command-tool.ts";
import { createDiffComponent, createDiffPainter, createShellFactories } from "../../presentation/components/tool-components.ts";
import { CodexWriteCallComponent } from "../../presentation/components/transcript-components.ts";
import type { Renderers } from "../../presentation/contracts.ts";
import type { ColorLevel } from "../../presentation/palette.ts";
import { makeRenderers } from "../../presentation/renderers.ts";
import { highlightBashScript } from "../../presentation/bash-lexer.ts";
import { asRecord, type ToolName } from "../../presentation/tool-names.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";
import { isSubagentTool, subagentToolRenderers } from "./rendering.ts";

/** Per-view callbacks: share formatting, never the parent's registered callback identities or state. */
export function makeViewerRenderers(config: AppearanceConfig, transcript: TranscriptState, colorLevel: ColorLevel,
  sources: () => Readonly<Record<string, ToolPresentation>>) {
  const layout = { wrap: wrapTextWithAnsi, visibleWidth };
  const makeText = (text: string) => new Text(text, 0, 0);
  const expandHint = () => keyHint("app.tools.expand", "to expand");
  const paint = (text: string, language: string) => highlightCode(text, language).join("\n");
  const diffPainter = createDiffPainter(paint), shell = createShellFactories(layout);
  const base = makeRenderers(makeText, expandHint, paint,
    input => createDiffComponent({ rows: input.rows, filePath: input.filePath, expanded: input.options.expanded === true,
      paint: (text, language) => diffPainter.paint(text, language, input.theme), colorLevel }, layout),
    shell,
    input => new CodexWriteCallComponent({ ...input, layout, maxRows: config.writePreview.enabled ? config.writePreview.rows : 0 }),
    { colorLevel, writeChanges: new Map(), transcript }, layout);
  // Historical nested outputs were never retained by the main renderer either.
  // Preserve its explicit missing-output notices rather than inventing a cache.
  const codemode = makeCodemodeRenderers({ makeText, expandHint, highlight: paint, colorLevel,
    store: new CodemodeViewStore(), shell: base.bash, resolve: (name, result) => resolve(name, () => result) });
  const execution: Renderers = {
    renderCall: (args, theme, ctx) => {
      if (!config.enabled) return renderExecCall(asRecord(args), theme, ctx) as ReturnType<Renderers["renderCall"]>;
      const commandTheme = {
        fg: (role: string, text: string) => theme.fg(role, text), bold: (text: string) => theme.bold(text),
        highlightCommandLines: (lines: readonly string[]) => highlightBashScript(lines, colorLevel),
        renderCommandCall: (command: string, state: "running" | "done", expanded: boolean) => shell.makeShellCall!({
          name: "bash", args: { command }, options: { expanded }, theme, context: ctx,
          bullet: theme.fg("dim", "•"), title: state === "running" ? "Running" : "Ran", expandHint: expandHint(), colorLevel,
        }),
      };
      return renderExecCall(asRecord(args), commandTheme, ctx) as ReturnType<Renderers["renderCall"]>;
    },
    renderResult: (result, options, theme) => renderExecResult(result as Parameters<typeof renderExecResult>[0],
      { expanded: options.expanded === true, isPartial: options.isPartial === true }, theme),
  };
  function resolve(name: string, result: () => unknown): Renderers | undefined {
    const kind = sources()[name];
    if (kind === "execution" && name === "exec_command") return execution;
    // These renderers belong to subagents, independently of appearance. Keep known pre-rename summaries.
    if (kind === "subagents" || isSubagentTool(name)) return subagentToolRenderers(name);
    if (!config.enabled) return;
    if (name === "codemode" && kind === "builtin") return {
      renderCall: codemode.renderCall,
      renderResult: (value, options, theme, ctx) => codemode.renderResult(
        { ...asRecord(value), nestedCalls: asRecord(result()).nestedCalls }, options, theme, ctx),
    };
    if (kind === "fusion" && (name === "edit" || name === "write")) return fusionRenderers(base[name], base.bash, result);
    if (kind === "neural" && name === "neural_search") return base.neural_search;
    if (kind === "builtin" || kind === "fff") return base[name as ToolName];
  }
  return { resolve, clear: () => diffPainter.clear() };
}
