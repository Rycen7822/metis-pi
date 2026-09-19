import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { readCodexCacheEnvironment } from "../adapter/activation/cache-environment.js";
import { resolveCodexCacheKeepalivePlan } from "../adapter/activation/cache-keepalive.js";
import { getCodexConversionConfigPath, readEffectiveCodexConversionConfig } from "../adapter/activation/config-store.js";
import { isAdapterRuntime, resolveCodexRuntimePlanForState } from "../adapter/activation/runtime-plan.js";
import { rewriteCodexPrewarmProviderRequest, rewriteCodexProviderRequest, supportsCodexDeveloperMessages } from "../adapter/provider-request.js";
import { getPiCodexRuntimeShell } from "../adapter/prompt/runtime-shell.js";
import { isProviderContextExcludedMessage } from "../adapter/prompt/context-filter.js";
import { buildCodexSystemPrompt } from "../prompt/build-system-prompt.js";
import { closeOpenAICodexKeepaliveWebSocketSession, closeOpenAICodexWebSocketSessions, prewarmOpenAICodexWebSocket } from "../providers/openai-codex-custom-provider.js";
import { resetOpenAICodexWebSocketSessions } from "../providers/openai-codex/websocket.js";
import { createCodexTurnState } from "../providers/openai-codex/turn-state.js";
import { createExecCommandTracker } from "../tools/exec/command-state.js";
import { createExecSessionManager } from "../tools/exec/session-manager.js";
import { getBundledToolBinaryPath } from "../tools/native/binary.js";
import { CodexVoiceController } from "../voice/controller.js";
import { CodexLanVoiceServerController } from "../voice/lan/controller.js";
import { getActiveToolsInActiveOrder } from "../adapter/active-tools.js";
import { createLazyCodexDiagnostics } from "../diagnostics/lazy.js";
import { CodexDeveloperMessageBridge } from "../adapter/developer-messages.js";
import { CodexContextWindowManager } from "../context-management/window-manager.js";
import { CodexContextWindowKickoff } from "../context-management/window-kickoff.js";
import { CodexContextTreeCoordinator } from "../context-management/tree-coordinator.js";
import { projectTreeCheckpointBranch, projectTreeCheckpointMessages } from "../context-management/tree-checkpoint.js";
import { hasPendingCodexReasoningUpdate, supportsCodexReasoningUpdates } from "../adapter/reasoning-updates.js";
import { projectCodexReasoningHistory } from "../adapter/reasoning-history.js";
import { createAutoReasoning } from "../adapter/auto-reasoning.js";
function activeToolContext(pi) {
    // Pi ToolInfo omits constrainedSampling; restore our owned exec contract so
    // prewarm and the real Code Mode turn serialize the same provider tools.
    return getActiveToolsInActiveOrder(pi, true);
}
function prewarmReasoningOption(level) {
    return level === "off" ? {} : { reasoning: level };
}
export function createCodexExtensionRuntime(pi) {
    const cacheEnvironment = readCodexCacheEnvironment();
    for (const warning of cacheEnvironment.warnings) {
        console.warn(`[pi-codex-conversion] ${warning}`);
    }
    const initialConfig = readEffectiveCodexConversionConfig({ cwd: process.cwd(), projectTrusted: false });
    const voice = new CodexVoiceController(pi);
    const contextWindows = new CodexContextWindowManager(undefined, async (ctx, options) => {
        voice.announceContextTransition("rollover");
        await voice.refreshRealtimeContext(ctx, state.config, options);
    });
    const contextKickoff = new CodexContextWindowKickoff(contextWindows, (input) => {
        // Extension kickoffs bypass ordinary voice input routing, including after call replacement.
        const text = typeof input === "string" ? input : input
            .flatMap((part) => part.type === "text" ? [part.text] : [])
            .join("\n");
        voice.piInput(text.trim() ? text : "Continue.");
    });
    const state = {
        enabled: false,
        cwd: process.cwd(),
        promptSkills: [],
        config: initialConfig,
        executionMode: initialConfig.executionMode,
        codexTurnState: createCodexTurnState(),
        developerMessages: new CodexDeveloperMessageBridge(),
        contextWindows,
        contextKickoff,
        contextTree: new CodexContextTreeCoordinator(contextWindows, contextKickoff),
    };
    const tracker = createExecCommandTracker();
    const sessions = createExecSessionManager({
        env: { ...process.env },
        bridgeBinaryPath: () => getBundledToolBinaryPath("exec_bridge", {}, state.config.tools.customRustBinariesDir),
    });
    let prewarmController;
    let prewarmPromise;
    let prewarmTransportSettlement;
    let pendingPrewarmKey;
    let prewarmedKey;
    let activePrewarmKind;
    let cacheKeepaliveTimer;
    let cacheKeepaliveEpoch = 0;
    const diagnostics = createLazyCodexDiagnostics();
    let cacheEnvironmentWarningsReported = false;
    const buildPrewarmPlan = (ctx, systemPrompt, prepared, messages, rewriteFinalRequest, promptCacheRefresh = false) => {
        const model = ctx.model;
        const config = structuredClone(state.config);
        const executionMode = state.executionMode;
        const runtimePlan = resolveCodexRuntimePlanForState(ctx, { ...state, config, executionMode });
        if (!model
            || !runtimePlan.codexTransport
            || !isAdapterRuntime(runtimePlan)
            || (!promptCacheRefresh && !config.openai.forceCachedWebSockets))
            return undefined;
        // A non-generating warmup must not consume an update before the next
        // response, otherwise more selector presses could rewrite its sent tail.
        if (supportsCodexReasoningUpdates(model) && hasPendingCodexReasoningUpdate(projectContextMessages(ctx)))
            return undefined;
        const preparedSystemPrompt = prepared
            ? systemPrompt
            : runtime.codexSystemPrompt(systemPrompt, ctx);
        const tools = activeToolContext(pi);
        const reasoning = prewarmReasoningOption(pi.getThinkingLevel());
        const identity = JSON.stringify({
            model: { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl },
            systemPrompt: preparedSystemPrompt,
            tools,
            reasoning,
            openai: config.openai,
            compaction: config.compaction,
            executionMode,
        });
        const key = JSON.stringify({
            identity,
            messages,
            rewriteFinalRequest,
        });
        return {
            model,
            config,
            executionMode,
            preparedSystemPrompt,
            tools,
            reasoning,
            identity,
            key,
        };
    };
    const startPrewarm = (ctx, systemPrompt = ctx.getSystemPrompt(), prepared = false, messages = [], rewriteFinalRequest = false, force = false, kind = "ordinary", preserveContinuation = false, keepaliveStrategy, requestSource, generate = false) => {
        const plan = buildPrewarmPlan(ctx, systemPrompt, prepared, messages, rewriteFinalRequest, kind === "keepalive");
        if (!plan)
            return undefined;
        const { model, config, executionMode, preparedSystemPrompt, tools, reasoning, key: requestKey } = plan;
        const prewarmKey = JSON.stringify({ requestKey, preserveContinuation, generate });
        if (pendingPrewarmKey === prewarmKey)
            return prewarmPromise;
        if (!force && !pendingPrewarmKey && prewarmedKey === prewarmKey)
            return undefined;
        const previousTransportSettlement = prewarmTransportSettlement;
        prewarmedKey = undefined;
        prewarmController?.abort();
        const controller = new AbortController();
        prewarmController = controller;
        activePrewarmKind = kind;
        pendingPrewarmKey = prewarmKey;
        const promise = (async () => {
            if (previousTransportSettlement)
                await previousTransportSettlement.catch(() => undefined);
            if (controller.signal.aborted)
                return { status: "aborted" };
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (controller.signal.aborted)
                return { status: "aborted" };
            if (!auth.ok)
                return { status: "failed", error: new Error(auth.error) };
            if (!auth.apiKey)
                return {
                    status: "failed",
                    error: new Error(`No API key found for "${model.provider}"`),
                };
            const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
            try {
                const transportSettlement = prewarmOpenAICodexWebSocket(requestModel, { systemPrompt: preparedSystemPrompt, messages, tools }, {
                    apiKey: auth.apiKey,
                    ...(auth.headers ? { headers: auth.headers } : {}),
                    ...(auth.env ? { env: auth.env } : {}),
                    sessionId: ctx.sessionManager.getSessionId(),
                    signal: controller.signal,
                    ...reasoning,
                    textVerbosity: config.openai.verbosity,
                    ...(config.openai.fast ? { serviceTier: "priority" } : {}),
                    onPayload: (body) => rewriteFinalRequest
                        ? rewriteCodexProviderRequest(body, ctx, { ...state, config, executionMode })
                        : rewriteCodexPrewarmProviderRequest(body, ctx, { ...state, config, executionMode }),
                }, {
                    getConfig: () => ({ executionMode, openai: config.openai, compaction: config.compaction }),
                    useResponsesLite: (currentModel) => resolveCodexRuntimePlanForState({ model: currentModel }, { ...state, config, executionMode }).transport === "responses-lite",
                    turnState: state.codexTurnState,
                    getDiagnostics: () => diagnostics.sink(),
                    ...(preserveContinuation ? { preserveContinuation: true } : {}),
                    ...(kind === "keepalive" ? { retainSocket: config.openai.forceCachedWebSockets } : {}),
                    prewarmDiagnostics: {
                        kind,
                        ...(keepaliveStrategy ? { keepaliveStrategy } : {}),
                        ...(requestSource ? { requestSource } : {}),
                    },
                    ...(generate ? { generate: true } : {}),
                });
                prewarmTransportSettlement = transportSettlement;
                try {
                    const result = await transportSettlement;
                    if (controller.signal.aborted)
                        return { status: "aborted" };
                    if (!result)
                        return { status: "skipped" };
                    if (kind !== "keepalive")
                        prewarmedKey = prewarmKey;
                    return { status: "ready", ...(result.usage ? { usage: result.usage } : {}), socketReused: result.socketReused };
                }
                finally {
                    if (prewarmTransportSettlement === transportSettlement)
                        prewarmTransportSettlement = undefined;
                }
            }
            catch (error) {
                if (controller.signal.aborted)
                    return { status: "aborted" };
                const failure = error instanceof Error ? error : new Error(String(error));
                if (process.env["PI_DEBUG"] === "1") {
                    console.warn(`[pi-codex-conversion] WebSocket prewarm failed: ${failure.message}`);
                }
                return { status: "failed", error: failure };
            }
        })().finally(() => {
            if (prewarmPromise === promise) {
                prewarmPromise = undefined;
                if (pendingPrewarmKey === prewarmKey)
                    pendingPrewarmKey = undefined;
            }
            if (prewarmController === controller) {
                prewarmController = undefined;
                activePrewarmKind = undefined;
            }
        });
        prewarmPromise = promise;
        return promise;
    };
    const projectContextMessages = (ctx, messages) => {
        const plan = resolveCodexRuntimePlanForState(ctx, state);
        const branch = ctx.sessionManager.getBranch();
        const allEntries = plan.contextManagementMode === "tree" ? ctx.sessionManager.getEntries() : branch;
        const checkpointBranch = plan.contextManagementMode === "tree" && plan.contextManagementHybrid
            ? projectTreeCheckpointBranch(branch, allEntries) : branch;
        const projected = state.contextWindows.project(projectCodexReasoningHistory(checkpointBranch, projectTreeCheckpointMessages(branch, checkpointBranch, messages)), plan.contextManagementMode, branch, allEntries, plan.contextManagementHybrid);
        return projected.filter((message) => !isProviderContextExcludedMessage(message));
    };
    const currentMessages = (ctx) => {
        return convertToLlm(state.developerMessages.prepare(projectContextMessages(ctx), supportsCodexDeveloperMessages(ctx, state), ctx.model));
    };
    const currentContextPrewarm = (ctx, kind) => {
        const keepalivePlan = kind === "keepalive"
            ? resolveCodexCacheKeepalivePlan(ctx.model?.id, state.config.openai)
            : undefined;
        if (kind === "keepalive" && !keepalivePlan)
            return undefined;
        const preserveContinuation = kind === "keepalive";
        const activeSystemPrompt = state.activeProviderSystemPrompt;
        return startPrewarm(ctx, activeSystemPrompt ?? ctx.getSystemPrompt(), activeSystemPrompt !== undefined, currentMessages(ctx), true, kind === "keepalive", kind, preserveContinuation, keepalivePlan?.strategy, kind === "keepalive" ? "reconstructed" : undefined, keepalivePlan?.strategy === "generated-current");
    };
    const cancelCacheKeepalive = () => {
        cacheKeepaliveEpoch++;
        if (cacheKeepaliveTimer)
            clearTimeout(cacheKeepaliveTimer);
        cacheKeepaliveTimer = undefined;
        if (activePrewarmKind === "keepalive")
            prewarmController?.abort();
    };
    const scheduleCacheKeepalive = (ctx, epoch, plan, completedOperations) => {
        if (plan.maxOperations !== undefined && completedOperations >= plan.maxOperations)
            return;
        if (cacheKeepaliveTimer)
            clearTimeout(cacheKeepaliveTimer);
        diagnostics.sink()?.({
            type: "keepalive",
            phase: "armed",
            strategy: plan.strategy,
            intervalMs: plan.intervalMs,
        });
        cacheKeepaliveTimer = setTimeout(() => {
            cacheKeepaliveTimer = undefined;
            if (epoch !== cacheKeepaliveEpoch || !ctx.isIdle())
                return;
            const nextCompletedOperations = completedOperations + 1;
            const requestSource = "reconstructed";
            diagnostics.sink()?.({ type: "keepalive", phase: "started", strategy: plan.strategy, requestSource });
            const keepalive = currentContextPrewarm(ctx, "keepalive");
            if (!keepalive) {
                diagnostics.sink()?.({ type: "keepalive", phase: "skipped", strategy: plan.strategy, requestSource });
                return;
            }
            void keepalive.then((result) => {
                if (epoch !== cacheKeepaliveEpoch || result.status === "aborted" || result.status === "skipped")
                    return;
                if (result.status === "failed") {
                    ctx.ui.notify(`Codex cache keepalive failed: ${result.error.message}`, "warning");
                    scheduleCacheKeepalive(ctx, epoch, plan, nextCompletedOperations);
                    return;
                }
                const action = "generated-refresh";
                diagnostics.sink()?.({ type: "keepalive", phase: "applied", strategy: plan.strategy, requestSource, action });
                scheduleCacheKeepalive(ctx, epoch, plan, nextCompletedOperations);
            });
        }, plan.intervalMs);
        cacheKeepaliveTimer.unref?.();
    };
    const armCacheKeepalive = (ctx) => {
        cancelCacheKeepalive();
        const plan = resolveCodexCacheKeepalivePlan(ctx.model?.id, state.config.openai);
        if (plan)
            scheduleCacheKeepalive(ctx, cacheKeepaliveEpoch, plan, 0);
    };
    const runtime = {
        autoReasoning: createAutoReasoning(pi, state),
        state,
        tracker,
        sessions,
        backgroundWidget: { folded: true },
        voice,
        lanVoice: new CodexLanVoiceServerController(voice, () => state.config, (text, ctx) => {
            if (ctx.isIdle())
                pi.sendUserMessage(text);
            else
                pi.sendUserMessage(text, { deliverAs: "steer" });
        }, dirname(getCodexConversionConfigPath())),
        execEnv(_config = state.config) {
            return { ...process.env };
        },
        projectContextMessages,
        codexSystemPrompt(basePrompt, ctx, skills = state.promptSkills, systemPromptOptions) {
            const plan = resolveCodexRuntimePlanForState(ctx, state);
            return buildCodexSystemPrompt(basePrompt, {
                skills,
                shell: getPiCodexRuntimeShell(ctx),
                mode: plan.prompt ?? "normal",
                heavySystemPromptOverwrite: state.config.prompt.heavySystemPromptOverwrite,
                systemPromptOptions,
            });
        },
        startPrewarm(ctx, systemPrompt, prepared) {
            return startPrewarm(ctx, systemPrompt, prepared);
        },
        startCompactionPrewarm(ctx) {
            return currentContextPrewarm(ctx, "compaction");
        },
        startKeepalivePrewarm(ctx) {
            return currentContextPrewarm(ctx, "keepalive");
        },
        armCacheKeepalive(ctx) {
            armCacheKeepalive(ctx);
        },
        cancelCacheKeepalive() {
            cancelCacheKeepalive();
        },
        resetTransport(sessionId) {
            cancelCacheKeepalive();
            prewarmController?.abort();
            prewarmController = undefined;
            pendingPrewarmKey = undefined;
            prewarmedKey = undefined;
            state.codexTurnState.reset();
            if (sessionId) {
                resetOpenAICodexWebSocketSessions(sessionId);
                closeOpenAICodexKeepaliveWebSocketSession(sessionId);
            }
            else
                closeOpenAICodexWebSocketSessions();
        },
        resetTransportAfterCompaction(sessionId) {
            runtime.resetTransport(sessionId);
            closeOpenAICodexWebSocketSessions(sessionId);
        },
        shutdownTransport(sessionId) {
            cancelCacheKeepalive();
            runtime.resetTransport(sessionId);
            closeOpenAICodexWebSocketSessions(sessionId);
        },
        waitForPrewarm(ctx, systemPrompt) {
            return startPrewarm(ctx, systemPrompt, true, currentMessages(ctx), true);
        },
        prewarmIdentity(ctx, systemPrompt) {
            return buildPrewarmPlan(ctx, systemPrompt, true, [], false)?.identity;
        },
        configureDiagnostics(ctx, announceLog = false) {
            if (!cacheEnvironmentWarningsReported && cacheEnvironment.warnings.length > 0) {
                cacheEnvironmentWarningsReported = true;
                ctx.ui.notify(`Codex cache diagnostics: ${cacheEnvironment.warnings.join("; ")}`, "warning");
            }
            return diagnostics.configure({
                mode: state.config.openai.cacheDiagnostics,
                active: ctx.model?.provider === "openai-codex",
                ctx,
                agentDir: dirname(getCodexConversionConfigPath()),
                logName: cacheEnvironment.logName,
                announceLog: announceLog || cacheEnvironment.logName !== undefined,
            });
        },
        diagnosticsSink() {
            return diagnostics.sink();
        },
        shutdownDiagnostics() {
            return diagnostics.shutdown();
        },
    };
    return runtime;
}
