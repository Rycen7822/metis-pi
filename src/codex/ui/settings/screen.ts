import {
	type ExtensionContext,
	getSettingsListTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	SettingsList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { CodexConversionConfig, LunaCacheKeepaliveMinutes } from "../../config/config.ts";
import type { CodexConversionConfigScope } from "../../config/config-store.ts";
import type { ExecutionMode } from "../../config/execution-mode.ts";
import { handleAboutTabInput, renderAboutTab } from "./about-tab.ts";
import { openCodexConfigInExternalEditor } from "./config-editor.ts";
import { buildConfigSettings, type ConfigSetting } from "./config-items.ts";
import { SETTINGS_TABS, type SettingsTab } from "./tabs.ts";
import { createUsageTab, type UsageTabOptions } from "./usage-tab.ts";

export interface CodexSettingsScreenOptions extends UsageTabOptions {
	initialConfig: CodexConversionConfig;
	onChange: (nextConfig: CodexConversionConfig) => boolean;
	onGlobalLunaCacheKeepalive: (minutes: LunaCacheKeepaliveMinutes) => CodexConversionConfig | undefined;
	onProjectCacheKeepalive: (enabled: boolean) => CodexConversionConfig | undefined;
	initialTab?: SettingsTab | undefined;
	configScope: {
		current: () => CodexConversionConfigScope;
		canUseFolder: boolean;
		path: () => string;
		reload: () => CodexConversionConfig;
		set: (scope: CodexConversionConfigScope) => CodexConversionConfig | undefined;
	};
}

export async function openCodexSettingsScreen(
	ctx: ExtensionContext,
	options: CodexSettingsScreenOptions,
): Promise<void> {
	let draft = options.initialConfig;
	let activeTab: SettingsTab = options.initialTab ?? "adapter";
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const usageTab = createUsageTab(ctx, options, () => tui.requestRender());
		let settingsList: SettingsList;

		const runEditConfig = async () => {
			if (!options.onChange(draft)) {
				ctx.ui.notify(
					"Could not save settings before opening editor",
					"warning",
				);
				return;
			}
			const result = await openCodexConfigInExternalEditor(
				options.configScope.path(),
				options.configScope.current() === "folder",
				() => tui.stop(),
				() => tui.start(),
				(full) => tui.requestRender(full),
			);
			if (!result.ok) {
				ctx.ui.notify(result.error, "warning");
				return;
			}
			draft = options.configScope.reload();
			options.onChange(draft);
			settingsList = createSettingsList();
			tui.requestRender(true);
		};

		const createSettingsList = () => {
			let list: SettingsList;
			const buildSettings = (): ConfigSetting[] => [
				{
					item: {
						id: "configScope",
						description: "Choose where changes are saved. Switching to Global removes this project\u0027s overrides.",
						label: "Editing",
						currentValue: options.configScope.current() === "folder" ? "This project" : "Global",
						values: options.configScope.canUseFolder
							? ["Global", "This project"]
							: ["Global"],
					},
				},
				...(activeTab === "adapter"
					? [{
							item: {
								id: "executionMode",
								description: "Structured: standard JSON schemas. Code: JavaScript execution.",
								label: "Execution mode",
								currentValue: formatExecutionMode(draft.executionMode),
								values: ["Structured", "Code"],
							},
							update: (value: string, current: CodexConversionConfig) => ({
								...current,
								executionMode: parseExecutionMode(value),
							}),
						}]
					: []),
				...buildConfigSettings(
					activeTab,
					draft,
					theme,
				),
			];
			list = new SettingsList(
				buildSettings().map(({ item }) => item),
				8,
				getSettingsListTheme(),
				(id, value) => {
					const definition = buildSettings().find(({ item }) => item.id === id);
					if (definition?.action === "edit-config") {
						void runEditConfig();
						return;
					}
					if (definition?.action === "project-cache-keepalive") {
						const nextDraft = options.onProjectCacheKeepalive(value !== "off");
						if (nextDraft) {
							draft = nextDraft;
							for (const { item } of buildSettings()) list.updateValue(item.id, item.currentValue);
						} else {
							list.updateValue(id, definition.item.currentValue);
						}
						tui.requestRender();
						return;
					}
					if (definition?.action === "global-luna-cache-keepalive") {
						const minutes = (value === "off" ? 0 : Number.parseInt(value, 10)) as LunaCacheKeepaliveMinutes;
						const nextDraft = options.onGlobalLunaCacheKeepalive(minutes);
						if (nextDraft) {
							draft = nextDraft;
							for (const { item } of buildSettings()) list.updateValue(item.id, item.currentValue);
						} else {
							list.updateValue(id, definition.item.currentValue);
						}
						tui.requestRender();
						return;
					}
					if (id === "configScope") {
						const previousValue = options.configScope.current() === "folder" ? "This project" : "Global";
						const nextDraft = options.configScope.set(value === "This project" ? "folder" : "global");
						if (nextDraft) {
							draft = nextDraft;
							settingsList = createSettingsList();
						} else {
							list.updateValue(id, previousValue);
						}
						tui.requestRender(true);
						return;
					}
					if (!definition?.update) return;
					const previousValue = definition.item.currentValue;
					const nextDraft = definition.update(value, draft);
					if (options.onChange(nextDraft)) {
						draft = nextDraft;
						if (activeTab === "context") {
							settingsList = createSettingsList();
							settingsList.selectItem(id);
						} else {
							for (const { item } of buildSettings())
								list.updateValue(item.id, item.currentValue);
						}
					} else {
						list.updateValue(id, previousValue);
					}
					tui.requestRender();
				},
				() => done(undefined),
			);
			return list;
		};

		const activateTab = (tab: SettingsTab) => {
			activeTab = tab;
			settingsList = createSettingsList();
			if (activeTab === "usage") usageTab.ensureLoaded();
			tui.requestRender();
		};

		settingsList = createSettingsList();
		if (activeTab === "usage") usageTab.ensureLoaded();

		return {
			render: (width: number) => {
				const hasSettingsList = activeTab !== "usage" && activeTab !== "about";
				let settingsLines = hasSettingsList ? settingsList.render(width) : [];
				if (hasSettingsList)
					settingsLines = withConfigScopeDetails(
						settingsLines,
						theme,
						options.configScope.current(),
					);
				if (activeTab === "context")
					settingsLines = withContextWindowsWarning(settingsLines, theme);
				if (activeTab === "context" && draft.compaction.contextManagement !== "off" && !draft.compaction.hybridCompaction)
					settingsLines = withSettingsDetails(settingsLines, [
						theme.fg("dim", "  /compact asks the model to save notes and hand off to a new context window, instead of summarizing."),
					]);
				if (activeTab === "tools")
					settingsLines = withSettingsDetails(
						settingsLines,
						formatToolsDetails(theme, options.configScope.path()),
					);
				return [
					rule(width, theme, "accent"),
					formatTabs(activeTab, theme),
					rule(width, theme, "borderMuted"),
					...(activeTab === "usage" ? usageTab.render(theme) : []),
					...(activeTab === "about" ? renderAboutTab(theme) : []),
					"",
					...(hasSettingsList
						? withSettingsFooter(settingsLines, theme)
						: [theme.fg("dim", formatFooter(activeTab))]),
					rule(width, theme, "accent"),
				].map((line) => truncateToWidth(line, width, ""));
			},
			invalidate: () => settingsList.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, Key.shift(Key.tab))) {
					const currentIndex = SETTINGS_TABS.findIndex(
						({ id }) => id === activeTab,
					);
					activateTab(
						SETTINGS_TABS[
							(currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
						]?.id ?? "adapter",
					);
					return;
				}
				if (matchesKey(data, Key.tab)) {
					const currentIndex = SETTINGS_TABS.findIndex(
						({ id }) => id === activeTab,
					);
					activateTab(
						SETTINGS_TABS[(currentIndex + 1) % SETTINGS_TABS.length]?.id ??
							"adapter",
					);
					return;
				}
				if (activeTab === "about" && handleAboutTabInput(data, ctx)) return;
				if (activeTab === "usage" && usageTab.handleInput(data)) return;
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function rule(
	width: number,
	theme: Theme,
	color: "accent" | "borderMuted",
): string {
	return theme.fg(color, "─".repeat(Math.max(0, width)));
}

function formatTabs(activeTab: SettingsTab, theme: Theme): string {
	return `  ${SETTINGS_TABS.map(({ id, label }) => (id === activeTab ? theme.bold(label) : theme.fg("dim", label))).join(`  ${theme.fg("dim", "/")}  `)}`;
}

function formatFooter(activeTab: SettingsTab): string {
	if (activeTab === "usage")
		return "  Tab/Shift+Tab to switch sections · R to refresh · Ctrl+R to use reset";
	if (activeTab === "about")
		return "  Tab/Shift+Tab to switch sections · G/C/D/I to open links · Esc to close";
	return "  Tab/Shift+Tab to switch sections · Esc to close";
}

function withSettingsFooter(lines: string[], theme: Theme): string[] {
	const next = [...lines];
	for (let index = next.length - 1; index >= 0; index -= 1) {
		if (next[index]?.includes("Enter/Space")) {
			next[index] = theme.fg(
				"dim",
				"  Enter/Space to change · Esc to close · Tab/Shift+Tab to switch sections",
			);
			break;
		}
	}
	return next;
}

function withConfigScopeDetails(
	lines: string[],
	theme: Theme,
	scope: CodexConversionConfigScope,
): string[] {
	const next = [...lines];
	const scopeIndex = next.findIndex((line) => line.includes("Editing"));
	if (scopeIndex < 0) return next;
	const detail = scope === "folder"
		? "Changes here update this project."
		: "Changes here update global settings.";
	next.splice(scopeIndex + 1, 0, theme.fg("dim", "  " + detail));
	return next;
}

function withContextWindowsWarning(lines: string[], theme: Theme): string[] {
	const next = [...lines];
	const settingIndex = next.findIndex((line) =>
		line.includes("Context management (experimental)")
	);
	if (settingIndex < 0) return next;
	next.splice(
		settingIndex,
		0,
		theme.fg(
			"warning",
			"  ⚠ Keep Context management enabled when resuming sessions that used it.",
		),
	);
	return next;
}

function formatToolsDetails(theme: Theme, configPath: string): string[] {
	return [
		theme.fg("dim", "  Custom native helper overrides:"),
		theme.fg("dim", "  " + configPath),
	];
}

function formatExecutionMode(mode: ExecutionMode): string {
	if (mode === "code") return "Code";
	return "Structured";
}

function parseExecutionMode(value: string): ExecutionMode {
	if (value === "Code") return "code";
	return "normal";
}

function withSettingsDetails(lines: string[], details: string[]): string[] {
	const next = [...lines];
	const footerIndex = next.findIndex((line) => line.includes("Enter/Space"));
	next.splice(footerIndex < 0 ? next.length : footerIndex, 0, ...details, "");
	return next;
}
