import type { ExecutionMode } from "./execution-mode.ts";

export type CodexVerbosity = "low" | "medium" | "high";
export type CacheDiagnosticsMode = "off" | "status" | "status-and-log";
export type CompactToolsMode = "off" | "on" | "minimal";
export type LunaCacheKeepaliveMinutes = 0 | 5 | 10 | 15;
export type AllProvidersMode = "off" | "on" | "extras";
export type ContextManagementMode = "off" | "local" | "tree" | "remote";
export type V2UserMessageRetention = 16 | 32 | 64;
export const MIN_NOTEBOOK_HEAP_MIB = 256;
export const MAX_NOTEBOOK_HEAP_MIB = 65_536;
export const V2_USER_MESSAGE_RETENTION_OPTIONS: readonly V2UserMessageRetention[] =
	[16, 32, 64];
export const LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS: readonly LunaCacheKeepaliveMinutes[] =
	[0, 5, 10, 15];

export interface CodexConversionConfig {
	executionMode: ExecutionMode;
	prompt: { heavySystemPromptOverwrite: boolean };
	scope: { allProviders: AllProvidersMode; additionalProviders: string[] };
	tools: {
		autoReasoning: boolean;
		customRustBinariesDir: string;
		viewImageFallback: boolean;
		applyPatchOnly: boolean;
		viewImageOnly: boolean;
	};
	ui: {
		statusLine: boolean;
		toolRenaming: boolean;
		compactTools: CompactToolsMode;
		codeModeDetails: boolean;
		backgroundShellWidget: boolean;
		backgroundShellToggleShortcut: string;
		backgroundShellPrevShortcut: string;
		backgroundShellNextShortcut: string;
		backgroundShellCloseShortcut: string;
	};
	compaction: {
		contextManagement: ContextManagementMode;
		hybridCompaction: boolean;
		responsesCompaction: boolean;
		portableSummary: boolean;
		v2UserMessageRetention: V2UserMessageRetention;
	};
	notebook: {
		maxHeapMiB: number;
		plainCommandOutput: boolean;
		profile?: string | undefined;
	};
	openai: {
		fast: boolean;
		verbosity: CodexVerbosity;
		lunaCacheKeepaliveMinutes: LunaCacheKeepaliveMinutes;
		cacheKeepalive: boolean;
		proxyResponsesLite: boolean;
		forceCachedWebSockets: boolean;
		cacheDiagnostics: CacheDiagnosticsMode;
		harnessIdentifierHeader: boolean;
	};
}

export const DEFAULT_CODEX_CONVERSION_CONFIG: CodexConversionConfig = {
	executionMode: "normal",
	prompt: { heavySystemPromptOverwrite: false },
	scope: { allProviders: "off", additionalProviders: [] },
	tools: {
		autoReasoning: false,
		customRustBinariesDir: "",
		viewImageFallback: false,
		applyPatchOnly: false,
		viewImageOnly: false,
	},
	ui: {
		statusLine: true,
		toolRenaming: true,
		compactTools: "off",
		codeModeDetails: false,
		backgroundShellWidget: true,
		backgroundShellToggleShortcut: "alt+w",
		backgroundShellPrevShortcut: "alt+q",
		backgroundShellNextShortcut: "alt+e",
		backgroundShellCloseShortcut: "alt+r",
	},
	compaction: {
		contextManagement: "off",
		hybridCompaction: false,
		responsesCompaction: false,
		portableSummary: false,
		v2UserMessageRetention: 64,
	},
	notebook: { maxHeapMiB: 4_096, plainCommandOutput: false },
	openai: {
		fast: false,
		verbosity: "low",
		lunaCacheKeepaliveMinutes: 0,
		cacheKeepalive: false,
		proxyResponsesLite: false,
		forceCachedWebSockets: true,
		cacheDiagnostics: "off",
		harnessIdentifierHeader: false,
	},
};
