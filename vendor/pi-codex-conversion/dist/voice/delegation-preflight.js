import { isAdapterRuntime, resolveCodexRuntimePlanForState } from "../adapter/activation/runtime-plan.js";
import { CANCELLED, interruptible } from "./cancellation.js";
export async function prepareVoiceDelegation(runtime, codeMode, ctx, signal) {
    const { state } = runtime;
    const buildCurrent = () => {
        if (!isAdapterRuntime(resolveCodexRuntimePlanForState(ctx, state)))
            return undefined;
        const basePrompt = state.activeProviderSystemPrompt ?? ctx.getSystemPrompt();
        const promptOptions = state.config.prompt.heavySystemPromptOverwrite
            ? { cwd: ctx.cwd }
            : undefined;
        const systemPrompt = runtime.codexSystemPrompt(codeMode.refreshPromptTools(basePrompt, ctx), ctx, undefined, promptOptions);
        return {
            systemPrompt,
            prewarmIdentity: runtime.prewarmIdentity(ctx, systemPrompt),
        };
    };
    for (;;) {
        signal.throwIfAborted();
        const prepared = buildCurrent();
        if (!prepared) {
            state.voiceSystemPromptOverride = undefined;
            return undefined;
        }
        const prewarmOperation = runtime.waitForPrewarm(ctx, prepared.systemPrompt);
        const prewarm = prewarmOperation
            ? await interruptible(prewarmOperation, signal)
            : undefined;
        if (prewarm === CANCELLED) {
            signal.throwIfAborted();
            throw new Error("Voice delegation preflight was cancelled");
        }
        if (prewarm?.status === "aborted")
            continue;
        if (prewarm?.status === "failed")
            throw prewarm.error;
        const current = buildCurrent();
        if (!current ||
            current.systemPrompt !== prepared.systemPrompt ||
            current.prewarmIdentity !== prepared.prewarmIdentity)
            continue;
        let committed = false;
        let previous;
        return {
            commit() {
                const commit = buildCurrent();
                if (!commit ||
                    commit.systemPrompt !== prepared.systemPrompt ||
                    commit.prewarmIdentity !== prepared.prewarmIdentity)
                    return false;
                previous = {
                    activeProviderSystemPrompt: state.activeProviderSystemPrompt,
                    voiceSystemPromptOverride: state.voiceSystemPromptOverride,
                    pendingActiveProviderPromptCapture: state.pendingActiveProviderPromptCapture,
                };
                state.activeProviderSystemPrompt = prepared.systemPrompt;
                state.voiceSystemPromptOverride = prepared.systemPrompt;
                state.pendingActiveProviderPromptCapture = true;
                committed = true;
                return true;
            },
            rollback() {
                if (!committed || !previous)
                    return;
                if (state.activeProviderSystemPrompt === prepared.systemPrompt)
                    state.activeProviderSystemPrompt = previous.activeProviderSystemPrompt;
                if (state.voiceSystemPromptOverride === prepared.systemPrompt)
                    state.voiceSystemPromptOverride = previous.voiceSystemPromptOverride;
                if (state.pendingActiveProviderPromptCapture === true)
                    state.pendingActiveProviderPromptCapture = previous.pendingActiveProviderPromptCapture;
                committed = false;
            },
        };
    }
}
