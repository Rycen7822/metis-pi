import {} from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { findLatestNativeCompactionEntryIndex, resolveLatestNativeCompactionEntry } from "./details-store.js";
import { rewriteResponsesPayloadWithNativeReplay, resolveReplayedToolPlacement, serializeLiveTailToResponsesInput } from "../replay/payload-rewrite.js";
import { applyContextEdits, inspectCheckpointWindow } from "../replay/context-edits.js";
import { DEFAULT_SUPPORTED_PROVIDERS, isResponsesCompatiblePayload, resolveNativeCompactionEnvironment } from "./compaction-runtime.js";
import { serializeActiveSessionHistory, } from "./serializer.js";
import { createNativeCompactionDetails, createNativeCompactionShimResult, hasPortableNativeCompactionSummary, NATIVE_COMPACTION_SHIM_SUMMARY } from "../compaction/types.js";
import { isResponsesContext } from "../prompt/codex-model.js";
import { isCodeModeRuntime, resolveCodexRuntimePlanForState } from "../activation/runtime-plan.js";
import { executeRemoteCompactionV2 } from "./remote-v2-client.js";
import { buildRemoteCompactionV2Window } from "./remote-v2-history.js";
import { CODE_MODE_EXEC_GRAMMAR_INPUTS } from "../../tools/code-mode/exec-contract.js";
import { resolveCanonicalCompactionPromptInput } from "../../providers/openai-codex/session-continuity.js";
import { extractAccountId, resolveCodexWebSocketUrl } from "../../providers/openai-codex/headers.js";
import { prepareResponsesLiteConversationInput } from "../../providers/openai-codex/responses-lite.js";
import { runPortablePiCompaction } from "./portable-summary.js";
import { codexReasoningUpdates } from "../reasoning-updates.js";
import { projectCodexReasoningHistory } from "../reasoning-history.js";
import { rewriteContextNamespaceTools } from "../../context-management/namespace-tools.js";
import { projectTreeCheckpointBranch } from "../../context-management/tree-checkpoint.js";
function compactionBranch(ctx, state) {
    const branch = ctx.sessionManager.getBranch();
    const plan = resolveCodexRuntimePlanForState(ctx, state);
    return plan.contextManagementMode === "tree" && plan.contextManagementHybrid
        ? [...projectTreeCheckpointBranch(branch, ctx.sessionManager.getEntries())] : branch;
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function resolveOpaqueNativeCompactionFallbackEntry(branchEntries, runtime) {
    const latest = resolveLatestNativeCompactionEntry(branchEntries, runtime);
    if (!latest.ok || hasPortableNativeCompactionSummary(latest.entry))
        return undefined;
    return inspectCheckpointWindow({
        branchEntries,
        checkpoint: latest.entry,
        checkpointIndex: latest.index,
    }).ok ? latest.entry : undefined;
}
/** The window a checkpoint can hand to a summarization request, or undefined when it cannot be used. */
function buildNativeFallbackWindow(ctx, branchEntries, runtime) {
    const nativeEntry = resolveOpaqueNativeCompactionFallbackEntry(branchEntries, runtime);
    const window = cloneCompactedWindow(nativeEntry?.details?.compactedWindow ?? []);
    if (!window || window.length === 0)
        return undefined;
    return {
        window,
        provider: runtime.provider,
        api: runtime.api,
        baseUrl: runtime.baseUrl,
        sessionId: ctx.sessionManager.getSessionId(),
        sourceCompactionEntryId: nativeEntry?.id,
    };
}
function stashLatestNativeWindowForPiCompactionFallback(ctx, branchEntries, runtime, state) {
    state.pendingPiCompactionNativeWindow = buildNativeFallbackWindow(ctx, branchEntries, runtime);
    return state.pendingPiCompactionNativeWindow !== undefined;
}
function cloneCompactedWindow(window) {
    if (!window.every(isRecord))
        return undefined;
    return window.filter((item) => item["type"] !== "configuration_update").map((item) => structuredClone(item));
}
function buildCompactionReasoning(pi, ctx, state, compactionTargetModel) {
    const level = pi.getThinkingLevel();
    if (!compactionTargetModel.reasoning || level === "off")
        return undefined;
    const initialEffort = codexReasoningUpdates(projectCodexReasoningHistory(compactionBranch(ctx, state)), compactionTargetModel)[0]?.initialEffort;
    if (initialEffort)
        return { effort: initialEffort, summary: "auto" };
    const clampedLevel = clampThinkingLevel(compactionTargetModel, level);
    const rawEffort = compactionTargetModel.thinkingLevelMap?.[clampedLevel] ?? clampedLevel;
    const effort = typeof rawEffort === "string" && resolveCodexRuntimePlanForState(ctx, state).effectiveOpenAICodex
        ? clampCodexReasoningEffort(compactionTargetModel.id, rawEffort)
        : rawEffort;
    return effort === null ? undefined : { effort, summary: "auto" };
}
function clampCodexReasoningEffort(modelId, effort) {
    const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
    const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
    const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1], 10) : undefined;
    if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal")
        return "low";
    if (id === "gpt-5.1" && effort === "xhigh")
        return "high";
    if (id === "gpt-5.1-codex-mini")
        return effort === "high" || effort === "xhigh" ? "high" : "medium";
    return effort;
}
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function clampOpenAIPromptCacheKey(key) {
    const chars = Array.from(key);
    if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)
        return key;
    return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
