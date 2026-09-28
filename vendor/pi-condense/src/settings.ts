import type { ContextPruneConfig } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import {
  SCALAR_ROWS, displayValue, fallbackValue, optionValues, parseScalar,
  rowDescription, type ScalarRow, writeScalar,
} from "./setting-fields.js";
import { persistConfig } from "./config.js";

/**
 * Wraps a SettingsList with a border + title, delegating all input handling
 * to the inner list. Container alone doesn't handle input, so we must
 * forward handleInput manually.
 */
class SettingsOverlay extends Container {
  constructor(
    title: string,
    private readonly settingsList: SettingsList,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(title, 0, 0));
    this.addChild(settingsList);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string) {
    this.settingsList.handleInput(data);
  }

  invalidate() {
    this.settingsList.invalidate();
  }
}

export function protectedToolsDisplay(list: string[]): string {
  return list.length === 0 ? "(none)" : list.join(", ");
}

function protectedToolsDescription(config: ContextPruneConfig): string {
  return `Tool names whose outputs are NEVER pruned (kept verbatim in context). Currently: ${protectedToolsDisplay(config.protectedTools)}. Edit via \`/pruner protected-tools\` for an interactive prompt, or \`/pruner protected-tools <comma-separated names>\` to set directly. Common candidates: todowrite, todoread.`;
}

function protectedPathsDescription(config: ContextPruneConfig): string {
  return `Glob patterns matched against a tool call's \`args.path\`; matching outputs are NEVER pruned. Currently: ${protectedToolsDisplay(config.protectedPaths)}. Edit via \`/pruner protected-paths\` (interactive) or \`/pruner protected-paths <comma-separated globs>\`. Set to 'none' to disable (kill switch). Default protects skill files and per-repo gauntlet overrides: **/skills/**/*.md, **/gauntlet-overrides.md`;
}

export async function openPrunerSettings(
  ctx: ExtensionCommandContext,
  currentConfig: { value: ContextPruneConfig },
  save: (config: ContextPruneConfig) => Promise<void>,
  refreshStatus: (config: ContextPruneConfig) => void,
): Promise<void> {
  const config = currentConfig.value;
  const availableModels = ctx.modelRegistry?.getAvailable() ?? [];

  /** One row from the shared scalar-field table (identity, options, text). */
  const itemOf = (row: ScalarRow): SettingItem => ({
    id: row.id,
    label: row.label,
    values: optionValues(row),
    currentValue: displayValue(row, config),
    description: rowDescription(row, config),
  });

  // The scalar table is in overlay order; only the model picker splits it.
  const modelAt = SCALAR_ROWS.findIndex((row) => row.id === "pruneOn") + 1;
  const items: SettingItem[] = [
    ...SCALAR_ROWS.slice(0, modelAt).map(itemOf),
    {
      id: "summarizerModel",
      label: "Summarizer model",
      values: [config.summarizerModel], // show current value as the cycling option
      currentValue: config.summarizerModel,
      description: "Model used for summarizing tool outputs — press Enter to browse models",
      submenu: (currentValue: string, done: (newValue?: string) => void) => {
        const modelItems: SettingItem[] = [
          {
            id: "default",
            label: "default (active model)",
            values: ["default"],
            currentValue: currentValue === "default" ? "default" : "",
            description: "Use the currently active model for summarization",
          },
          ...availableModels.map((m) => {
            const displayId = `${m.provider}/${m.id}`;
            return {
              id: displayId,
              label: displayId,
              values: [displayId],
              currentValue: currentValue === displayId ? displayId : "",
              description: m.name || displayId,
            };
          }),
        ];
        return new SettingsList(
          modelItems,
          15,
          getSettingsListTheme(),
          (_id: string, newValue: string) => done(newValue),
          () => done(undefined), // onCancel — ESC closes submenu, returns to parent
          { enableSearch: true },
        );
      },
    },
    ...SCALAR_ROWS.slice(modelAt).map(itemOf),
    {
      // Read-only display row. Editing goes through `/pruner protected-tools`
      // because SettingsList.submenu requires a synchronous Component,
      // while editing a free-form list needs `ctx.ui.input()` (async).
      id: "protectedTools",
      label: "Protected tools",
      values: [protectedToolsDisplay(config.protectedTools)],
      currentValue: protectedToolsDisplay(config.protectedTools),
      description: protectedToolsDescription(config),
    },
    {
      id: "protectedPaths",
      label: "Protected paths",
      values: [protectedToolsDisplay(config.protectedPaths)],
      currentValue: protectedToolsDisplay(config.protectedPaths),
      description: protectedPathsDescription(config),
    },
  ];

  let settingsList: SettingsList;
  let closeSettingsOverlay = () => {};

  const onChange = (id: string, newValue: string) => {
    // Read-only row — SettingsList still fires onChange when the user
    // presses Enter on a single-value item. Short-circuit so we don't
    // do a redundant saveConfig / status-widget refresh on no-op presses.
    if (id === "protectedTools" || id === "protectedPaths") return;
    let newConfig: ContextPruneConfig;
    const row = SCALAR_ROWS.find((entry) => entry.id === id);
    if (row) {
      const parsed = parseScalar(row, newValue);
      newConfig = writeScalar(currentConfig.value, row, parsed === undefined ? fallbackValue(row) : parsed);
      const item = items.find((entry) => entry.id === id);
      // Only top-level rows refresh their text; nested rows keep the text they
      // were opened with until the overlay is reopened.
      if (item && !row.path.includes(".")) item.description = rowDescription(row, newConfig);
    } else if (id === "summarizerModel") {
      newConfig = { ...currentConfig.value, summarizerModel: newValue };
    } else {
      newConfig = currentConfig.value;
    }
    currentConfig.value = newConfig;
    void persistConfig((m, t) => ctx.ui.notify(m, t), newConfig, save);
    refreshStatus(newConfig);
    settingsList?.invalidate();
  };

  settingsList = new SettingsList(
    items,
    10,
    getSettingsListTheme(),
    onChange,
    () => closeSettingsOverlay(), // onCancel — close the custom overlay
    { enableSearch: false },
  );

  // Use ctx.ui.custom() to show the settings list as an overlay.
  // The factory receives (tui, theme, keybindings, done) and returns a Component.
  // Wire Escape through the SettingsList constructor's onCancel callback instead
  // of mutating private SettingsList fields.
  await ctx.ui.custom(
    (_tui, _theme, _keybindings, done) => {
      closeSettingsOverlay = () => done(undefined);
      return new SettingsOverlay("pruner settings", settingsList);
    },
    {
      overlay: true,
      overlayOptions: { width: 60 },
    },
  );
}
