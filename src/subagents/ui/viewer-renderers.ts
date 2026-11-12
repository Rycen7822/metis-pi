import { createNativeToolBindings } from "../../appearance/transcript/native-bindings.ts";
import { createOwnedCommandStyle, selectToolPresentation } from "../../appearance/transcript/tool-presentation.ts";
import type { AppearanceConfig } from "../../appearance/config.ts";
import { CodemodeViewStore, makeCodemodeRenderers } from "../../appearance/transcript/codemode-view.ts";
import type { TranscriptState } from "../../appearance/transcript/state.ts";
import { renderExecCall, renderExecResult } from "../../execution/exec/command-tool.ts";
import type { Renderers } from "../../presentation/contracts.ts";
import type { ColorLevel } from "../../presentation/palette.ts";
import { makeRenderers } from "../../presentation/renderers.ts";
import { asRecord } from "../../presentation/tool-names.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";
import { isSubagentTool, subagentToolRenderers } from "./rendering.ts";

/** Readonly registration adapter; factories and source-based presentation policy belong to the shared core. */
export function makeViewerRenderers(config: AppearanceConfig, transcript: TranscriptState, colorLevel: ColorLevel,
  sources: () => Readonly<Record<string, ToolPresentation>>) {
  const bindings = createNativeToolBindings(config, colorLevel);
  const { makeText, expandHint, highlight, makeShell, layoutOps } = bindings;
  const renderers = makeRenderers(makeText, expandHint, highlight, bindings.makeDiff, makeShell, bindings.makeWriteCall,
    { colorLevel, writeChanges: new Map(), transcript }, layoutOps);
  const codemode = makeCodemodeRenderers({ makeText, expandHint, highlight, colorLevel,
    store: new CodemodeViewStore(), shell: renderers.bash, resolve: (name, result) => resolve(name, () => result) });
  const options = { renderers, codemode, ...createOwnedCommandStyle(bindings, colorLevel) };
  const execution: Renderers = {
    renderCall: (args, theme, ctx) => renderExecCall(asRecord(args), theme, ctx) as ReturnType<Renderers["renderCall"]>,
    renderResult: (result, opts, theme) => renderExecResult(result as Parameters<typeof renderExecResult>[0],
      { expanded: opts.expanded === true, isPartial: opts.isPartial === true }, theme),
  };
  function resolve(name: string, result: () => unknown): Renderers | undefined {
    const kind = sources()[name];
    if (kind === "subagents" || isSubagentTool(name)) return subagentToolRenderers(name);
    const native = kind === "execution" && name === "exec_command" ? execution : undefined;
    return config.enabled ? selectToolPresentation({ name, kind, native, result }, options) : native;
  }
  return { resolve, clear: bindings.clear };
}
