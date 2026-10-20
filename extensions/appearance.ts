import { readFileSync } from "node:fs";
import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "../src/extension.ts";
import { createDiffComponent, createDiffPainter, createShellFactories } from "../src/chrome/tool-components.ts";
import { registerCompactionPresentation } from "../src/chrome/compaction-presentation.ts";
import type { LayoutOps } from "../src/shell.ts";
import type { Palette } from "../src/tool-names.ts";
import { CODEX_CYAN_RGB, resolveColorContext } from "../src/palette.ts";
import { makeSurfaceOps } from "../src/surface.ts";
import { loadConfig } from "../src/config.ts";
import { thoughtSummaryText } from "../src/thinking-summary.ts";
import {
  CodexSeparatorComponent, CodexWriteCallComponent, ThinkingRailComponent,
  ThinkingPeekComponent, ThinkingClickableComponent,
} from "../src/chrome/transcript-components.ts";

function layoutOps(): LayoutOps {
  return {
    wrap: (text: string, columns: number) => Tui.wrapTextWithAnsi(text, columns),
    visibleWidth: (text: string) => Tui.visibleWidth(text),
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
  return (cachedColorLevel ??= resolveColorContext({ terminalTrueColor: Tui.getCapabilities?.()?.trueColor === true }));
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
  const prototype = Pi.ToolExecutionComponent?.prototype;
  const assistantComponent = Pi.AssistantMessageComponent as unknown as { prototype: object } | undefined;
  if (!prototype || typeof Tui.Text !== "function" || typeof Pi.keyHint !== "function"
      || typeof Tui.wrapTextWithAnsi !== "function" || typeof Tui.visibleWidth !== "function") {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("metis-pi: unsupported Pi UI exports; compact transcript was not installed.", "warning");
    });
    return;
  }
  const colorLevel = colorLevelOnce();
  const highlight = (text: string, language: string): string => {
    const lines = Pi.highlightCode(text, language);
    return Array.isArray(lines) ? lines.join("\n") : String(lines);
  };
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
  const getAgentDir = (): string => Pi.getAgentDir();
  const readFile = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const bootConfig = loadConfig(getAgentDir(), readFile).config;
  const bootWritePreview = bootConfig.writePreview;
  registerCompactionPresentation(pi, {
    prototype: Pi.CompactionSummaryMessageComponent?.prototype,
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
    assistantPrototype: assistantComponent?.prototype,
    interactivePrototype: Pi.InteractiveMode?.prototype,
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
    makeClickable: (input) => new ThinkingClickableComponent(
      input.inner as Tui.Component,
      input.control,
      input.fallback,
      input.apply,
    ),
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
    editorHost: { CustomEditor: Pi.CustomEditor as unknown },
    fullscreenHost: {
      HStack: typeof Tui.HStack === "function" ? Tui.HStack : undefined,
      VStack: typeof Tui.VStack === "function" ? Tui.VStack : undefined,
      UserMessageComponent: Pi.UserMessageComponent,
      SkillInvocationMessageComponent: Pi.SkillInvocationMessageComponent,
      promptRow: (summary, width) => {
        const row = Tui.truncateToWidth(`↑ ${summary}`, width);
        return row + " ".repeat(Math.max(0, width - Tui.visibleWidth(row)));
      },
      Spacer: typeof Tui.Spacer === "function" ? Tui.Spacer : undefined,
      Container: Tui.Container, ScrollView: Tui.ScrollView, matchesKey: Tui.matchesKey,
    },
    selectionCopyHost: {
      prototypes: {
        Text: Tui.Text.prototype,
        Markdown: Tui.Markdown.prototype,
        Box: Tui.Box.prototype,
        Container: Tui.Container.prototype,
        MouseRegion: Tui.MouseRegion?.prototype,
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
    piVersion: typeof (Pi as unknown as { VERSION?: unknown }).VERSION === "string"
      ? (Pi as unknown as { VERSION: string }).VERSION
      : "unknown",
  });
}
