import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type CustomToolDiscoveryError,
	discoverCustomToolsFromDirectories,
	getCustomToolsDir,
	getProjectCustomToolsDir,
} from "./custom-tools.ts";
import { replaceCodeModeToolsPrompt } from "./custom-tool-prompt.ts";
import { registerPublicCodeModeTools } from "./public-tools.ts";
import {
	SharedCodeModeRuntime,
	type CodeModeToolProvider,
} from "./shared-runtime.ts";
import { registerCodeModeEvents } from "./tool-events.ts";

// Providers in one extension instance share a process-lifetime host runtime.
// Pi replaces ExtensionAPI registrations on reload, so each API binds its own surface.
const REGISTRATION_KEY = Symbol.for("@howaboua/pi-codex-conversion.code-mode");

interface CodeModeProcessState {
	runtime: SharedCodeModeRuntime;
	boundApis: WeakSet<object>;
}

export interface RegisterCodeModeToolsOptions extends CodeModeToolProvider {}

export interface CodeModeRegistration {
	prepare(ctx?: unknown): Promise<void> | undefined;
	refreshPromptTools(systemPrompt: string, ctx?: unknown): string;
	shutdownHost(): Promise<void>;
	shutdown(): Promise<void>;
}

export async function registerCustomTools(
	pi: ExtensionAPI,
	toolsDir?: string | readonly string[],
	options: { isActive?(ctx: unknown): boolean } = {},
): Promise<CodeModeRegistration> {
	const usesDefaultDirs = toolsDir === undefined;
	const toolsDirs = toolsDir === undefined
		? [getCustomToolsDir()]
		: typeof toolsDir === "string"
			? [toolsDir]
			: [...toolsDir];
	let previousErrors = new Map<string, string>();
	return registerCodeModeTools(pi, {
		getTools: (ctx) => {
			const activeDirs = usesDefaultDirs && isTrustedProjectContext(ctx)
				? [...toolsDirs, getProjectCustomToolsDir(ctx.cwd)]
				: toolsDirs;
			const discovery = discoverCustomToolsFromDirectories(activeDirs);
			previousErrors = reportCustomToolErrors(
				ctx,
				discovery.errors,
				previousErrors,
			);
			return discovery.tools;
		},
		documentationPath: customToolsDocumentationPath(),
		...options,
	});
}

function reportCustomToolErrors(
	ctx: unknown,
	errors: CustomToolDiscoveryError[],
	previous: Map<string, string>,
): Map<string, string> {
	if (!isExtensionContext(ctx)) return previous;
	const current = new Map(errors.map((error) => [error.path, error.message]));
	for (const error of errors) {
		if (previous.get(error.path) === error.message) continue;
		ctx.ui.notify(`Code Mode custom tool disabled: ${error.message}`, "error");
	}
	return current;
}

function isExtensionContext(value: unknown): value is ExtensionContext {
	return Boolean(
		value &&
			typeof value === "object" &&
			"ui" in value &&
			value.ui &&
			typeof value.ui === "object" &&
			"notify" in value.ui &&
			typeof value.ui.notify === "function",
	);
}

function isTrustedProjectContext(value: unknown): value is ExtensionContext {
	return Boolean(
		value &&
			typeof value === "object" &&
			"isProjectTrusted" in value &&
			typeof value.isProjectTrusted === "function" &&
			value.isProjectTrusted(),
	);
}

export async function registerCodeModeTools(
	pi: ExtensionAPI,
	options: RegisterCodeModeToolsOptions,
): Promise<CodeModeRegistration> {
	const runtime = getOrCreateRuntime(pi);
	const providerId = runtime.addProvider(options);
	let active = true;
	return {
		prepare: (ctx) => runtime.prepare(ctx),
		refreshPromptTools(systemPrompt, ctx) {
			const activeProviders = runtime.activeProviders(ctx);
			const documentationPath = activeProviders.find(
				(provider) => provider.documentationPath,
			)?.documentationPath;
			const previousSection = runtime.getPromptSection();
			const nextTools = runtime.refreshPromptTools(ctx);
			const replacement = replaceCodeModeToolsPrompt(
				systemPrompt,
				previousSection,
				nextTools,
				documentationPath,
			);
			runtime.setPromptSection(replacement.section);
			return replacement.systemPrompt;
		},
		shutdownHost: () => runtime.shutdownHost(),
		async shutdown() {
			if (!active) return;
			active = false;
			runtime.removeProvider(providerId);
			if (runtime.providers.size === 0) await runtime.shutdownHost();
		},
	};
}

function getOrCreateRuntime(pi: ExtensionAPI): SharedCodeModeRuntime {
	const state = pi.events as typeof pi.events & {
		[REGISTRATION_KEY]?: CodeModeProcessState;
	};
	const existing = state[REGISTRATION_KEY];
	const processState = isProcessState(existing)
		? existing
		: { runtime: new SharedCodeModeRuntime(), boundApis: new WeakSet<ExtensionAPI>() };
	state[REGISTRATION_KEY] = processState;
	if (!processState.boundApis.has(pi)) {
		processState.boundApis.add(pi);
		registerCodeModeEvents(pi, processState.runtime);
		registerPublicCodeModeTools(pi, processState.runtime);
	}
	return processState.runtime;
}

function isProcessState(value: unknown): value is CodeModeProcessState {
	return Boolean(
		value &&
		typeof value === "object" &&
		"runtime" in value &&
		isSharedRuntime(value.runtime) &&
		"boundApis" in value &&
		value.boundApis instanceof WeakSet,
	);
}

function isSharedRuntime(value: unknown): value is SharedCodeModeRuntime {
	return Boolean(
		value &&
		typeof value === "object" &&
		"providers" in value &&
		value.providers instanceof Map &&
		"shutdownHost" in value &&
		typeof value.shutdownHost === "function",
	);
}

function customToolsDocumentationPath(): string {
	return fileURLToPath(new URL("./CUSTOM-TOOLS.md", import.meta.url));
}
