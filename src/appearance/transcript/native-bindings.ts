import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AppearanceConfig } from "../config.ts";
import { createDiffComponent, createDiffPainter, createShellFactories } from "../../presentation/components/tool-components.ts";
import { CodexWriteCallComponent } from "../../presentation/components/transcript-components.ts";
import type { DiffComponentInput, WritePreviewInput } from "../../presentation/contracts.ts";
import type { ColorLevel } from "../../presentation/palette.ts";
import { wrapPlainOutput } from "../../presentation/shell.ts";

/** Same native drawing factories in every view; each owner retains its own diff cache. */
export function createNativeToolBindings(config: Pick<AppearanceConfig, "writePreview">, colorLevel: ColorLevel) {
  const layoutOps = {
    wrap: (text: string, columns: number) => wrapPlainOutput(text, columns, wrapTextWithAnsi), visibleWidth,
  };
  const highlight = (text: string, language: string) => highlightCode(text, language).join("\n");
  const painter = createDiffPainter(highlight);
  const maxRows = config.writePreview.enabled ? config.writePreview.rows : 0;
  return {
    makeText: (text: string) => new Text(text, 0, 0),
    expandHint: () => keyHint("app.tools.expand", "to expand"),
    highlight, colorLevel, layoutOps,
    // Destructure display fields so the paint closure cannot retain input.context/lastComponent and chain old bodies.
    makeDiff: ({ rows, filePath, options, theme }: DiffComponentInput) => createDiffComponent({
      rows, filePath, expanded: options.expanded === true, colorLevel,
      paint: (text, language) => painter.paint(text, language, theme),
    }, layoutOps),
    makeShell: createShellFactories(layoutOps),
    makeWriteCall: (input: WritePreviewInput & { headerText: string }) =>
      new CodexWriteCallComponent({ ...input, layout: layoutOps, maxRows }),
    clear: () => painter.clear(),
  };
}
