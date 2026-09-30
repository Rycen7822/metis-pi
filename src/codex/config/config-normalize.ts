import {
	type CodexConversionConfig,
	DEFAULT_CODEX_CONVERSION_CONFIG,
} from "./config-contract.ts";
import {
	isObject,
	normalizeAllProvidersMode,
	normalizeCacheDiagnosticsMode,
	normalizeCodexVerbosity,
	normalizeCompactToolsMode,
	normalizeContextManagementMode,
	normalizeCustomRustBinariesDir,
	normalizeLunaCacheKeepaliveMinutes,
	normalizeProviderList,
	normalizeV2UserMessageRetention,
} from "./config-normalizers.ts";
import {
	normalizeBoolean,
	normalizeString,
} from "./config-values.ts";
import { normalizeExecutionMode } from "./execution-mode.ts";

type Section = Exclude<keyof CodexConversionConfig, "executionMode">;
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
	const ui = isObject(value["ui"]) ? value["ui"] : {};
	const compaction = isObject(value["compaction"]) ? value["compaction"] : {};
	const openai = isObject(value["openai"]) ? value["openai"] : {};
	const executionMode =
		normalizeExecutionMode(value["executionMode"]) ??
		defaults.executionMode;
	const contextManagement =
		normalizeContextManagementMode(compaction["contextManagement"]) ??
		defaults.compaction.contextManagement;
	const config: CodexConversionConfig = {
		executionMode,
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
	return config;
}