function buildCompactionRequestOptions(pi, ctx, state, compactionTargetModel) {
    const reasoning = buildCompactionReasoning(pi, ctx, state, compactionTargetModel);
    return {
        parallel_tool_calls: true,
        prompt_cache_key: clampOpenAIPromptCacheKey(ctx.sessionManager.getSessionId()),
        ...(resolveCodexRuntimePlanForState(ctx, state).effectiveOpenAICodex && state.config.openai.fast ? { service_tier: "priority" } : {}),
        text: { verbosity: state.config.openai.verbosity },
        ...(reasoning ? { reasoning } : {}),
    };
}
function notifyNativeCompactionFallback(ctx, state, branchEntries, runtime, message) {
    const stashed = stashLatestNativeWindowForPiCompactionFallback(ctx, branchEntries, runtime, state);
    ctx.ui.notify(`${message}; Pi compaction will run.${stashed ? " Previous native compacted window will be included in Pi compaction fallback." : ""}`, "error");
}
function textFromResponsesContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((item) => isRecord(item) && item["type"] === "input_text" && typeof item["text"] === "string" ? item["text"] : "")
        .join("\n");
}
function isPiCompactionSummarizationPayload(payload) {
    const instructions = typeof payload.instructions === "string" ? payload.instructions : "";
    if (/compact|summar/i.test(instructions))
        return true;
    return payload.input.some((item) => {
        if (!isRecord(item))
            return false;
        const role = item["role"];
        const text = textFromResponsesContent(item["content"]);
        if ((role === "system" || role === "developer") && /compact|summar/i.test(text))
            return true;
        if (role === "user" && /<conversation>|previous compaction summary|summary/i.test(text))
            return true;
        return false;
    });
}
function getSupportedNativeCompactionProviders(state) {
    return [...new Set([...DEFAULT_SUPPORTED_PROVIDERS, ...state.config.scope.additionalProviders])];
}
export function buildNativeCompactionInput(args) {
    if (args.latestNativeCompaction.ok) {
        const checkpoint = args.latestNativeCompaction;
        // The boundary and the absorbed edits are one decision. Edits the checkpoint already
        // absorbed stay reusable; a later edit to a kept-window target cannot be written into the
        // opaque window, so that input is rebuilt from the effective context below.
        const window = inspectCheckpointWindow({
            branchEntries: args.branchEntries,
            checkpoint: checkpoint.entry,
            checkpointIndex: checkpoint.index,
        });
        if (!window.ok && window.reason === "first-kept-entry-not-found") {
            // Rebuilding would silently drop the encrypted history this checkpoint holds; the caller
            // cancels with this reason instead of sending a window it cannot place.
            return { ok: false, reason: window.reason };
        }
        if (window.ok) {
            const compactedWindow = cloneCompactedWindow(checkpoint.entry.details?.compactedWindow ?? []);
            if (!compactedWindow)
                return { ok: false, reason: "invalid-compacted-window" };
            const liveTailEntries = args.branchEntries.slice(checkpoint.index + 1);
            const editableTailEntries = applyContextEdits(liveTailEntries, window.edits);
            // The replayed transcript starts at the checkpoint's stored system message, so the request's
            // top-level tools and the tail's in-place additions both come from this one placement.
            const toolPlacement = resolveReplayedToolPlacement({
                model: args.model,
                checkpointSystemMessage: checkpoint.entry.systemMessage,
                entries: editableTailEntries,
            });
            return {
                ok: true,
                input: [
                    ...compactedWindow,
                    ...serializeLiveTailToResponsesInput({
                        model: args.model,
                        entries: editableTailEntries,
                        serializationOptions: { ...args.serializationOptions, toolPlacement },
                    }),
                ],
                compactedKeptWindow: false,
                tools: toolPlacement.immediate,
                checkpointReused: true,
            };
        }
    }
    // A fresh session and an invalidated checkpoint share the effective-history reconstruction:
    // the host's projection already applies context edits and keeps system/tool state in order.
    const history = serializeActiveSessionHistory({
        model: args.model,
        entries: args.allEntries,
        leafId: args.leafId,
        options: args.serializationOptions,
    });
    return {
        ok: true,
        input: history.input,
        compactedKeptWindow: true,
        tools: history.toolPlacement.immediate,
        checkpointReused: false,
    };
}
export async function resolveCanonicalCompactionReplay(args) {
    const reconstructedInput = args.codeMode
        ? await prepareResponsesLiteConversationInput(args.reconstructedInput)
        : args.reconstructedInput;
    return resolveCanonicalCompactionPromptInput(args.sessionId, args.model, args.identity, reconstructedInput);
}
export async function handleCodexSessionBeforeCompact(event, ctx, state, pi) {
    if (!resolveCodexRuntimePlanForState(ctx, state).nativeCompaction) {
        return undefined;
    }
    // Every attempt decides its own fallback window; a window stashed for an abandoned attempt must
    // not survive into this one.
    state.pendingPiCompactionNativeWindow = undefined;
    try {
        return await handleCodexSessionBeforeCompactInner(event, ctx, state, pi);
    }
    catch (error) {
        state.pendingPiCompactionNativeWindow = undefined;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`OpenAI native compaction failed unexpectedly: ${message}; Pi compaction was not run.`, "error");
        return { cancel: true };
    }
}
async function handleCodexSessionBeforeCompactInner(event, ctx, state, pi) {
    const plan = resolveCodexRuntimePlanForState(ctx, state);
    if (!plan.effectiveOpenAICodex && !isResponsesContext(ctx)) {
        ctx.ui.notify("OpenAI native compaction is enabled, but the current model is not Responses-compatible; Pi compaction was not run.", "error");
        return { cancel: true };
    }
    if (event.signal.aborted)
        return { cancel: true };
    const resolution = await resolveNativeCompactionEnvironment(ctx, { enabled: true, supportedProviders: getSupportedNativeCompactionProviders(state) });
    if (!resolution.ok) {
        if (resolution.reason === "unsupported-provider" || resolution.reason === "unsupported-api") {
            return undefined;
        }
        ctx.ui.notify(`OpenAI native compaction is enabled but unavailable (${resolution.reason}); Pi compaction was not run.`, "error");
        return { cancel: true };
    }
    const runtime = resolution.runtime;
    const compactionTargetModel = runtime.currentModel;
    if (plan.contextManagementRemote) {
        runtime.headers = { ...runtime.headers };
        state.contextWindows.rewriteHeaders(runtime.headers, ctx);
    }
    const codeMode = isCodeModeRuntime(plan);
    const serializationOptions = plan.transport === "responses-lite"
        ? { grammarToolInputProperties: CODE_MODE_EXEC_GRAMMAR_INPUTS }
        : undefined;
    const requestOptions = buildCompactionRequestOptions(pi, ctx, state, compactionTargetModel);
    const branchEntries = compactionBranch(ctx, state);
    const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
        provider: runtime.provider,
        api: runtime.api,
        baseUrl: runtime.baseUrl,
    });
    if (!latestNativeCompaction.ok
        && latestNativeCompaction.reason === "latest-native-compaction-mismatch"
        && !hasPortableNativeCompactionSummary(latestNativeCompaction.latestCompaction)) {
        ctx.ui.notify("OpenAI native compaction cannot reuse the latest checkpoint with this provider or endpoint; compaction was cancelled to preserve its encrypted history.", "error");
        return { cancel: true };
    }
    // The deterministic checkpoint judgment runs before any summary request. An unresolvable boundary
    // or an unclonable window cancels here, so neither the optional portable summary nor the native
    // attempt can put a request on the wire for a checkpoint the handler cannot reuse.
    const builtInput = buildNativeCompactionInput({
        model: compactionTargetModel,
        branchEntries,
        allEntries: branchEntries,
        leafId: ctx.sessionManager.getLeafId(),
        latestNativeCompaction,
        serializationOptions,
    });
    if (!builtInput.ok) {
        ctx.ui.notify(builtInput.reason === "first-kept-entry-not-found"
            ? "OpenAI native compaction cannot reuse the latest checkpoint: its first-kept boundary does not resolve on the active conversation; Pi compaction was not run."
            : "OpenAI native compaction could not clone the previous compacted window; Pi compaction was not run.", "error");
        return { cancel: true };
    }
    if (latestNativeCompaction.ok && !builtInput.checkpointReused) {
        ctx.ui.notify("A context edit recorded after the latest native checkpoint rewrites content inside its opaque window; native compaction rebuilds from the visible edited conversation and does not carry that window forward.", "warning");
    }
    let portableCompaction;
    if (state.config.compaction.portableSummary) {
        // The window only feeds this one request; keep it local instead of parking it in shared state.
        const portableWindow = buildNativeFallbackWindow(ctx, branchEntries, runtime);
        let portableWindowInjected = false;
        try {
            const result = await runPortablePiCompaction(event, {
                model: compactionTargetModel,
                thinkingLevel: ctx.thinkingLevel,
                apiKey: runtime.apiKey,
                headers: runtime.headers,
                env: runtime.env,
                onPayload: async (payload) => {
                    const injection = await injectNativeWindowIntoPiCompactionRequest(payload, ctx, state, portableWindow);
                    portableWindowInjected = injection.status === "injected";
                    return injection.status === "injected" ? injection.payload : payload;
                },
            });
            if (portableWindow && !portableWindowInjected) {
                throw new Error("the previous native checkpoint was not included in the summarization request");
            }
            portableCompaction = result;
        }
        catch (error) {
            if (event.signal.aborted)
                return { cancel: true };
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Portable Pi summary failed (${message}); native compaction will continue without it.`, "warning");
        }
    }
    const canonicalReplay = runtime.codexTransport && runtime.apiKey
        ? await resolveCanonicalCompactionReplay({
            codeMode,
            sessionId: ctx.sessionManager.getSessionId(),
            model: runtime.model,
            identity: {
                url: resolveCodexWebSocketUrl(runtime.baseUrl),
                accountId: extractAccountId(runtime.apiKey),
            },
            reconstructedInput: builtInput.input,
        })
        : { decision: "not_applicable" };
    const validatedCanonicalInput = canonicalReplay.input?.every(isRecord)
        ? canonicalReplay.input
        : undefined;
    const input = validatedCanonicalInput ?? builtInput.input;
    const { compactedKeptWindow } = builtInput;
    const compactionDiagnostic = {
        model: runtime.model,
        inputSource: validatedCanonicalInput ? "canonical" : "reconstructed",
        canonicalReplay: canonicalReplay.decision,
        checkpointReused: builtInput.checkpointReused,
        ...(latestNativeCompaction.ok && latestNativeCompaction.entry.details?.model
            ? { checkpointModel: latestNativeCompaction.entry.details.model }
            : {}),
    };
    if (input.length === 0) {
        ctx.ui.notify("OpenAI native compaction had no serializable conversation items; Pi compaction was not run.", "error");
        return { cancel: true };
    }
    if (event.customInstructions?.trim()) {
        ctx.ui.notify(portableCompaction
            ? "Responses compaction v2 ignores custom /compact guidance; the portable Pi summary still uses it."
            : "Responses compaction v2 uses the active session instructions and ignores custom /compact guidance.", "warning");
    }
    const compactResult = await executeRemoteCompactionV2({
        runtime,
        modelRegistry: ctx.modelRegistry,
        // The replayed transcript and its top-level tools travel together: the request must not
        // declare tools from a different context than the history it replays.
        history: builtInput,
        systemPrompt: state.activeProviderSystemPrompt ?? ctx.getSystemPrompt(),
        ...(validatedCanonicalInput ? { canonicalInput: validatedCanonicalInput } : {}),
        compactionDiagnostic,
        requestOptions,
        ...(plan.contextManagement ? {
            rewritePayload: (payload) => {
                const rewritten = plan.contextManagementRemote || !plan.codexTransport
                    ? rewriteContextNamespaceTools(payload, { encrypted: plan.contextManagementRemote }) : payload;
                return plan.contextManagementRemote ? state.contextWindows.rewritePayload(rewritten, ctx) : rewritten;
            },
        } : {}),
        tokensBefore: event.preparation.tokensBefore,
        sessionId: ctx.sessionManager.getSessionId(),
        signal: event.signal,
    });
    if (!compactResult.ok) {
        if (compactResult.reason === "aborted")
            return { cancel: true };
        const message = `Responses compaction v2 failed (${compactResult.reason}): ${compactResult.errorMessage}`;
        if (portableCompaction) {
            ctx.ui.notify(`${message}; the saved portable Pi summary will be used.`, "error");
            return { compaction: portableCompaction };
        }
        notifyNativeCompactionFallback(ctx, state, branchEntries, runtime, message);
        return undefined;
    }
    const compactedWindow = buildRemoteCompactionV2Window(input, compactResult.compaction, state.config.compaction.v2UserMessageRetention * 1_000);
    try {
        const details = createNativeCompactionDetails({
            provider: runtime.provider,
            api: runtime.api,
            model: runtime.model,
            baseUrl: runtime.baseUrl,
            compactedWindow,
            compactResponseId: compactResult.responseId,
            createdAt: compactResult.createdAt,
            usage: compactResult.usage,
            requestMeta: { tokensBefore: event.preparation.tokensBefore, previousSummaryPresent: Boolean(event.preparation.previousSummary), compactedKeptWindow },
        });
        return {
            compaction: createNativeCompactionShimResult({
                summary: portableCompaction?.summary ?? NATIVE_COMPACTION_SHIM_SUMMARY,
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
                details,
                usage: portableCompaction?.usage,
            }),
        };
    }
    catch {
        if (portableCompaction) {
            ctx.ui.notify("Responses compaction v2 produced details Pi could not store; the saved portable Pi summary will be used.", "error");
            return { compaction: portableCompaction };
        }
        notifyNativeCompactionFallback(ctx, state, branchEntries, runtime, "Responses compaction v2 produced details Pi could not store");
        return undefined;
    }
}
export async function rewriteCodexCompactedProviderRequest(payload, ctx, state) {
    const plan = resolveCodexRuntimePlanForState(ctx, state);
    if (!plan.nativeCompaction || (!plan.effectiveOpenAICodex && !isResponsesContext(ctx)))
        return undefined;
    const resolution = await resolveNativeCompactionEnvironment(ctx, { enabled: true, supportedProviders: getSupportedNativeCompactionProviders(state) }, payload);
    if (!resolution.ok)
        return undefined;
    const runtime = resolution.runtime;
    const branchEntries = compactionBranch(ctx, state);
    const latestNativeCompactionIndex = findLatestNativeCompactionEntryIndex(branchEntries, {
        provider: runtime.provider,
        api: runtime.api,
        baseUrl: runtime.baseUrl,
    });
    if (latestNativeCompactionIndex === undefined)
        return undefined;
    if (!runtime.payload)
        return undefined;
    const compactionEntry = branchEntries[latestNativeCompactionIndex];
    const rewrite = rewriteResponsesPayloadWithNativeReplay({
        model: runtime.currentModel,
        payload: runtime.payload,
        branchEntries,
        compactionEntry,
        serializationOptions: plan.transport === "responses-lite"
            ? { grammarToolInputProperties: CODE_MODE_EXEC_GRAMMAR_INPUTS }
            : undefined,
    });
    if (rewrite.ok)
        return rewrite.rewrittenPayload;
    if (rewrite.reason === "context-edit-targets-compacted-content") {
        const message = "A context edit recorded after the previous native checkpoint rewrites kept content that its opaque window already absorbed; the request was not sent with the replaced content. Run /compact to rebuild the checkpoint from the edited conversation.";
        ctx.ui.notify(message, "error");
        throw new Error(message);
    }
    const detail = rewrite.parity?.mismatches.slice(0, 3).join("; ");
    const message = `OpenAI native compaction replay failed (${rewrite.reason})${detail ? `: ${detail}` : ""}; request was not sent with placeholder compaction context.`;
    ctx.ui.notify(message, "error");
    throw new Error(message);
}
/**
 * Insert a previously selected opaque window into a Pi summarization request. The caller owns the
 * window's lifetime: it passes the snapshot it wants injected and clears its own state from the
 * returned status. A window selected before an awaited summary started is re-resolved here, so
 * edits or a newer checkpoint that appeared meanwhile cannot leak stale content into the request.
 */
export async function injectNativeWindowIntoPiCompactionRequest(payload, ctx, state, window) {
    if (!window || window.window.length === 0)
        return { status: "not-applicable" };
    if (!isResponsesCompatiblePayload(payload))
        return { status: "not-applicable" };
    if (window.sessionId !== ctx.sessionManager.getSessionId())
        return { status: "rejected", reason: "session-mismatch" };
    if (!isPiCompactionSummarizationPayload(payload))
        return { status: "not-applicable" };
    const resolution = await resolveNativeCompactionEnvironment(ctx, { enabled: true, supportedProviders: getSupportedNativeCompactionProviders(state) }, payload);
    if (!resolution.ok)
        return { status: "not-applicable" };
    const runtime = resolution.runtime;
    if (window.provider !== runtime.provider || window.api !== runtime.api || window.baseUrl !== runtime.baseUrl) {
        return { status: "rejected", reason: "endpoint-mismatch" };
    }
    const currentFallback = resolveOpaqueNativeCompactionFallbackEntry(compactionBranch(ctx, state), {
        provider: runtime.provider,
        api: runtime.api,
        baseUrl: runtime.baseUrl,
    });
    if (!currentFallback || currentFallback.id !== window.sourceCompactionEntryId) {
        return { status: "rejected", reason: "source-checkpoint-invalid" };
    }
    const input = [...payload.input];
    let insertAt = 0;
    while (insertAt < input.length) {
        const item = input[insertAt];
        if (!isRecord(item) || (item["role"] !== "system" && item["role"] !== "developer"))
            break;
        insertAt++;
    }
    return {
        status: "injected",
        payload: {
            ...payload,
            input: [
                ...input.slice(0, insertAt),
                ...window.window.map((item) => structuredClone(item)),
                ...input.slice(insertAt),
            ],
        },
    };
}
