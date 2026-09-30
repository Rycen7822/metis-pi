import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ensureCodeModeHostBinary } from "./binary.ts";
import { waitWithSignal } from "./host-operation.ts";
import { CodeModeHostClient } from "./host-client.ts";
import { codeModeGlobalName } from "./tool-identity.ts";
import { CodeModeNestedRenderStore } from "./trace-render-state.ts";
import type {
	CodeModeToolDefinition,
} from "./types.ts";

export interface CodeModeToolProvider {
	getTools(ctx?: unknown, callable?: readonly AgentTool[]): CodeModeToolDefinition[];
	documentationPath?: string | undefined;
	isActive?(ctx: unknown): boolean;
	providesRenderers?: boolean | undefined;
	richRendering?(): boolean;
	minimalOutput?(): boolean;
}

export class SharedCodeModeRuntime {
	callableTools: readonly AgentTool[] = [];
	waitAvailable = true;
	readonly providers = new Map<object, CodeModeToolProvider>();
	readonly renderStore = new CodeModeNestedRenderStore();
	private observations = new Set<AbortController>();
	private clientPromise: Promise<CodeModeHostClient> | undefined;
	private clientStartupAbort: AbortController | undefined;
	private customPromptToolsSnapshot: CodeModeToolDefinition[] | undefined;
	private promptSectionSnapshot: string | undefined;

	addProvider(provider: CodeModeToolProvider): object {
		const id = {};
		this.providers.set(id, provider);
		return id;
	}

	removeProvider(id: object): void {
		this.providers.delete(id);
	}

	activeProviders(ctx?: unknown): CodeModeToolProvider[] {
		return [...this.providers.values()].filter(
			(provider) => !provider.isActive || provider.isActive(ctx),
		);
	}

	collectTools(ctx?: unknown): CodeModeToolDefinition[] {
		const tools = this.collectProviderTools(ctx);
		return this.customPromptToolsSnapshot
			? applyCustomPromptState(tools, this.customPromptToolsSnapshot)
			: tools;
	}

	refreshPromptTools(ctx?: unknown): CodeModeToolDefinition[] {
		const tools = this.collectProviderTools(ctx);
		this.customPromptToolsSnapshot = tools.filter(isCustomTool);
		return tools;
	}

	resetPromptTools(ctx?: unknown): CodeModeToolDefinition[] {
		this.promptSectionSnapshot = undefined;
		return this.refreshPromptTools(ctx);
	}

	collectPromptTools(ctx?: unknown): CodeModeToolDefinition[] {
		if (!this.customPromptToolsSnapshot) return this.refreshPromptTools(ctx);
		const liveProgrammaticTools = this.collectProviderTools(ctx)
			.filter((tool) => !isCustomTool(tool));
		return [...liveProgrammaticTools, ...this.customPromptToolsSnapshot];
	}

	setPromptSection(section: string): void {
		this.promptSectionSnapshot = section;
	}

	getPromptSection(): string | undefined {
		return this.promptSectionSnapshot;
	}

	collectRenderTools(): CodeModeToolDefinition[] {
		return collectUniqueTools(
			[...this.providers.values()].filter((provider) => provider.providesRenderers),
		);
	}

	useRichRendering(): boolean {
		return [...this.providers.values()].find((provider) => provider.richRendering)
			?.richRendering?.() ?? true;
	}

	useMinimalOutput(): boolean {
		return [...this.providers.values()].find((provider) => provider.minimalOutput)
			?.minimalOutput?.() ?? false;
	}

	async observe<T>(run: (preempt: AbortSignal) => Promise<T>): Promise<T> {
		const observation = new AbortController();
		this.observations.add(observation);
		try { return await run(observation.signal); }
		finally { this.observations.delete(observation); }
	}

	yieldObservations(): void {
		for (const observation of this.observations) observation.abort();
	}

	async getClient(signal?: AbortSignal): Promise<CodeModeHostClient> {
		if (!this.clientPromise) {
			const startupAbort = new AbortController();
			const pending = ensureCodeModeHostBinary(startupAbort.signal).then(
				(binary) => new CodeModeHostClient({
					binary,
					tools: [],
					renderStore: this.renderStore,
				}),
			);
			this.clientPromise = pending;
			this.clientStartupAbort = startupAbort;
			void pending.then(
				() => {
					if (this.clientPromise === pending) this.clientStartupAbort = undefined;
				},
				() => {
					if (this.clientPromise !== pending) return;
					this.clientPromise = undefined;
					this.clientStartupAbort = undefined;
				},
			);
		}
		return waitWithSignal(this.clientPromise, signal);
	}

	prepare(ctx?: unknown): Promise<void> | undefined {
		if (this.activeProviders(ctx).length === 0) return undefined;
		return this.getClient().then(() => undefined);
	}

	async shutdownHost(): Promise<void> {
		while (this.clientPromise) {
			const pending = this.clientPromise;
			this.clientPromise = undefined;
			this.clientStartupAbort?.abort();
			this.clientStartupAbort = undefined;
			try {
				await (await pending).shutdown();
			} catch {
				// Startup failure already reached the caller.
			}
		}
	}

	private collectProviderTools(ctx?: unknown): CodeModeToolDefinition[] {
		return collectUniqueTools(this.activeProviders(ctx), ctx, this.callableTools);
	}
}

function isCustomTool(tool: CodeModeToolDefinition): boolean {
	return "command" in tool;
}

function applyCustomPromptState(
	tools: CodeModeToolDefinition[],
	customPromptTools: CodeModeToolDefinition[],
): CodeModeToolDefinition[] {
	const customPromptState = new Map(
		customPromptTools.map((tool) => [tool.name, tool.deferLoading]),
	);
	return tools.map((tool) =>
		isCustomTool(tool)
			? {
					...tool,
					deferLoading: customPromptState.get(tool.name) ?? true,
				}
			: tool,
	);
}

function collectUniqueTools(
	providers: CodeModeToolProvider[],
	ctx?: unknown,
	callable?: readonly AgentTool[],
): CodeModeToolDefinition[] {
	const tools = providers.flatMap((provider) => provider.getTools(ctx, callable));
	const byName = new Map<string, CodeModeToolDefinition>();
	const unique: CodeModeToolDefinition[] = [];
	for (const tool of tools) {
		const globalName = codeModeGlobalName(tool.name);
		const previous = byName.get(globalName);
		if (previous) {
			if (
				previous.name === tool.name &&
				"sourcePath" in previous &&
				"sourcePath" in tool &&
				previous.sourcePath === tool.sourcePath
			)
				continue;
			if (previous.name !== tool.name) {
				throw new Error(
					`Code Mode tool names ${previous.name} and ${tool.name} both translate to ${globalName}`,
				);
			}
			throw new Error(`Duplicate code-mode tool: ${tool.name}`);
		}
		byName.set(globalName, tool);
		unique.push(tool);
	}
	return unique;
}
