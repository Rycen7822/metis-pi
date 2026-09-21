import {
	type CodexConversionConfig,
	DEFAULT_CODEX_CONVERSION_CONFIG,
	MAX_NOTEBOOK_HEAP_MIB,
	MIN_NOTEBOOK_HEAP_MIB,
} from "./config-contract.ts";
import {
	isObject,
	normalizeAllProvidersMode,
	normalizeCacheDiagnosticsMode,
	normalizeCodexVerbosity,
	normalizeCompactToolsMode,
	normalizeContextManagementMode,
	normalizeCustomRustBinariesDir,
	normalizeDictationShortcutMode,
	normalizeLunaCacheKeepaliveMinutes,
	normalizeProviderList,
	normalizeRealtimeV3Voice,
	normalizeV2UserMessageRetention,
	normalizeVoiceContextReasoning,
} from "./config-normalizers.ts";
import {
	normalizeBoolean,
	normalizeIntegerInRange,
	normalizeNotebookProfile,
	normalizeOptionalString,
	normalizeString,
	normalizeVoiceContextModel,
} from "./config-values.ts";
import { normalizeExecutionMode } from "./execution-mode.ts";

type Section = Exclude<keyof CodexConversionConfig, "executionMode" | "voiceFeaturesOnly">;
type BooleanFields<T> = { [K in keyof T as T[K] extends boolean ? K : never]: T[K] };

// Default booleans have one rule. Enum/string/optional fields and dependencies stay explicit below.
function booleans<K extends Section>(section: K, values: Record<string, unknown>): BooleanFields<CodexConversionConfig[K]> {
	return Object.fromEntries(Object.entries(DEFAULT_CODEX_CONVERSION_CONFIG[section])
		.filter(([, fallback]) => typeof fallback === "boolean")
		.map(([key, fallback]) => [key, normalizeBoolean(values[key], fallback as boolean)])) as BooleanFields<CodexConversionConfig[K]>;
}

export function normalizeCodexConversionConfig(
	value: unknown,
): CodexConversionConfig {
	const defaults = DEFAULT_CODEX_CONVERSION_CONFIG;
	if (!isObject(value)) return structuredClone(defaults);
	const prompt = isObject(value["prompt"]) ? value["prompt"] : {};
	const scope = isObject(value["scope"]) ? value["scope"] : {};
	const tools = isObject(value["tools"]) ? value["tools"] : {};
	const ui = { ...(isObject(value["ui"]) ? value["ui"] : {}) };
	if (typeof ui["toolRenaming"] !== "boolean") ui["toolRenaming"] = ui["toolRendering"];
	const compaction = isObject(value["compaction"]) ? value["compaction"] : {};
	const notebook = isObject(value["notebook"]) ? value["notebook"] : {};
	const voice = isObject(value["voice"]) ? value["voice"] : {};
	const openai = isObject(value["openai"]) ? value["openai"] : {};
	const inputDevice = normalizeOptionalString(voice["inputDevice"]);
	const outputDevice = normalizeOptionalString(voice["outputDevice"]);
	const contextModel = normalizeVoiceContextModel(voice["contextModel"]);
	const notebookProfile = normalizeNotebookProfile(notebook["profile"]);
	const executionMode =
		normalizeExecutionMode(value["executionMode"]) ??
		defaults.executionMode;
	const contextManagement =
		normalizeContextManagementMode(compaction["contextManagement"]) ??
		defaults.compaction.contextManagement;
	const config: CodexConversionConfig = {
		executionMode,
		voiceFeaturesOnly: normalizeBoolean(
			value["voiceFeaturesOnly"],
			defaults.voiceFeaturesOnly,
		),
		prompt: {
			...booleans("prompt", prompt),
		},
		scope: {
			allProviders:
				normalizeAllProvidersMode(scope["allProviders"]) ??
				defaults.scope["allProviders"],
			additionalProviders: normalizeProviderList(scope["additionalProviders"]),
		},
		tools: {
			...booleans("tools", tools),
			customRustBinariesDir: normalizeCustomRustBinariesDir(
				tools["customRustBinariesDir"],
			),
		},
		ui: {
			...booleans("ui", ui),
			compactTools: normalizeCompactToolsMode(ui["compactTools"])
				?? defaults.ui.compactTools,
			backgroundShellToggleShortcut: normalizeString(
				ui["backgroundShellToggleShortcut"],
				defaults.ui["backgroundShellToggleShortcut"],
			),
			backgroundShellPrevShortcut: normalizeString(
				ui["backgroundShellPrevShortcut"],
				defaults.ui["backgroundShellPrevShortcut"],
			),
			backgroundShellNextShortcut: normalizeString(
				ui["backgroundShellNextShortcut"],
				defaults.ui["backgroundShellNextShortcut"],
			),
			backgroundShellCloseShortcut: normalizeString(
				ui["backgroundShellCloseShortcut"],
				defaults.ui["backgroundShellCloseShortcut"],
			),
		},
		compaction: {
			...booleans("compaction", compaction),
			contextManagement,
			v2UserMessageRetention:
				normalizeV2UserMessageRetention(compaction["v2UserMessageRetention"]) ??
				defaults.compaction.v2UserMessageRetention,
		},
		notebook: {
			...booleans("notebook", notebook),
			maxHeapMiB: normalizeIntegerInRange(
				notebook["maxHeapMiB"],
				defaults.notebook.maxHeapMiB,
				MIN_NOTEBOOK_HEAP_MIB,
				MAX_NOTEBOOK_HEAP_MIB,
			),
			...(notebookProfile ? { profile: notebookProfile } : {}),
		},
		voice: {
			...booleans("voice", voice),
			v3Voice:
				normalizeRealtimeV3Voice(voice["v3Voice"]) ??
				defaults.voice.v3Voice,
			dictationShortcut: normalizeString(
				voice["dictationShortcut"],
				defaults.voice.dictationShortcut,
			),
			realtimeShortcut: normalizeString(
				voice["realtimeShortcut"],
				defaults.voice.realtimeShortcut,
			),
			muteShortcut: normalizeString(
				voice["muteShortcut"],
				defaults.voice.muteShortcut,
			),
			serverShortcut: normalizeString(
				voice["serverShortcut"],
				defaults.voice.serverShortcut,
			),
			dictationShortcutMode:
				normalizeDictationShortcutMode(voice["dictationShortcutMode"]) ??
				defaults.voice.dictationShortcutMode,
			...(contextModel ? { contextModel } : {}),
			contextReasoning: normalizeVoiceContextReasoning(
				voice["contextReasoning"],
			),
			...(inputDevice ? { inputDevice } : {}),
			...(outputDevice ? { outputDevice } : {}),
		},
		openai: {
			...booleans("openai", openai),
			verbosity:
				normalizeCodexVerbosity(openai["verbosity"]) ??
				defaults.openai["verbosity"],
			lunaCacheKeepaliveMinutes:
				normalizeLunaCacheKeepaliveMinutes(
					openai["lunaCacheKeepaliveMinutes"],
				) ?? defaults.openai.lunaCacheKeepaliveMinutes,
			cacheDiagnostics:
				normalizeCacheDiagnosticsMode(openai["cacheDiagnostics"]) ??
				defaults.openai.cacheDiagnostics,
		},
	};
	// Apply dependent switches once, after their own values have been normalized.
	config.compaction.hybridCompaction &&= contextManagement !== "off";
	config.compaction.responsesCompaction &&= contextManagement === "off";
	config.compaction.portableSummary &&= config.compaction.responsesCompaction;
	config.voice.refreshRealtimeAfterCompaction &&= contextModel !== undefined;
	return config;
}
