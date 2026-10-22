import { readFileSync } from "node:fs";
import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "../src/appearance/runtime.ts";
import { createDiffComponent, createDiffPainter, createShellFactories } from "../src/presentation/components/tool-components.ts";
import { registerCompactionPresentation } from "../src/appearance/chrome/compaction-presentation.ts";
import { wrapPlainOutput, type LayoutOps } from "../src/presentation/shell.ts";
import type { Palette } from "../src/presentation/contracts.ts";
import { CODEX_CYAN_RGB, resolveColorContext } from "../src/presentation/palette.ts";
import { makeSurfaceOps } from "../src/appearance/chrome/surface.ts";
import { loadConfig } from "../src/appearance/config.ts";
import { readOptionalConfigFile } from "../src/configuration/store.ts";
import { thoughtSummaryText } from "../src/presentation/thinking-summary.ts";
import {
  CodexSeparatorComponent, CodexWriteCallComponent, ThinkingRailComponent,
  ThinkingPeekComponent, ThinkingClickableComponent,
} from "../src/presentation/components/transcript-components.ts";

function layoutOps(): LayoutOps {
  return {
    wrap: (text: string, columns: number) => wrapPlainOutput(text, columns, Tui.wrapTextWithAnsi),
    visibleWidth: Tui.visibleWidth,
  };
}

/**
 * The terminal's color capability cannot change mid-session, so resolve it once
 * per process: every render path (separator, thinking rail, thought summary
 * painter, composer surface) then shares one context instead of re-probing the
 * host on each frame.
 */
let cachedColorLevel: ReturnType<typeof resolveColorContext> | undefined;
function colorLevelOnce(): ReturnType<typeof resolveColorContext> {
  return (cachedColorLevel ??= resolveColorContext({ terminalTrueColor: Tui.getCapabilities().trueColor === true }));
}

function appearanceVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export default function codexAppearance(pi: AppearanceAPI): void {
  const prototype = Pi.ToolExecutionComponent.prototype;
  const colorLevel = colorLevelOnce();
  const highlight = (text: string, language: string): string => Pi.highlightCode(text, language).join("\n");
  const diffPainter = createDiffPainter(highlight);
  // Do not capture factory input/context: lastComponent would chain old bodies.
  const paintDiff = (theme: Palette) => (text: string, language: string) => diffPainter.paint(text, language, theme);
  pi.on("session_start", () => { diffPainter.clear(); });
  pi.on("session_shutdown", () => { diffPainter.clear(); });
  // Resolve host Tui capabilities here; the surface painters use one color context.
  const surface = makeSurfaceOps(
    colorLevel,
    (text) => `\x1b[38;2;${CODEX_CYAN_RGB}m${text}\x1b[39m`,
    (text) => `\x1b[2m${text}\x1b[22m`,
  );
  // Every module uses Pi's agent dir (PI_CODING_AGENT_DIR); no appearance-only override.
  const getAgentDir = Pi.getAgentDir;
  const readFile = readOptionalConfigFile;
  const bootConfig = loadConfig(getAgentDir(), readFile).config;
  const bootWritePreview = bootConfig.writePreview;
  registerCompactionPresentation(pi, {
    prototype: Pi.CompactionSummaryMessageComponent.prototype,
    enabled: bootConfig.enabled,
    host: { Text: Tui.Text, Markdown: Tui.Markdown, Spacer: Tui.Spacer,
      Container: Tui.Container, MouseRegion: Tui.MouseRegion,
      expandKey: () => Pi.keyText("app.tools.expand") },
  });

  activate(pi, {
    getAgentDir,
    readFile,
    prototype,
    makeText: (text) => new Tui.Text(text, 0, 0),
    makeDiff: (input) => createDiffComponent({
      rows: input.rows, filePath: input.filePath,
      paint: paintDiff(input.theme),
      colorLevel,
    }, layoutOps()),
    makeShell: createShellFactories(layoutOps()),
    expandHint: () => Pi.keyHint("app.tools.expand", "to expand"),
    highlight,
    colorLevel,
    layoutOps: layoutOps(),
    assistantPrototype: Pi.AssistantMessageComponent.prototype,
    interactivePrototype: Pi.InteractiveMode.prototype,
    makeSeparator: () => new CodexSeparatorComponent(colorLevel),
    makeSpacer: () => new Tui.Spacer(1),
    makeRail: (child) => new ThinkingRailComponent(child as Tui.Component, colorLevel),
    makePeek: (input) => new ThinkingPeekComponent(
      input.inner as Tui.Component,
      input.control,
      input.windowLines,
      (text) => surface.paintGlyph(text, "dim"),
      input.onScroll,
    ),
    makeClickable: (input) => {
      const child = new Tui.Container();
      if (input.before) child.addChild(input.before as Tui.Component);
      child.addChild(input.inner as Tui.Component);
      if (input.after) child.addChild(input.after as Tui.Component);
      return new ThinkingClickableComponent(child, input.control, input.fallback, input.apply);
    },
    // Collapsed thinking run: a real Tui.Text so selection-copy mirrors it
    // like any other host label (the hidden reasoning body is not rendered
    // anywhere and can never be copied). The host owns theme styling.
    makeThoughtSummary: (input) => {
      const text = thoughtSummaryText(input.durationMs);
      return new Tui.Text(colorLevel.kind === "none" ? text : input.paint?.(text) ?? text, input.paddingX, 0);
    },
    isCollapsedLabel: (node) => node instanceof Tui.Text,
    makeWriteCall: (input) => {
      // Read ONCE at boot from the same path activate() uses: a per-write-call
      // reload could disagree with the startup config.
      const maxRows = bootWritePreview.enabled ? bootWritePreview.rows : 0;
      return new CodexWriteCallComponent({ ...input, layout: layoutOps(), maxRows });
    },
    editorHost: { CustomEditor: Pi.CustomEditor },
    fullscreenHost: {
      HStack: Tui.HStack,
      VStack: Tui.VStack,
      UserMessageComponent: Pi.UserMessageComponent,
      SkillInvocationMessageComponent: Pi.SkillInvocationMessageComponent,
      promptRow: (summary, width) => {
        const row = Tui.truncateToWidth(`↑ ${summary}`, width);
        return row + " ".repeat(Math.max(0, width - Tui.visibleWidth(row)));
      },
      Spacer: Tui.Spacer,
      Container: Tui.Container, ScrollView: Tui.ScrollView, matchesKey: Tui.matchesKey,
    },
    selectionCopyHost: {
      prototypes: {
        Text: Tui.Text.prototype,
        Markdown: Tui.Markdown.prototype,
        Box: Tui.Box.prototype,
        Container: Tui.Container.prototype,
        MouseRegion: Tui.MouseRegion.prototype,
      },
      fns: {
        visibleWidth: Tui.visibleWidth,
        sliceByColumn: Tui.sliceByColumn,
        stripTerminalSequences: Tui.stripTerminalSequences,
        wrapTextWithAnsi: Tui.wrapTextWithAnsi,
        renderLatex: (text, options) => Tui.renderLatex(text, options) ?? null,
      },
    },
    surface,
    api: pi,
    appearanceVersion: appearanceVersion(),
    piVersion: Pi.VERSION,
  });
}
