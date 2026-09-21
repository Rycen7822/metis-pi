import {} from "@earendil-works/pi-ai";
import { resolveNativeCompactionRequestBudget, shrinkNativeCompactionRequestForEndpoint } from "./request-shrink.js";
import { canonicalCompactionOutput, normalizeRemoteCompactionV2PromptInput } from "./remote-v2-history.js";
import { withRemoteCompactionV2Feature } from "../../providers/openai-responses/compaction-v2-feature.js";
import { sleep } from "../../providers/openai-codex/sse.js";
import { isWebSocketSseFallbackActive } from "../../providers/openai-codex/websocket.js";
import { canonicalCompactionRequestBody } from "../../providers/openai-codex/session-continuity.js";
import { extractAccountId, resolveCodexWebSocketUrl } from "../../providers/openai-codex/headers.js";
import { toProviderTranscript } from "../../providers/transcript.js";
const MAX_STREAM_RETRIES = 2;
/**
 * Provider context for the compaction request. Only the prompt and the replayed history's own
 * top-level tools travel here: the history is the source of truth for both halves of the request.
 */
function nativeCompactionContext(options) {
    return {
        // Match the active provider lane so cached WebSocket compaction can send
        // only previous_response_id plus the trigger instead of the full history.
        systemPrompt: options.systemPrompt,
        messages: [],
        ...(options.history.tools.length > 0 ? { tools: [...options.history.tools] } : {}),
    };
}
function resolveStream(options) {
    if (options.runtime.codexTransport) {
        // The Codex API implementation is registered once under the stock
        // provider. The runtime model and credentials retain the alias scope.
        const registration = options.modelRegistry.getRegisteredProviderConfig("openai-codex");
        return registration?.api === "openai-codex-responses" && registration.streamSimple
            ? registration.streamSimple
            : options.modelRegistry.getRegisteredNativeProvider("openai-codex")?.streamSimple;
    }
    const configuredRegistration = options.modelRegistry.getRegisteredProviderConfig(options.runtime.provider);
    return options.runtime.api === "openai-responses"
        && configuredRegistration?.api === "openai-responses"
        && configuredRegistration.streamSimple
        ? configuredRegistration.streamSimple
        : undefined;
}
function isAborted(signal, message) {
    return signal?.aborted === true || /request was aborted|\baborted\b/i.test(message);
}
function shouldRetry(result) {
    if (result.status === 429)
        return false;
    return !/\b(?:401|403)\b|unauthori[sz]ed|forbidden|usage limit|quota|not included|invalid request|context window|unsupported parameter/i.test(result.errorMessage);
}
function compactionUsage(message, diagnostic) {
    const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    const cachedInputTokens = message.usage.cacheRead;
    const cacheWriteInputTokens = message.usage.cacheWrite;
    const outputTokens = message.usage.output;
    if (![inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens].every((value) => Number.isFinite(value) && value >= 0))
        return undefined;
    if (inputTokens + outputTokens === 0)
        return undefined;
    return { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, diagnostic: structuredClone(diagnostic) };
}
function diagnosticTransport(transport) {
    return transport === "websocket" || transport === "websocket-cached" ? "websocket" : "sse";
}
function canonicalSessionIdentity(options) {
    if (options.canonicalInput === undefined || !options.runtime.codexTransport || !options.runtime.apiKey)
        return undefined;
    return {
        url: resolveCodexWebSocketUrl(options.runtime.baseUrl),
        accountId: extractAccountId(options.runtime.apiKey),
    };
}
function withCurrentCompactionControls(canonicalBody, currentBody) {
    const { client_metadata: _canonicalMetadata, service_tier: _canonicalServiceTier, temperature: _canonicalTemperature, text: _canonicalText, ...historyBody } = canonicalBody;
    return {
        ...historyBody,
        text: structuredClone(currentBody.text),
        ...(currentBody.service_tier !== undefined ? { service_tier: currentBody.service_tier } : {}),
        ...(currentBody.temperature !== undefined ? { temperature: currentBody.temperature } : {}),
        ...(currentBody.client_metadata ? { client_metadata: structuredClone(currentBody.client_metadata) } : {}),
    };
}
async function runAttempt(options, streamSimple) {
    const outputItems = [];
    let responseStatus;
    const compactionDiagnostic = options.compactionDiagnostic ?? {
        inputSource: options.canonicalInput !== undefined ? "canonical" : "reconstructed",
        canonicalReplay: "not_applicable",
        checkpointReused: false,
    };
    if (!options.runtime.codexTransport) {
        compactionDiagnostic.transport = diagnosticTransport(options.transport);
    }
    const canonicalIdentity = canonicalSessionIdentity(options);
    const canonicalInput = options.canonicalInput;
    const canonicalBody = canonicalInput !== undefined && canonicalIdentity
        ? canonicalCompactionRequestBody(options.sessionId, options.runtime.model, canonicalIdentity)
        : undefined;
    const streamOptions = {
        ...(options.runtime.apiKey ? { apiKey: options.runtime.apiKey } : {}),
        headers: withRemoteCompactionV2Feature(options.runtime.headers),
        sessionId: options.sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.runtime.codexTransport ? { canonicalCompaction: true } : {}),
        compactionDiagnostics: compactionDiagnostic,
        maxRetries: options.runtime.codexTransport ? MAX_STREAM_RETRIES : 0,
        ...(typeof options.requestOptions.service_tier === "string" ? { serviceTier: options.requestOptions.service_tier } : {}),
        ...(options.requestOptions.text?.verbosity ? { textVerbosity: options.requestOptions.text.verbosity } : {}),
        onOutputItemDone: (item) => outputItems.push(item),
        onResponse: (response) => { responseStatus = response.status; },
        onPayload: async (payload) => {
            const body = payload;
            const requestBody = canonicalBody
                ? withCurrentCompactionControls(canonicalBody, body)
                : body;
            const promptInput = normalizeRemoteCompactionV2PromptInput(canonicalInput ?? options.history.input);
            const request = await shrinkNativeCompactionRequestForEndpoint({
                model: requestBody.model,
                input: promptInput,
                ...(typeof requestBody.instructions === "string" ? { instructions: requestBody.instructions } : {}),
            }, { budgetTokens: resolveNativeCompactionRequestBudget({
                    codexTransport: options.runtime.codexTransport,
                    model: options.runtime.model,
                    contextWindow: options.runtime.currentModel.contextWindow,
                }), tokensBefore: options.tokensBefore });
            compactionDiagnostic.rewrittenToolOutputs = request.rewrittenOutputs;
            const rewritten = {
                ...requestBody,
                input: [...request.request.input, { type: "compaction_trigger" }],
                ...(!canonicalBody && options.requestOptions.reasoning ? { reasoning: structuredClone(options.requestOptions.reasoning) } : {}),
            };
            return options.rewritePayload ? options.rewritePayload(rewritten) : rewritten;
        },
    };
    let completed;
    let completedNormally = false;
    for await (const rawEvent of streamSimple(options.runtime.currentModel, toProviderTranscript(nativeCompactionContext(options)), streamOptions)) {
        const event = rawEvent;
        if (event.type === "done") {
            completed = event.message;
            completedNormally = event.reason === "stop" && event.message?.stopReason === "stop";
        }
        if (event.type === "error") {
            const message = event.error?.errorMessage || "Responses compaction v2 stream failed";
            return {
                ok: false,
                reason: isAborted(options.signal, message) ? "aborted" : "stream-error",
                errorMessage: message,
                ...(responseStatus !== undefined ? { status: responseStatus } : {}),
            };
        }
    }
    if (!completed?.responseId || !completedNormally) {
        return { ok: false, reason: "stream-error", errorMessage: "Responses compaction v2 stream did not complete normally" };
    }
    const compactions = outputItems.map(canonicalCompactionOutput).filter((item) => item !== undefined);
    if (compactions.length !== 1) {
        return { ok: false, reason: "invalid-output", errorMessage: `Responses compaction v2 expected exactly one compaction output item, got ${compactions.length} from ${outputItems.length} output items` };
    }
    return { ok: true, compaction: compactions[0], responseId: completed.responseId, createdAt: new Date().toISOString(), usage: compactionUsage(completed, compactionDiagnostic) };
}
export async function executeRemoteCompactionV2(options) {
    const streamSimple = resolveStream(options);
    if (!streamSimple)
        return { ok: false, reason: "unavailable", errorMessage: "No compatible Responses stream is registered for this provider" };
    const initialTransport = options.runtime.codexTransport && isWebSocketSseFallbackActive(options.sessionId)
        ? "sse"
        : options.transport ?? (options.runtime.codexTransport ? "websocket-cached" : "sse");
    if (options.runtime.codexTransport) {
        return runAttempt({ ...options, transport: initialTransport }, streamSimple);
    }
    const transports = [initialTransport];
    const delayMs = Math.max(0, options.retryDelayMs ?? 500);
    let lastFailure;
    for (const transport of transports) {
        for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
            const result = await runAttempt({ ...options, transport }, streamSimple);
            if (result.ok)
                return result;
            if (result.reason === "aborted" || result.reason === "unavailable" || result.reason === "invalid-output" || !shouldRetry(result))
                return result;
            lastFailure = result;
            if (attempt < MAX_STREAM_RETRIES) {
                try {
                    await sleep(delayMs * 2 ** attempt, options.signal);
                }
                catch {
                    return { ok: false, reason: "aborted", errorMessage: "Request was aborted" };
                }
            }
        }
    }
    return lastFailure ?? { ok: false, reason: "stream-error", errorMessage: "Responses compaction v2 failed without a transport attempt" };
}
