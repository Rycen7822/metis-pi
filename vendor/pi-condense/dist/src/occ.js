import { createHash } from "node:crypto";
import { calculateContextTokens, compact, estimateTokens, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { archiveToolOutput } from "./spill.js";
import { isProtected } from "./protected.js";
import { captureBatch, captureUnindexedBatchesFromSession } from "./batch-capture.js";
import { ARGUMENT_HISTORY } from "./argument-history.js";
import { isDerived, retainSources } from "./occ-protection.js";
const STATE = "metis-occ-state";
const HOLD_WORK = 4;
const WAIT_WORK = 3;
const ENTER = 0.60, EXIT = 0.52, READY = 0.72;
const fresh = () => ({ phase: "normal", work: 0, atWork: 0, atChars: 0 });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** One owner for local/global rewrite decisions; plain custom entries never enter the prompt. */
export function registerOcc(pi, indexer, config) {
    let state = fresh();
    const spentRequests = new Set();
    const spent = () => state.spentRequest === state.request || (state.request !== undefined && spentRequests.has(state.request));
    let ready = false;
    let running = false;
    let cancelled = false;
    let sessionId;
    let boundaryTokens;
    let compactionSignal;
    let requestTokens;
    let localTokensSaved = 0;
    const enabled = () => config.value.enabled && config.value.opportunisticCompaction;
    const showStatus = (ctx, status) => {
        try {
            ctx.ui.setStatus("metis-occ", config.value.showOccStatusLine && status ? `OCC: ${status}` : undefined);
        }
        catch { /* UI teardown must not affect compaction or goal continuation. */ }
    };
    const persist = () => pi.appendEntry(STATE, { ...state });
    const projection = (ctx) => ctx.sessionManager.buildSessionProjection();
    const visible = (ctx) => {
        const projected = projection(ctx);
        const request = { sessionId: ctx.sessionManager.getSessionId(), messages: projected.messages, api: ctx.model?.api, maintenance: true };
        pi.events.emit("metis:condense-project", request);
        return { messages: request.messages, sources: projected.entries.filter(e => e.messages.length).map(e => e.sourceEntry.id) };
    };
    const signature = (ctx) => hash([
        ctx.sessionManager.getSessionId(), visible(ctx), ctx.model,
        projection(ctx).entries.filter(e => e.messages.length).map(e => [e.sourceEntry.id, e.messages]),
        ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "goal").at(-1),
    ]);
    const chars = (ctx) => JSON.stringify(visible(ctx).messages).length;
    const estimatedTokens = (messages) => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    function capacity(ctx, settings) {
        const window = ctx.model?.contextWindow;
        if (!window || !Number.isFinite(window) || window <= 0)
            return undefined;
        try {
            if (!settings) {
                // The extension API exposes no live SettingsManager. Use Pi's own
                // read-only resolver, including project trust and per-model overrides.
                const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted?.() ?? false });
                if (manager.drainErrors().length)
                    return undefined;
                settings = manager.getCompactionSettings(ctx.model);
            }
            return settings.enabled ? { limit: window - settings.reserveTokens, buffer: Math.max(1024, window * 0.05) } : undefined;
        }
        catch {
            return undefined;
        }
    }
    const capability = (ctx) => {
        const request = { ctx, supported: false };
        pi.events.emit("metis:occ-capability", request);
        return request.supported;
    };
    const rewrite = (ctx) => {
        if (!enabled())
            return;
        ready = false;
        state.phase = "hold";
        state.atWork = state.work;
        state.atChars = chars(ctx);
        persist();
    };
    // Identity is not authority: retain the latest accepted user entry ID even
    // after a split-turn compaction or context edit hides its visible contribution.
    const externalRequest = (ctx) => ctx.sessionManager.getBranch()
        .filter(e => e.type === "message" && e.message.role === "user").at(-1)?.id;
    function decide(ctx) {
        if (!enabled())
            return false;
        const size = chars(ctx);
        state.request = externalRequest(ctx);
        const usage = ctx.getContextUsage();
        const tokens = boundaryTokens ?? usage?.tokens;
        const budget = capacity(ctx);
        const capacityWaiting = budget && tokens != null && Number.isFinite(tokens)
            ? budget.limit - tokens <= budget.buffer * (state.capacityWaiting ? 1.5 : 1)
            : !!budget && !!state.capacityWaiting;
        if (capacityWaiting !== !!state.capacityWaiting) {
            state.capacityWaiting = capacityWaiting;
            if (state.phase === "waiting")
                state.phase = "normal";
            persist();
        }
        if (capacityWaiting) {
            ready = false;
            return true;
        }
        if (state.phase === "hold") {
            if (state.work - state.atWork < HOLD_WORK || size - state.atChars < Math.max(5000, state.atChars * 0.15))
                return true;
            state.phase = "normal";
        }
        const window = ctx.model?.contextWindow;
        const fraction = tokens != null && window && window > 0 ? tokens / window : undefined;
        if (fraction === undefined || !capability(ctx)) {
            ready = false;
            return false;
        }
        if (state.phase === "waiting" && fraction < EXIT) {
            state.phase = "normal";
            state.waitExhaustedRequest = state.request;
            ready = false;
            persist();
            return false;
        }
        if (state.phase === "normal" && fraction >= ENTER && !spent() && state.waitExhaustedRequest !== state.request) {
            state.phase = "waiting";
            state.atWork = state.work;
            persist();
        }
        // Occupancy alone does not justify economic OCC. Require known cached-input
        // prices and real tool-work observations; the candidate checks break-even.
        const cost = ctx.model?.cost;
        ready = state.phase === "waiting" && fraction >= READY && state.work - state.atWork >= 1
            && state.work >= HOLD_WORK && !spent()
            && !!cost && cost.input > 0 && cost.cacheRead > 0 && cost.output >= 0;
        if (state.phase === "waiting" && !ready && state.work - state.atWork >= WAIT_WORK) {
            state.phase = "normal";
            state.waitExhaustedRequest = state.request;
            persist();
        }
        return state.phase === "waiting";
    }
    const decision = (reason, details = {}) => {
        try {
            pi.appendEntry("metis-occ-decision", { reason, ...details });
        }
        catch { /* Observability never controls maintenance. */ }
    };
    async function prepare(event, ctx) {
        // This handler returns a cancellation on every failure: throwing would let
        // Pi's extension runner fall through to an unprotected default summary.
        compactionSignal = event.signal;
        let metrics = { trigger: running ? "occ" : event.reason };
        const reject = (reason) => { decision(reason, metrics); return { cancel: true }; };
        try {
            if (!capability(ctx) || !ctx.model)
                return reject("unsupported-or-busy");
            // A local publication can make the last provider usage stale. Keep its
            // measured system/tool overhead, credit only half the estimated history
            // reduction, and require headroom. Fresh requests discard this credit;
            // manual compaction and actual overflow never use it.
            if (event.reason === "threshold" && localTokensSaved > 0 && requestTokens !== undefined) {
                let usageValid = false;
                for (const entry of event.branchEntries) {
                    if (entry.type === "context_edit" || entry.type === "compaction")
                        usageValid = false;
                    else if (entry.type === "message" && entry.message.role === "assistant"
                        && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted"
                        && entry.message.usage && calculateContextTokens(entry.message.usage) > 0)
                        usageValid = true;
                }
                const saved = Math.min(localTokensSaved, Math.max(0, requestTokens - estimatedTokens(visible(ctx).messages)));
                const threshold = ctx.model.contextWindow - event.preparation.settings.reserveTokens;
                // Context edits may have already replaced usage with a fresh size
                // estimate. Do not subtract the same reduction from that estimate.
                if (usageValid && saved > 0 && event.preparation.tokensBefore - saved / 2
                    < threshold - Math.max(1024, ctx.model.contextWindow * 0.05))
                    return reject("stale-capacity-usage");
            }
            const source = signature(ctx);
            if (state.attemptedSource === source)
                return reject("same-source");
            const p = event.preparation;
            const projected = projection(ctx);
            const cut = projected.entries.findIndex(e => e.sourceEntry.id === p.firstKeptEntryId);
            if (cut < 1)
                return reject("no-safe-boundary");
            const discarded = projected.entries.slice(0, cut);
            const discardedMessages = discarded.flatMap(e => e.messages);
            // Never split a call/result group; a kept assistant or user begins a safe boundary.
            const kept = projected.entries.slice(cut).flatMap(e => e.messages);
            if (kept[0]?.role === "toolResult")
                return reject("split-tool-group");
            // Program-owned ordered source quotes. They are historical requirements;
            // later user corrections take precedence. Model text cannot edit them.
            const requirements = discarded.flatMap(e => e.messages.filter(m => m.role === "user")
                .map(m => ({ source: e.sourceEntry.id, content: m.content })));
            const request = { sessionId, messages: discardedMessages, api: ctx.model.api, busy: false, maintenance: true };
            pi.events.emit("metis:condense-project", request);
            if (request.busy)
                return reject("projection-busy");
            const goal = { snapshot: undefined };
            pi.events.emit("metis:goal-snapshot", goal);
            const obligations = captureUnindexedBatchesFromSession(discarded.flatMap(e => e.messages.map(message => ({ ...e.sourceEntry, type: "message", message }))), { isSummarized: () => false })
                .flatMap(batch => batch.toolCalls).filter(call => call.isError || call.toolName === "context_tree_query" || isProtected(call.toolName, call.args, config.value))
                .map((call) => {
                const recalled = call.toolName === "context_tree_query" && !call.isError && !config.value.protectedTools.includes(call.toolName);
                const key = call.resultTimestamp === undefined ? call.toolCallId : `${call.toolCallId}@${call.resultTimestamp}`;
                return { id: call.toolCallId, timestamp: call.resultTimestamp, tool: call.toolName, args: call.args, isError: call.isError,
                    ...(recalled ? { transient: true } : {}),
                    text: recalled ? `Historical recovery page archived. Read context_tree_query with toolCallIds=[${JSON.stringify(key)}].` : call.resultText };
            });
            const protectedSources = retainSources(discarded, request.messages, requirements, obligations, goal.snapshot);
            // Legacy manual chain projections are derived, including their preserved
            // outputs. Keep them verbatim once rather than feeding them to a model.
            for (const message of request.messages.filter(m => m.metisDerived?.kind === "condense-chain")) {
                protectedSources.legacy.push({ source: `chain:${message.metisDerived.blockId}`, content: message.content });
            }
            protectedSources.legacy = [...new Map(protectedSources.legacy.map(item => [item.source, item])).values()];
            for (const message of request.messages) {
                if (message.role !== "custom" || message.customType !== ARGUMENT_HISTORY)
                    continue;
                protectedSources.obligations.push({ id: message.details.sourceEntryIds[0], tool: "completed-interaction",
                    args: { sourceEntryIds: message.details.sourceEntryIds }, isError: false, text: message.content, transient: true });
            }
            const protection = JSON.stringify(protectedSources);
            const before = JSON.stringify(request.messages).length;
            // Protect old summaries verbatim; never ask the model to summarize a summary again.
            const modelMessages = request.messages.filter(m => !isDerived(m));
            const upperAfter = protection.length + 4 * p.settings.reserveTokens;
            metrics = { ...metrics, beforeChars: before, protectedChars: protection.length, estimatedAfterChars: upperAfter };
            if (upperAfter >= before * 0.75)
                return reject("protected-content-too-large");
            const budget = running ? capacity(ctx, p.settings) : undefined;
            const wholeTokens = estimatedTokens(visible(ctx).messages);
            // Pi carries the current system message (including tool schemas) across
            // compaction. Do not credit it as removed history even when it falls
            // before the cut; conservatively retain older system deltas as well.
            const removedTokens = estimatedTokens(request.messages.filter(m => m.role !== "system"));
            const retainedTokens = Math.max(p.tokensBefore, wholeTokens) - removedTokens;
            metrics.retainedTokens = retainedTokens;
            const fits = (summaryTokens) => !budget
                || budget.limit - (retainedTokens + summaryTokens + 128) >= 2 * budget.buffer;
            if (budget && (budget.limit - p.tokensBefore <= budget.buffer
                || !fits(Math.ceil(protection.length / 4) + p.settings.reserveTokens)))
                return reject("insufficient-capacity-headroom");
            if (running) {
                const cost = ctx.model.cost;
                const saved = (before - upperAfter) / 4;
                const summaryCost = before / 4 * cost.input + p.settings.reserveTokens * cost.output;
                const coldPrefixCost = (upperAfter + JSON.stringify(kept).length) / 4 * Math.max(0, cost.input - cost.cacheRead);
                // Eight future requests is a bounded estimate, not a promise of savings.
                if (8 * saved * cost.cacheRead <= 1.5 * (summaryCost + coldPrefixCost))
                    return reject("insufficient-estimated-savings");
            }
            // Persist the attempt before any provider await; failed attempts consume the
            // same request quota and enter hold rather than switching compressors.
            state.attemptedSource = source;
            state.spentRequest = state.request;
            if (state.request)
                spentRequests.add(state.request);
            rewrite(ctx);
            // Archive original source separately from the effective projection. Archive
            // records do not authorize pruning and cannot resurrect context edits.
            const records = [];
            for (const batch of captureUnindexedBatchesFromSession(ctx.sessionManager.getBranch(), { isSummarized: key => !!indexer.getRecord(key) })) {
                for (const call of batch.toolCalls) {
                    await archiveToolOutput(call, batch, { indexer, sessionDir: ctx.sessionManager.getSessionDir(),
                        sessionId: ctx.sessionManager.getSessionId(), appendEntry: (type, data) => pi.appendEntry(type, data) });
                    records.push({ ...call, turnIndex: batch.turnIndex, timestamp: batch.timestamp, archiveOnly: true });
                }
            }
            await indexer.backfillChainRecords(records, {
                spillThreshold: config.value.spillThreshold, spillPreviewBytes: config.value.spillPreviewBytes,
                sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId(),
                appendEntry: (type, data) => pi.appendEntry(type, data),
            });
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
            if (!auth.ok)
                return reject("authentication-unavailable");
            const model = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
            const result = await compact({ ...p, messagesToSummarize: modelMessages, turnPrefixMessages: [],
                isSplitTurn: false, previousSummary: undefined }, model, auth.apiKey, undefined, event.customInstructions, event.signal, undefined, (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o), auth.env, undefined, undefined, sessionId);
            metrics.usage = result.usage;
            if (event.signal.aborted || signature(ctx) !== source)
                return reject("cancelled-or-source-changed");
            const summary = `[Program-retained sources]\n${protection}\n[Derived summary; non-authoritative]\n${result.summary}`;
            metrics.afterChars = summary.length;
            if (!result.summary.trim() || summary.length >= before * 0.8)
                return reject("insufficient-actual-savings");
            if (!fits(Math.ceil(summary.length / 4)))
                return reject("insufficient-actual-headroom");
            decision("accepted", metrics);
            return { compaction: { ...result, summary, firstKeptEntryId: p.firstKeptEntryId,
                    details: { ...result.details, metisOcc: { source, requirements, protectedChars: protection.length, protection: protectedSources } } } };
        }
        catch (error) {
            try {
                ctx.ui.notify(`OCC kept original context: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
            catch { /* UI is optional. */ }
            return reject("preparation-failed");
        }
    }
    pi.on("session_start", (_event, ctx) => restore(ctx));
    pi.on("session_tree", (_event, ctx) => restore(ctx));
    function restore(ctx) {
        sessionId = ctx.sessionManager.getSessionId();
        const last = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === STATE).at(-1);
        spentRequests.clear();
        for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "custom" && entry.customType === STATE) {
                const request = entry.data?.spentRequest;
                if (typeof request === "string")
                    spentRequests.add(request);
            }
        }
        state = last?.type === "custom" ? { ...fresh(), ...last.data } : fresh();
        showStatus(ctx, state.lastOutcome);
        ready = running = cancelled = false;
        boundaryTokens = undefined;
        compactionSignal = undefined;
        requestTokens = undefined;
        localTokensSaved = 0;
    }
    pi.on("turn_end", (event, ctx) => {
        if (!enabled() || event.message.role !== "assistant" || event.message.stopReason === "error" || event.message.stopReason === "aborted" || !event.toolResults.length)
            return;
        const calls = captureBatch(event.message, event.toolResults, 0, 0).toolCalls.filter(call => !call.isError && !["context_tree_query", "write_stdin", "get_goal"].includes(call.toolName)
            && (call.toolName !== "exec_command" || call.exitCode === 0)
            && event.toolResults.some(result => result.toolCallId === call.toolCallId && result.isError === false));
        if (!calls.length)
            return;
        const key = hash(calls.map(call => [call.toolName, call.args, call.resultText, call.exitCode]));
        if (state.recentWork?.includes(key))
            return;
        state.lastWork = key;
        state.recentWork = [...(state.recentWork ?? []), key].slice(-16);
        state.work++;
        persist();
    });
    pi.on("before_agent_start", () => { boundaryTokens = undefined; });
    // An idle manual cancellation has no settled event to consume it. A new
    // accepted user input must not inherit that cancellation's goal decision.
    pi.on("input", () => { cancelled = false; });
    pi.on("model_select", (_event, ctx) => {
        state.capacityWaiting = false;
        boundaryTokens = undefined;
        requestTokens = undefined;
        localTokensSaved = 0;
        ready = false;
        rewrite(ctx);
    });
    pi.on("message_end", (event, ctx) => {
        if (!enabled() || event.message.role !== "assistant" || event.message.stopReason === "toolUse")
            return;
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
            ready = false;
            boundaryTokens = undefined;
            return;
        }
        const tokens = event.message.usage?.totalTokens;
        boundaryTokens = typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
        decide(ctx);
    });
    pi.on("session_compact", (_event, ctx) => {
        boundaryTokens = undefined;
        compactionSignal = undefined;
        requestTokens = undefined;
        localTokensSaved = 0;
        rewrite(ctx);
    });
    pi.on("session_compact_failed", (event, ctx) => {
        if (enabled()) {
            // Pi also reports extension safety rejections as aborted. Prefer the
            // actual signal, observed before checkpoint/capability checks. Before the
            // hook is reached, aborted means the host itself was cancelled.
            cancelled ||= compactionSignal ? compactionSignal.aborted : event.aborted;
            ready = false;
            boundaryTokens = undefined;
            state.spentRequest = externalRequest(ctx);
            if (state.spentRequest)
                spentRequests.add(state.spentRequest);
            rewrite(ctx);
        }
        compactionSignal = undefined;
    });
    pi.on("agent_settled", async (_event, ctx) => {
        if (running)
            return;
        if (!enabled() || !ready || !ctx.isIdle() || ctx.hasPendingMessages()) {
            pi.events.emit("metis:occ-finished", { cancelled });
            cancelled = false;
            return;
        }
        running = true;
        cancelled = false;
        ready = false;
        compactionSignal = undefined;
        let completed = false;
        try {
            showStatus(ctx, "compacting…");
            await new Promise(resolve => ctx.compact({ onComplete: () => { completed = true; resolve(); }, onError: () => resolve() }));
        }
        finally {
            state.lastOutcome = completed ? "compacted" : cancelled ? "cancelled" : "not compacted";
            showStatus(ctx, state.lastOutcome);
            state.spentRequest = state.request;
            if (state.request)
                spentRequests.add(state.request);
            rewrite(ctx);
            running = false;
            pi.events.emit("metis:occ-finished", { cancelled });
            cancelled = false;
        }
    });
    const off = [
        pi.events.on("metis:occ-compaction-start", (data) => { compactionSignal = data.signal; }),
        pi.events.on("metis:occ-status", (data) => {
            // Let native post-run capacity handling finish before issuing the owed
            // continuation. Settled immediately releases it when no compaction runs.
            data.deferGoal = ready || running || !!state.capacityWaiting;
            data.running = running;
        }),
        pi.events.on("metis:occ-prepare", (data) => {
            if (enabled())
                data.promise = prepare(data.event, data.ctx);
        }),
    ];
    pi.on("session_shutdown", (_event, ctx) => { showStatus(ctx); off.forEach(fn => fn()); sessionId = undefined; });
    return {
        enabled, deferLocal: decide, isRunning: () => running,
        isCapacityWaiting: () => !!state.capacityWaiting,
        refreshStatus(ctx) { showStatus(ctx, running ? "compacting…" : state.lastOutcome); },
        observeRequest(messages) {
            requestTokens = enabled() ? estimatedTokens(messages) : undefined;
            localTokensSaved = 0;
        },
        measure(ctx) { return enabled() ? estimatedTokens(visible(ctx).messages) : 0; },
        rewrite(ctx, before = 0) {
            if (enabled())
                localTokensSaved += Math.max(0, before - estimatedTokens(visible(ctx).messages));
            rewrite(ctx);
        },
    };
}
