import { ensureCodeModeHostBinary } from "./binary.js";
import { CodeModeHostClient } from "./host-client.js";
import { createNotebookControlProxy } from "./notebook-tool.js";
import { codeModeGlobalName } from "./tool-identity.js";
import { CodeModeNestedRenderStore } from "./trace-render-state.js";
export class SharedCodeModeRuntime {
    providers = new Map();
    renderStore = new CodeModeNestedRenderStore();
    clientPromise;
    notebookClientPromise;
    notebookClientOptionsKey;
    notebookClientTransition = Promise.resolve();
    clientStartupAbort;
    customPromptToolsSnapshot;
    promptSectionSnapshot;
    addProvider(provider) {
        const id = {};
        this.providers.set(id, provider);
        return id;
    }
    removeProvider(id) {
        this.providers.delete(id);
    }
    activeProviders(ctx) {
        return [...this.providers.values()].filter((provider) => !provider.isActive || provider.isActive(ctx));
    }
    collectTools(ctx) {
        const tools = this.collectProviderTools(ctx);
        return this.customPromptToolsSnapshot
            ? applyCustomPromptState(tools, this.customPromptToolsSnapshot)
            : tools;
    }
    refreshPromptTools(ctx) {
        const tools = this.collectProviderTools(ctx);
        this.customPromptToolsSnapshot = tools.filter(isCustomTool);
        return tools;
    }
    resetPromptTools(ctx) {
        this.promptSectionSnapshot = undefined;
        return this.refreshPromptTools(ctx);
    }
    collectPromptTools(ctx) {
        if (!this.customPromptToolsSnapshot)
            return this.refreshPromptTools(ctx);
        const liveProgrammaticTools = this.collectProviderTools(ctx)
            .filter((tool) => !isCustomTool(tool));
        return [...liveProgrammaticTools, ...this.customPromptToolsSnapshot];
    }
    setPromptSection(section) {
        this.promptSectionSnapshot = section;
    }
    getPromptSection() {
        return this.promptSectionSnapshot;
    }
    collectRenderTools() {
        return collectUniqueTools([...this.providers.values()].filter((provider) => provider.providesRenderers));
    }
    useRichRendering() {
        return [...this.providers.values()].find((provider) => provider.richRendering)
            ?.richRendering?.() ?? true;
    }
    useMinimalOutput() {
        return [...this.providers.values()].find((provider) => provider.minimalOutput)
            ?.minimalOutput?.() ?? false;
    }
    executionKind(ctx) {
        const explicit = new Set(this.activeProviders(ctx)
            .map((provider) => provider.executionKind?.(ctx))
            .filter((kind) => Boolean(kind)));
        if (explicit.size > 1)
            throw new Error("Conflicting code-mode execution runtimes are active");
        return explicit.values().next().value ?? "code";
    }
    async getClient(ctx) {
        if (this.executionKind(ctx) === "notebook")
            return this.getNotebookClient(ctx);
        if (!this.clientPromise) {
            const startupAbort = new AbortController();
            const pending = ensureCodeModeHostBinary(startupAbort.signal).then((binary) => new CodeModeHostClient({
                binary,
                tools: [],
                renderStore: this.renderStore,
            }));
            this.clientPromise = pending;
            this.clientStartupAbort = startupAbort;
            void pending.then(() => {
                if (this.clientPromise === pending)
                    this.clientStartupAbort = undefined;
            }, () => {
                if (this.clientPromise !== pending)
                    return;
                this.clientPromise = undefined;
                this.clientStartupAbort = undefined;
            });
        }
        return this.clientPromise;
    }
    getNotebookClient(ctx) {
        const options = this.activeProviders(ctx).find((provider) => provider.notebookOptions)?.notebookOptions?.(ctx);
        if (!options)
            return Promise.reject(new Error("Notebook Code Mode runtime options are unavailable"));
        const key = JSON.stringify([options.agentDir, options.maxHeapMiB, options.profile ?? null]);
        if (this.notebookClientPromise && this.notebookClientOptionsKey === key)
            return this.notebookClientPromise;
        const transition = this.notebookClientTransition.then(async () => {
            if (this.notebookClientPromise && this.notebookClientOptionsKey !== key) {
                const previous = this.notebookClientPromise;
                this.notebookClientPromise = undefined;
                this.notebookClientOptionsKey = undefined;
                await (await previous).shutdown();
            }
            if (!this.notebookClientPromise) {
                const pending = import("../notebook-mode/client.js").then(({ NotebookCodeModeClient }) => new NotebookCodeModeClient(options, this.renderStore));
                this.notebookClientPromise = pending;
                this.notebookClientOptionsKey = key;
                void pending.catch(() => {
                    if (this.notebookClientPromise !== pending)
                        return;
                    this.notebookClientPromise = undefined;
                    this.notebookClientOptionsKey = undefined;
                });
            }
            return this.notebookClientPromise;
        });
        this.notebookClientTransition = transition.then(() => undefined, () => undefined);
        return transition;
    }
    prepare(ctx) {
        if (this.activeProviders(ctx).length === 0)
            return undefined;
        return this.getClient(ctx).then(() => undefined);
    }
    async checkpointNotebook() {
        const pending = this.notebookClientPromise;
        if (!pending)
            return;
        const client = await pending;
        await client.checkpoint?.();
    }
    async controlNotebook(request, context, signal) {
        if (this.executionKind(context.extensionContext) !== "notebook") {
            throw new Error("notebook is available only in Notebook Mode");
        }
        const client = await this.getNotebookClient(context.extensionContext);
        if (!client.controlNotebook)
            throw new Error("Notebook lifecycle controls are unavailable");
        return client.controlNotebook(request, context, signal);
    }
    async shutdownHost() {
        await this.notebookClientTransition;
        while (this.clientPromise) {
            const pending = this.clientPromise;
            this.clientPromise = undefined;
            this.clientStartupAbort?.abort();
            this.clientStartupAbort = undefined;
            try {
                await (await pending).shutdown();
            }
            catch {
                // Startup failure already reached the caller.
            }
        }
        while (this.notebookClientPromise) {
            const pending = this.notebookClientPromise;
            this.notebookClientPromise = undefined;
            this.notebookClientOptionsKey = undefined;
            try {
                await (await pending).shutdown();
            }
            catch {
                // Startup failure already reached the caller.
            }
        }
    }
    collectProviderTools(ctx) {
        const tools = collectUniqueTools(this.activeProviders(ctx), ctx);
        if (this.executionKind(ctx) !== "notebook")
            return tools;
        if (tools.some((tool) => tool.name === "notebook"))
            throw new Error("Duplicate code-mode tool: notebook");
        return [...tools, createNotebookControlProxy(this)];
    }
}
function isCustomTool(tool) {
    return "command" in tool;
}
function applyCustomPromptState(tools, customPromptTools) {
    const customPromptState = new Map(customPromptTools.map((tool) => [tool.name, tool.deferLoading]));
    return tools.map((tool) => isCustomTool(tool)
        ? {
            ...tool,
            deferLoading: customPromptState.get(tool.name) ?? true,
        }
        : tool);
}
function collectUniqueTools(providers, ctx) {
    const tools = providers.flatMap((provider) => provider.getTools(ctx));
    const byName = new Map();
    const unique = [];
    for (const tool of tools) {
        const globalName = codeModeGlobalName(tool.name);
        const previous = byName.get(globalName);
        if (previous) {
            if (previous.name === tool.name &&
                "sourcePath" in previous &&
                "sourcePath" in tool &&
                previous.sourcePath === tool.sourcePath)
                continue;
            if (previous.name !== tool.name) {
                throw new Error(`Code Mode tool names ${previous.name} and ${tool.name} both translate to ${globalName}`);
            }
            throw new Error(`Duplicate code-mode tool: ${tool.name}`);
        }
        byName.set(globalName, tool);
        unique.push(tool);
    }
    return unique;
}
