import { formatSeconds } from "./media-errors.ts";
import { runWithProxy } from "./proxy-transport.ts";
// Maintained by metis-pi. Upstream: https://github.com/nicobailon/pi-web-access
// Source version: 0.38.0; commit: 7e6e2386dc9a31d5e2a448172060dd1339c604f7
// Local changes retain OpenAI / OpenAI Codex provider compatibility. See METIS.md.

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import type { ExtractedContent } from "./content.ts";
import { normalizeFetchContentParams } from "./fetch-params.ts";
import { answerFromPage } from "./page-query.ts";
import { rewriteSearchQuery } from "./query-rewrite.ts";
import { clearCloneCache, releaseClonesUnusedSince, touchClones } from "./github-extract.ts";
import { ALL_SEARCH_PROVIDERS, providerLabel, RESOLVED_SEARCH_PROVIDERS, type ProviderAvailability, type SearchProvider, type SearchProviderSelection, type ResolvedSearchProvider } from "./search-providers.ts";
import { getAllowedSearchProviders, search } from "./search-router.ts";
export type { ProviderAvailability } from "./search-providers.ts";
import type { QueryResultData } from "./search-types.ts";
import {
	generateId,
	holdResults,
	loadSessionResults,
	releaseResults,
	storeFetchedContentResult,
	type StoredSearchData,
} from "./storage.ts";
import { activityMonitor, type ActivityEntry } from "./activity.ts";
import { startCuratorServer, type CuratorServerHandle, type IndexedCuratorSearchEntry } from "./curator-server.ts";
import {
	generateSummaryDraft,
	loadSummaryModelChoices,
	type SummaryGenerationContext,
	type SummaryMeta,
} from "./summary-review.ts";
import { randomUUID } from "node:crypto";
import { parseStringifiedArrays } from "./tool-arguments.ts";
import { buildSearchErrorPlan, type SearchErrorDetails, type SearchErrorPlan } from "./render-search-error.ts";
import { registerCuratorRunLifecycle } from "./curator-run.ts";
import { registerWebToolActivation } from "./tool-activation.ts";
import { registerWebSearchCommand, registerCuratorCommand, registerGoogleAccountCommand, registerStoredSearchCommand } from "./tool-commands.ts";
import { openCuratorBrowserWindow, shouldAutoOpenCuratorBrowser, type GlimpseWindow } from "./curator-browser.ts";
import { buildCuratedSearchOptions, extractDomain, curatorResultIndex, curatorResultIndexCapacity, toCuratorSearchEntries, indexedCuratorEntryToQueryResult, generateCuratorSummary, getSummaryGenerationDeadlineMs, getSummaryInstructions, loadCuratorBootstrap, orderedCuratorResults, resolveCuratorSearchProvider, saveDefaultSearchProvider } from "./curator-workflow.ts";
export { getSummaryGenerationDeadlineMs, getSummaryInstructions, resolveCuratorDefaultProvider } from "./curator-workflow.ts";
import {
	createWebToolCore,
	DEFAULT_TOOL_NAMES,
	expandQueryString,
	fetchAllContent,
	fetchUncoveredContent,
	getMaxInlineContentChars,
	isToolEnabled,
	loadConfig,
	markToolError,
	normalizeProviderInput,
	normalizeQueryList,
	normalizeRecencyFilter,
	registeredFetchToolNames,
	resolveFetchModeConfig,
	resolveRequestedProvider,
	runSearchQueries,
	storedContentSourceNames,
	stripThumbnails,
	toCuratorProvider,
	WEB_SEARCH_CONFIG_PATH,
	withRegisteredFetchOptions,
	type FetchedContentData,
	type FetchMode,
	type SummaryWorkflow,
	type ToolNames,
	type WebSearchCallOptions,
	type WebSearchConfig,
} from "./web-tool-core.ts";

// Match pi-ai's StringEnum without loading its compat barrel during registration.
function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

type ExtensionTheme = ExtensionContext["ui"]["theme"];

// structuredContent shapes that codemode scripts receive (web-tool-contract.ts),
// on success and on isError results.
const nullableString = (description: string) => Type.Union([Type.String(), Type.Null()], { description });
const webSearchOutputSchema = Type.Object({
	responseId: Type.String({ description: "Id of the stored search results" }),
	fetchId: nullableString("Stored page content id when includeContent fetched or started fetching content, else null"),
	queries: Type.Array(Type.Object({
		query: Type.String(),
		answer: Type.String({ description: "Provider answer text, empty when the provider returned only results" }),
		error: nullableString("Why this query failed, null on success"),
		provider: Type.Optional(Type.String()),
		providers: Type.Optional(Type.Array(Type.String())),
		results: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String() })),
	})),
});
const fetchContentOutputSchema = Type.Object({
	responseId: nullableString("Id of the stored content, null when nothing was stored"),
	urls: Type.Array(Type.Object({
		url: Type.String(),
		title: Type.String(),
		content: Type.String({ description: "Full extracted content, not limited by the inline character cap" }),
		error: nullableString("Why this URL failed, null on success"),
		mimeType: Type.Optional(Type.String()),
		status: Type.Optional(Type.Number()),
		duration: Type.Optional(Type.Number()),
	})),
});

/** Shared collapsed/expanded renderer for an error/cancel plan produced by
 * buildSearchErrorPlan(). Used by every tool renderResult's error branch so
 * Ctrl+O (app.tools.expand) reveals diagnostics instead of a dead-end single line. */
function renderSearchErrorPlan(plan: SearchErrorPlan, expanded: boolean, theme: ExtensionTheme) {
	if (expanded) {
		return new Text(plan.expanded.map((l, i) => i === 0 ? theme.fg("error", l) : theme.fg("toolOutput", l)).join("\n"), 0, 0);
	}
	const box = new Box(1, 0, (t) => theme.bg("toolErrorBg", t));
	box.addChild(new Text(theme.fg("error", plan.expanded[0]), 0, 0));
	for (const line of plan.collapsed) {
		box.addChild(new Text(theme.fg("dim", line), 0, 0));
	}
	if (plan.expandHint) {
		box.addChild(new Text(theme.fg("muted", plan.expandHint), 0, 0));
	}
	return box;
}

type CuratorWorkflow = "summary-review";
export type CuratorProvider = SearchProvider;

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_SHORTCUTS = { curate: "ctrl+shift+s", activity: "ctrl+shift+w" } satisfies Record<string, KeyId>;
const FETCH_MODE_DESCRIPTIONS: Record<FetchMode, string> = {
	readable: "extract readable content as markdown",
	raw: "return the exact textual body using direct HTTP only",
	answer: "answer a prompt using only fetched content",
};

function searchProviderSchema(description: string, allowedProviders: readonly ResolvedSearchProvider[]) {
	return Type.Union([
		StringEnum(["auto", "all", ...allowedProviders]),
		Type.Array(StringEnum([...allowedProviders]), { minItems: 1 }),
	], { description });
}

function isCommandEnabled(config: WebSearchConfig, name: "websearch" | "curator" | "search" | "google-account"): boolean {
	return config.commands?.[name]?.enabled !== false;
}

function resolveToolNames(config: WebSearchConfig): ToolNames {
	if (config.toolNames !== undefined && (!config.toolNames || typeof config.toolNames !== "object" || Array.isArray(config.toolNames))) {
		throw new Error(`toolNames in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const names = { ...DEFAULT_TOOL_NAMES };
	for (const key of Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>) {
		const value = config.toolNames?.[key];
		if (value === undefined) continue;
		if (typeof value !== "string") throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must be a string`);
		const trimmed = value.trim();
		if (!TOOL_NAME_PATTERN.test(trimmed)) {
			throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
		}
		names[key] = trimmed;
	}
	const registeredKeys = (Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>)
		.filter(key => isToolEnabled(config, key));
	const seen = new Map<string, keyof ToolNames>();
	for (const key of registeredKeys) {
		const name = names[key];
		if (name === "web_enable") throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} uses reserved loader name web_enable`);
		const previous = seen.get(name);
		if (previous) throw new Error(`toolNames.${key} duplicates toolNames.${previous} in ${WEB_SEARCH_CONFIG_PATH}`);
		seen.set(name, key);
	}
	return names;
}

function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-web-access] ${message}`);
		return {};
	}
}

interface PendingCurate {
	phase: "searching" | "curating";
	workflow: CuratorWorkflow;
	summaryContext: SummaryGenerationContext;
	searchResults: Map<number, QueryResultData>;
	resultSlots: Map<number, number>;
	allInlineContent: ExtractedContent[];
	queryList: string[];
	includeContent: boolean;
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	category?: string;
	availableProviders: ProviderAvailability;
	defaultProvider: SearchProvider;
	searchProvider: SearchProviderSelection;
	summaryModels: Array<{ value: string; label: string }>;
	defaultSummaryModel: string | null;
	timeoutSeconds: number;
	proxy?: string;
	curatorUrl?: string;
	onUpdate: ((update: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }) => void) | undefined;
	signal: AbortSignal | undefined;
	abortSearches: () => void;
	finish: (value: AgentToolResult<Record<string, unknown>>) => void;
	cancel: (reason?: "user" | "stale") => void;
	browserPromise?: Promise<void>;
	browserOpenError?: string;
}

function updateWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines: string[] = [];

	lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));

	if (entries.length === 0) {
		lines.push(theme.fg("muted", "  No activity yet"));
	} else {
		for (const e of entries) {
			lines.push("  " + formatEntryLine(e, theme));
		}
	}

	lines.push(theme.fg("accent", "─".repeat(60)));

	const rateInfo = activityMonitor.getRateLimitInfo();
	const resetMs = rateInfo.oldestTimestamp ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now()) : 0;
	const resetSec = Math.ceil(resetMs / 1000);
	lines.push(
		theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) +
			(resetMs > 0 ? theme.fg("dim", ` (resets in ${resetSec}s)`) : ""),
	);

	ctx.ui.setWidget("web-activity", lines);
}

function formatEntryLine(
	entry: ActivityEntry,
	theme: ExtensionTheme,
): string {
	const typeStr = entry.type === "api" ? "API" : "GET";
	const target =
		entry.type === "api"
			? `"${truncateToWidth(entry.query || "", 28, "")}"`
			: truncateToWidth(entry.url?.replace(/^https?:\/\//, "") || "", 30, "");

	const duration = entry.endTime
		? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
		: `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

	let statusStr: string;
	let indicator: string;
	if (entry.error) {
		statusStr = "err";
		indicator = theme.fg("error", "✗");
	} else if (entry.status === null) {
		statusStr = "...";
		indicator = theme.fg("warning", "⋯");
	} else if (entry.status === 0) {
		statusStr = "abort";
		indicator = theme.fg("muted", "○");
	} else {
		statusStr = String(entry.status);
		indicator = entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	}

	return `${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}

/** Extension instances with a live session, and when that session started. A host may run
 * several at once (one instance per session); clones are removed outright only when none
 * remains, and otherwise once no live session can have been given their paths. */
const liveInstances = new Map<object, number>();

export default function (pi: ExtensionAPI, options: {
	registerTool?: <T extends TSchema, D = unknown>(action: string, tool: ToolDefinition<T, D>) => void;
	toolName?: string;
	formatStoredContentCall?: (args: string) => string;
} = {}) {
	let widgetVisible = false;
	let widgetUnsubscribe: (() => void) | null = null;
	const pendingCurates = new Map<string, PendingCurate>();
	const activeCurators = new Map<string, CuratorServerHandle>();
	const glimpseWins = new Map<string, GlimpseWindow>();

	function closeCurator(callId?: string): void {
		if (callId !== undefined) {
			const win = glimpseWins.get(callId);
			glimpseWins.delete(callId);
			try { win?.close(); } catch {}
			pendingCurates.get(callId)?.cancel("stale");
			pendingCurates.delete(callId);
			const curator = activeCurators.get(callId);
			activeCurators.delete(callId);
			try { curator?.close(); } catch {}
			return;
		}

		for (const win of glimpseWins.values()) {
			try { win.close(); } catch {}
		}
		glimpseWins.clear();
		for (const pc of pendingCurates.values()) {
			try { pc.cancel("stale"); } catch {}
		}
		pendingCurates.clear();
		for (const curator of activeCurators.values()) {
			try { curator.close(); } catch {}
		}
		activeCurators.clear();
	}

	function refreshUi(ctx: ExtensionContext): void {
		// Unsubscribe before clear() to avoid callback with stale ctx
		widgetUnsubscribe?.();
		widgetUnsubscribe = null;
		if (liveInstances.size <= 1) activityMonitor.clear();
		if (widgetVisible) {
			// Re-subscribe with new ctx
			widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
			updateWidget(ctx);
		}
	}

	const initConfig = loadConfigForExtensionInit();
	const registerTool = <T extends TSchema, D = unknown>(action: string, tool: ToolDefinition<T, D>) => {
		if (options.registerTool) options.registerTool(action, tool);
		else pi.registerTool(tool);
	};
	const fetchModeConfig = resolveFetchModeConfig(initConfig);
	const toolActivation = options.registerTool ? "eager" : initConfig.toolActivation ?? "auto";
	if (toolActivation !== "auto" && toolActivation !== "dynamic" && toolActivation !== "eager") {
		throw new Error(`toolActivation in ${WEB_SEARCH_CONFIG_PATH} must be "auto", "dynamic", or "eager"`);
	}
	const allowedSearchProviders = initConfig.webSearch?.allowedProviders === undefined ? RESOLVED_SEARCH_PROVIDERS : getAllowedSearchProviders();
	const allEligibleProviders = allowedSearchProviders.filter(provider => ALL_SEARCH_PROVIDERS.includes(provider));
	const allExcludedProviders = allowedSearchProviders.filter(provider => !ALL_SEARCH_PROVIDERS.includes(provider));
	const allPolicyDescription = allEligibleProviders.length === 0
		? `all has no eligible allowed providers; explicit-only allowed providers (${allExcludedProviders.map(providerLabel).join(", ")}) remain excluded`
		: allExcludedProviders.length > 0
		? `all searches eligible allowed providers (${allEligibleProviders.map(providerLabel).join(", ")}); explicit-only allowed providers (${allExcludedProviders.map(providerLabel).join(", ")}) remain excluded`
		: `all searches every eligible allowed provider (${allEligibleProviders.map(providerLabel).join(", ")})`;
	const curatorRunState = registerCuratorRunLifecycle(pi);
	const toolNames = resolveToolNames(initConfig);
	const webSearchEnabled = isToolEnabled(initConfig, "webSearch");
	const sourceCheckEnabled = isToolEnabled(initConfig, "sourceCheck");
	const fetchContentEnabled = isToolEnabled(initConfig, "fetchContent");
	const getSearchContentEnabled = isToolEnabled(initConfig, "getSearchContent");
	const coreSettings = {
		toolNames: options.toolName ? {
			webSearch: `${options.toolName} action=search`, sourceCheck: `${options.toolName} action=source_check`,
			fetchContent: `${options.toolName} action=fetch`, getSearchContent: `${options.toolName} action=content`,
		} : toolNames,
		enabledTools: {
			webSearch: webSearchEnabled,
			sourceCheck: sourceCheckEnabled,
			fetchContent: fetchContentEnabled,
			getSearchContent: getSearchContentEnabled,
		},
		maxInlineContentChars: getMaxInlineContentChars(initConfig),
		fetchModes: fetchModeConfig,
	};
	// Names as registered this session, so fetch failure guidance never points
	// at tools that are disabled or were renamed after init.
	const registeredToolNames = registeredFetchToolNames(coreSettings);
	const storedContentSources = storedContentSourceNames(coreSettings);
	const searchQueryDescription = webSearchEnabled
		? `Get content for this query (${coreSettings.toolNames.webSearch})`
		: "Get content for a stored search query";
	const fetchContentStorageNote = getSearchContentEnabled
		? `Full original content is stored for retrieval with ${coreSettings.toolNames.getSearchContent}.`
		: "Full original content is stored internally, but the retrieval tool is not registered.";
	const fetchModeDescription = fetchModeConfig.allowedModes
		.map(mode => `${mode}${mode === fetchModeConfig.defaultMode ? " (default)" : ""}: ${FETCH_MODE_DESCRIPTIONS[mode]}`)
		.join("; ");
	const curateKey = initConfig.shortcuts?.curate || DEFAULT_SHORTCUTS.curate;
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;

	// Session state is this instance's. Pi runs one instance and switches its session; a host
	// that serves several sessions at once runs one instance per session, and one session
	// starting or ending must not clear another's results or abort its fetches.
	const instance = {};
	const pendingFetches = new Map<string, AbortController>();
	let sessionActive = false;
	let sessionGeneration = 0;
	/** Ids of the results this instance's session holds in memory. */
	const ownedResults = new Set<string>();

	function abortPendingFetches(): void {
		for (const controller of pendingFetches.values()) {
			controller.abort();
		}
		pendingFetches.clear();
	}

	function own(id: string): void {
		if (ownedResults.has(id)) return;
		ownedResults.add(id);
		holdResults([id]);
	}

	function publish(data: StoredSearchData): void {
		own(data.id);
		pi.appendEntry("web-search-results", data);
	}

	function endSession(): void {
		sessionActive = false;
		sessionGeneration++;
		closeCurator();
		closeCommandCurators();
		abortPendingFetches();
		releaseResults(ownedResults);
		ownedResults.clear();
		liveInstances.delete(instance);
		if (liveInstances.size === 0) clearCloneCache();
		else releaseClonesUnusedSince(Math.min(...liveInstances.values()));
	}

	function startSession(ctx: ExtensionContext): void {
		endSession();
		liveInstances.set(instance, Date.now());
		sessionActive = true;
		const restored = loadSessionResults(ctx);
		for (const data of restored) own(data.id);
		// Restored results may point at clone paths; they are in use for as long as this session is.
		touchClones(restored.flatMap((data) => (data.type === "fetch" ? (data.urls ?? data.urlMetadata ?? []).map((u) => u.url) : [])));
		refreshUi(ctx);
	}

	function startBackgroundFetch(urls: string[], proxy?: string, provided?: ExtractedContent[]): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		Promise.resolve()
			.then(() => fetchUncoveredContent(urls, provided, missing => runWithProxy(proxy, () => fetchAllContent(missing, controller.signal, withRegisteredFetchOptions(undefined, registeredToolNames, proxy)))))
			.then((fetched) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const data = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				} satisfies FetchedContentData;
				publish(storeFetchedContentResult(fetchId, data));
				const ok = fetched.filter(f => !f.error).length;
				const availability = ok === fetched.length
					? "Full page content now available."
					: ok > 0
						? "Partial page content now available."
						: "No page content was fetched. Stored fetch diagnostics are available.";
				pi.sendMessage(
					{
						customType: "web-search-content-ready",
						content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. ${availability}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			})
			.catch((err) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					pi.sendMessage(
						{
							customType: "web-search-error",
							content: `Content fetch failed [${fetchId}]: ${message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			})
			.finally(() => { pendingFetches.delete(fetchId); });
		return fetchId;
	}

	const core = createWebToolCore({
		settings: coreSettings,
		formatStoredContentCall: options.formatStoredContentCall,
		storeFetchedContent(id, data) {
			publish(storeFetchedContentResult(id, data));
		},
		publishResult(data) {
			publish(data);
		},
		startBackgroundFetch,
		answerFromPage: (request, ctx, signal) => answerFromPage(request, ctx!, signal),
	});
	const buildSearchReturn = core.buildSearchReturn;

	function buildCurationCancelledReturn(
		reason: "user" | "stale",
		partial?: {
			queries?: QueryResultData[];
			queryCount?: number;
			browserConnected?: boolean;
			lastHeartbeatAgeMs?: number | null;
			curatorUrl?: string;
			browserOpenError?: string;
		},
	): AgentToolResult<Record<string, unknown>> {
		const message = `Search curation cancelled (${reason}).`;
		const cancelledQueries = partial?.queries?.length
			? partial.queries.map(q => ({
				query: q.query,
				provider: q.provider ?? null,
				error: q.error,
				resultCount: q.results?.length ?? 0,
			}))
			: undefined;
		const extraLines: string[] = [];
		if (partial?.curatorUrl) extraLines.push(`curator: ${partial.curatorUrl}`);
		if (partial?.browserOpenError) extraLines.push(`browser open error: ${partial.browserOpenError}`);
		return {
			content: [{ type: "text", text: message }],
			details: {
				error: message,
				cancelled: true,
				cancelReason: reason,
				browserConnected: partial?.browserConnected,
				lastHeartbeatAgeMs: partial?.lastHeartbeatAgeMs,
				queryCount: partial?.queryCount,
				cancelledQueries,
				extraLines: extraLines.length > 0 ? extraLines : undefined,
			},
		};
	}

	async function openCuratorBrowser(callId: string, pc: PendingCurate, ctx: ExtensionContext, searchesComplete = true): Promise<void> {
		if (pendingCurates.get(callId) !== pc) return;
		let handle: CuratorServerHandle | null = null;
		const sendCuratorFallbackUpdate = (message: string) => {
			if (!handle) return;
			pc.onUpdate?.({
				content: [{ type: "text", text: `${message}\nOpen manually: ${handle.url}` }],
				details: {
					phase: "curator-fallback",
					progress: searchesComplete ? 1 : 0.5,
					curatorUrl: handle.url,
					timeoutSeconds: pc.timeoutSeconds,
					shortcut: curateKey,
					browserOpenError: pc.browserOpenError,
				},
			});
		};
		try {
			pc.phase = "curating";

			const searchAbort = new AbortController();
			const addSearchSignal = pc.signal
				? AbortSignal.any([pc.signal, searchAbort.signal])
				: searchAbort.signal;

			const sessionToken = randomUUID();
			handle = await startCuratorServer(
				{
					queries: pc.queryList,
					initialResultIndexCapacity: curatorResultIndexCapacity(pc.queryList.length),
					sessionToken,
					timeout: pc.timeoutSeconds,
					availableProviders: pc.availableProviders,
					defaultProvider: pc.defaultProvider,
					searchProvider: toCuratorProvider(pc.searchProvider) ?? "auto",
					summaryModels: pc.summaryModels,
					defaultSummaryModel: pc.defaultSummaryModel,
				},
				{
					async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
						return runWithProxy(pc.proxy, async () => {
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							pc.onUpdate?.({
								content: [{ type: "text", text: "Generating summary draft..." }],
								details: { phase: "generating-summary", progress: 0.9, curatorUrl: pc.curatorUrl, timeoutSeconds: pc.timeoutSeconds, shortcut: curateKey },
							});
							const draft = await generateCuratorSummary(
								selectedQueryIndices,
								pc.searchResults,
								pc.summaryContext,
								summarizeSignal,
								model,
								feedback,
							);
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							pc.onUpdate?.({
								content: [{ type: "text", text: "Summary draft ready — waiting for approval..." }],
								details: { phase: "waiting-for-approval", progress: 1, curatorUrl: pc.curatorUrl, timeoutSeconds: pc.timeoutSeconds, shortcut: curateKey },
							});
							return draft;
						});
					},
					onSubmit(payload) {
						if (pendingCurates.get(callId) !== pc) return;
						if (payload.autoApproveRemainingSearches) curatorRunState.approveRemainingSearches();
						searchAbort.abort();
						pc.finish(buildSearchReturn({
							...buildCuratedSearchOptions(pc.searchResults, payload, pc.allInlineContent),
							includeContent: pc.includeContent, proxy: pc.proxy,
						}));
						closeCurator(callId);
					},
					onCancel(reason) {
						if (pendingCurates.get(callId) !== pc) return;
						searchAbort.abort();
						if (reason === "timeout") {
							pc.finish(buildSearchReturn({
								...buildCuratedSearchOptions(pc.searchResults, { selectedQueryIndices: [] }, pc.allInlineContent),
								includeContent: pc.includeContent, proxy: pc.proxy,
							}));
						} else {
							const conn = activeCurators.get(callId)?.getConnectionState();
							pc.finish(buildCurationCancelledReturn(reason, {
								queries: orderedCuratorResults(pc.searchResults),
								queryCount: pc.queryList.length,
								browserConnected: conn?.browserConnected,
								lastHeartbeatAgeMs: conn?.lastHeartbeatAgeMs,
								curatorUrl: pc.curatorUrl,
								browserOpenError: pc.browserOpenError,
							}));
						}
						closeCurator(callId);
					},
					onProviderChange(provider) {
						if (pendingCurates.get(callId) !== pc) return;
						const normalized = normalizeProviderInput(provider);
						if (!normalized || normalized === "auto" || Array.isArray(normalized)) return;
						pc.defaultProvider = normalized;
						pc.searchProvider = normalized;
						try {
							saveDefaultSearchProvider(normalized);
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							console.error(`Failed to persist default provider: ${message}`);
						}
					},
					async onAddSearch(query, provider) {
						return runWithProxy(pc.proxy, async () => {
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							const requestedProvider = resolveCuratorSearchProvider(provider, pc.searchProvider);
							const response = await search(query, {
								provider: requestedProvider,
								numResults: pc.numResults,
								recencyFilter: pc.recencyFilter,
								domainFilter: pc.domainFilter,
								includeContent: pc.includeContent,
								category: pc.category,
								signal: addSearchSignal,
								extensionContext: ctx,
							});
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							if (response.inlineContent) pc.allInlineContent.push(...response.inlineContent);
							return toCuratorSearchEntries(response);
						});
					},
					onAddSearchResults(entries) {
						if (pendingCurates.get(callId) !== pc) return;
						for (const entry of entries) {
							pc.searchResults.set(entry.queryIndex, indexedCuratorEntryToQueryResult(entry));
						}
					},
					async onRewriteQuery(query, rewriteSignal) {
						return runWithProxy(pc.proxy, async () => {
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							return rewriteSearchQuery(query, pc.summaryContext, rewriteSignal);
						});
					},
				},
			);

			if (pendingCurates.get(callId) !== pc) {
				handle.close();
				return;
			}

			activeCurators.set(callId, handle);
			pc.curatorUrl = handle.url;

			for (const [qi, data] of pc.searchResults) {
				const slotIndex = pc.resultSlots.get(qi);
				if (data.error) {
					handle.pushError(qi, data.error, data.provider, { query: data.query, slotIndex });
				} else {
					handle.pushResult(qi, {
						answer: data.answer,
						results: data.results.map(r => ({ ...r, domain: extractDomain(r.url) })),
						provider: data.provider || pc.defaultProvider,
						query: data.query,
						slotIndex,
					});
				}
			}
			if (searchesComplete) handle.searchesDone();

			pc.onUpdate?.({
				content: [{ type: "text", text: searchesComplete ? "Waiting for summary approval in browser..." : "Searches streaming to browser..." }],
				details: {
					phase: "curating",
					progress: searchesComplete ? 1 : 0.5,
					curatorUrl: handle.url,
					timeoutSeconds: pc.timeoutSeconds,
					shortcut: curateKey,
				},
			});

			if (!shouldAutoOpenCuratorBrowser(loadConfig())) {
				sendCuratorFallbackUpdate("Search curator is running. Open the curator URL manually.");
				return;
			}

			const win = await openCuratorBrowserWindow(pi, handle.url);
			if (pendingCurates.get(callId) !== pc) { win?.close(); return; }
			if (win) {
				glimpseWins.set(callId, win);
				win.on("closed", () => {
					if (glimpseWins.get(callId) === win) {
						glimpseWins.delete(callId);
						closeCurator(callId);
					}
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to open curator UI: ${message}`);
			if (handle && activeCurators.get(callId) === handle && pendingCurates.get(callId) === pc) {
				pc.browserOpenError = message;
				sendCuratorFallbackUpdate("Search curator is running, but the browser did not open automatically.");
			} else if (pendingCurates.get(callId) === pc || (handle && activeCurators.get(callId) === handle)) {
				closeCurator(callId);
			}
		}
	}

	pi.registerShortcut(curateKey, {
		description: "Review search results",
		handler: async (ctx) => {
			const entries = [...pendingCurates.entries()];
			if (entries.length === 0) return;
			const [callId, pc] = entries[entries.length - 1];

			if (pc.phase === "searching") {
				pc.browserPromise = openCuratorBrowser(callId, pc, ctx, false);
				ctx.ui.notify("Opening curator — remaining searches will stream in", "info");
				return;
			}
		},
	});

	pi.registerShortcut(activityKey, {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			if (widgetVisible) {
				widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
			} else {
				widgetUnsubscribe?.();
				widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", undefined);
			}
		},
	});

	// web_search calls a tool made, such as a codemode script, reach the tool_call
	// handlers before execute with parentToolCallId set; execute consumes the id.
	// Ids of calls a later handler blocked are dropped when the session changes.
	const nestedSearchCallIds = new Set<string>();
	if (webSearchEnabled) pi.on("tool_call", (event) => {
		const isSearch = event.toolName === toolNames.webSearch ||
			(event.toolName === options.toolName && "action" in event.input && event.input.action === "search");
		if (event.parentToolCallId && isSearch) nestedSearchCallIds.add(event.toolCallId);
	});

	pi.on("session_start", async (_event, ctx) => { nestedSearchCallIds.clear(); startSession(ctx); });
	pi.on("session_tree", async (_event, ctx) => { nestedSearchCallIds.clear(); startSession(ctx); });

	pi.on("session_shutdown", () => {
		nestedSearchCallIds.clear();
		endSession();
		// Unsubscribe before clear() to avoid callback with stale ctx
		widgetUnsubscribe?.();
		widgetUnsubscribe = null;
		if (liveInstances.size === 0) activityMonitor.clear();
		widgetVisible = false;
	});

	if (webSearchEnabled) registerTool("search", {
		name: toolNames.webSearch,
		label: "Web Search",
		prepareArguments: (args) => parseStringifiedArrays(args, ["provider", "queries", "domainFilter"]) as never,
		description:
			`Search the web and return source-linked results or provider answers.${getSearchContentEnabled
				? ` Full results are stored for retrieval with ${coreSettings.toolNames.getSearchContent} using the returned responseId.`
				: ""} For research, prefer queries with 2-4 varied angles over a single query. ` +
			"Omit provider to use the configured default; set it only to override that.",
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage. Omit provider unless explicitly overriding the configured default.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched concurrently (up to three at a time), each returning source-linked search results or a provider answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			category: Type.Optional(Type.String({ description: "Exa only: result category, e.g. news, research paper" })),
			provider: Type.Optional(searchProviderSchema(`Search provider or non-empty list of allowed providers to search simultaneously; ${allPolicyDescription}; omit this field to use the configured provider, or use auto when none is configured`, allowedSearchProviders)),
			workflow: Type.Optional(
				StringEnum(["none", "summary-review", "auto-summary"], {
					description: "Search workflow mode: none = no curator (default), summary-review = open curator with auto summary draft, auto-summary = generate summary without opening curator",
				}),
			),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for every outbound request in this call (search APIs and content fetches). Node fetch ignores HTTP(S)_PROXY env vars, so set this (or `proxy` in web-search.json) when direct access is blocked; empty string forces direct access.",
			})),
		}),
		outputSchema: webSearchOutputSchema,

		async execute(callId, params, signal, onUpdate, ctx) {
			const generation = sessionGeneration;
			// Nested calls neither open the curator unless asked nor fetch content in the background.
			const nested = nestedSearchCallIds.delete(callId);
			return markToolError(await runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const rawQueryList: unknown[] = Array.isArray(params.queries)
					? params.queries
					: (params.query !== undefined ? expandQueryString(params.query) : []);
				const queryList = normalizeQueryList(rawQueryList);
				const configWorkflow = loadConfigForExtensionInit().workflow;
				const workflow = nested && params.workflow === undefined
					? "none"
					: curatorRunState.resolve(params.workflow, configWorkflow, ctx?.hasUI !== false);
				const shouldCurate = workflow === "summary-review";
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

				if (queryList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
						details: { error: "No query provided" },
					};
				}

				if (shouldCurate && !ctx) {
					return {
						content: [{ type: "text", text: "Error: Curation requires an active extension context." }],
						details: { error: "Missing extension context" },
					};
				}

				if (shouldCurate) {
				closeCurator(callId);

				let resolvePromise: (value: AgentToolResult<Record<string, unknown>>) => void = () => {};
				const promise = new Promise<AgentToolResult<Record<string, unknown>>>((resolve) => {
					resolvePromise = resolve;
				});
				const includeContent = params.includeContent ?? false;
				const searchResults = new Map<number, QueryResultData>();
				const resultSlots = new Map<number, number>();
				const allInlineContent: ExtractedContent[] = [];
				const searchAbort = new AbortController();
				const searchSignal = signal
					? AbortSignal.any([signal, searchAbort.signal])
					: searchAbort.signal;
				let cancelled = false;

				const requestedProvider = resolveRequestedProvider(params.provider);
				const bootstrap = await loadCuratorBootstrap(requestedProvider, ctx, {
					numResults: params.numResults,
					recencyFilter,
				});
				const availableProviders = bootstrap.availableProviders;
				const defaultProvider = bootstrap.defaultProvider;
				const searchProvider = requestedProvider;
				const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
				const curatorWorkflow: CuratorWorkflow = "summary-review";

				const summaryContext: SummaryGenerationContext = {
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					sessionManager: ctx.sessionManager,
					scopedModels: ctx.scopedModels,
				};
				const summaryModelChoices = await loadSummaryModelChoices(summaryContext);
				if (generation !== sessionGeneration || signal?.aborted) return buildCurationCancelledReturn("stale");

				const pc: PendingCurate = {
					phase: "searching",
					workflow: curatorWorkflow,
					summaryContext,
					searchResults,
					resultSlots,
					allInlineContent,
					queryList,
					includeContent,
					numResults: params.numResults,
					recencyFilter,
					domainFilter: params.domainFilter,
					category: params.category,
					availableProviders,
					defaultProvider,
					searchProvider,
					summaryModels: summaryModelChoices.summaryModels,
					defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
					timeoutSeconds: curatorTimeoutSeconds,
					proxy: typeof params.proxy === "string" ? params.proxy : undefined,
					onUpdate: onUpdate as PendingCurate["onUpdate"],
					signal,
					abortSearches: () => {
						if (!searchAbort.signal.aborted) searchAbort.abort();
					},
					finish: () => {},
					cancel: () => {},
				};

				const finish = (value: AgentToolResult<Record<string, unknown>>) => {
					if (cancelled) return;
					cancelled = true;
					pc.abortSearches();
					signal?.removeEventListener("abort", onAbort);
					pendingCurates.delete(callId);
					resolvePromise(value);
				};

				const cancel = (reason: "user" | "stale" = "stale") => {
					if (cancelled) return;
					const conn = activeCurators.get(callId)?.getConnectionState();
					finish(buildCurationCancelledReturn(reason, {
						queries: orderedCuratorResults(searchResults),
						queryCount: queryList.length,
						browserConnected: conn?.browserConnected,
						lastHeartbeatAgeMs: conn?.lastHeartbeatAgeMs,
						curatorUrl: pc.curatorUrl,
						browserOpenError: pc.browserOpenError,
					}));
				};

				pc.finish = finish;
				pc.cancel = cancel;

				const onAbort = () => closeCurator(callId);
				pendingCurates.set(callId, pc);
				signal?.addEventListener("abort", onAbort, { once: true });
				pc.browserPromise = openCuratorBrowser(callId, pc, ctx, false);

				let completedSearches = 0;
				await runSearchQueries(queryList, async (query, qi) => {
					if (signal?.aborted || cancelled || searchAbort.signal.aborted) return;
					onUpdate?.({
						content: [{ type: "text", text: `Searching "${query}" (${completedSearches}/${queryList.length} complete)...` }],
						details: { phase: "searching", progress: completedSearches / queryList.length, currentQuery: query },
					});
					const requestedProvider = pc.searchProvider;
					try {
						const response = await search(query, {
							provider: requestedProvider,
							numResults: params.numResults,
							recencyFilter,
							domainFilter: params.domainFilter,
							includeContent: params.includeContent,
							category: params.category,
							signal: searchSignal,
							extensionContext: ctx,
						});
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) return;
						if (response.inlineContent) allInlineContent.push(...response.inlineContent);
						const entries = toCuratorSearchEntries(response);
						const curator = activeCurators.get(callId);
						for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
							const entry = entries[entryIndex];
							const resultIndex = curatorResultIndex(qi, entryIndex, queryList.length);
							const indexedEntry: IndexedCuratorSearchEntry = {
								...entry,
								queryIndex: resultIndex,
								query,
							};
							searchResults.set(resultIndex, indexedCuratorEntryToQueryResult(indexedEntry));
							resultSlots.set(resultIndex, qi);
							if (curator) {
								if (entry.error) {
									curator.pushError(resultIndex, entry.error, entry.provider, { query, slotIndex: qi });
								} else {
									curator.pushResult(resultIndex, { ...entry, query, slotIndex: qi });
								}
							}
						}
					} catch (err) {
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) return;
						const message = err instanceof Error ? err.message : String(err);
						const failedProvider = toCuratorProvider(requestedProvider);
						searchResults.set(qi, { query, answer: "", results: [], error: message, provider: failedProvider });
						resultSlots.set(qi, qi);
						const curator = activeCurators.get(callId);
						if (curator) {
							curator.pushError(qi, message, failedProvider, { query, slotIndex: qi });
						}
					} finally {
						completedSearches++;
						if (!signal?.aborted && !cancelled && !searchAbort.signal.aborted) {
							onUpdate?.({
								content: [{ type: "text", text: `Completed ${completedSearches}/${queryList.length} searches.` }],
								details: { phase: "searching", progress: completedSearches / queryList.length, currentQuery: query },
							});
						}
					}
				});

				if (signal?.aborted || cancelled || searchAbort.signal.aborted) {
					cancel();
					return promise;
				}

				await pc.browserPromise;
				const curator = activeCurators.get(callId);
				if (curator && !cancelled) {
					curator.searchesDone();
					if (pc.browserOpenError) {
						pc.onUpdate?.({
							content: [{ type: "text", text: `All searches complete. Open the curator manually: ${pc.curatorUrl}` }],
							details: {
								phase: "curator-fallback",
								progress: 1,
								curatorUrl: pc.curatorUrl,
								timeoutSeconds: pc.timeoutSeconds,
								shortcut: curateKey,
								browserOpenError: pc.browserOpenError,
							},
						});
					} else {
						pc.onUpdate?.({
							content: [{ type: "text", text: "All searches complete — waiting for summary approval in browser..." }],
							details: {
								phase: "curating",
								progress: 1,
								curatorUrl: pc.curatorUrl,
								timeoutSeconds: pc.timeoutSeconds,
								shortcut: curateKey,
							},
						});
					}
				}

				return promise;
			}

			let summarize: WebSearchCallOptions["summarize"];
			if (workflow === "auto-summary") {
				summarize = async (searchResults) => {
					if (!ctx) {
						return {
							content: [{ type: "text", text: "Error: Auto-summary requires an active extension context." }],
							details: { error: "Missing extension context" },
						};
					}
					onUpdate?.({
						content: [{ type: "text", text: "Generating summary..." }],
						details: { phase: "generating-summary", progress: 1 },
					});
					const summaryContext: SummaryGenerationContext = {
						model: ctx.model,
						modelRegistry: ctx.modelRegistry,
						sessionManager: ctx.sessionManager,
						scopedModels: ctx.scopedModels,
					};
					const summaryModelChoices = await loadSummaryModelChoices(summaryContext);
					const generated = await generateSummaryDraft(
						searchResults,
						summaryContext,
						signal,
						summaryModelChoices.defaultSummaryModel ?? undefined,
						undefined,
						undefined,
						getSummaryGenerationDeadlineMs(),
						getSummaryInstructions(),
					);
					return { approvedSummary: generated.summary, summaryMeta: generated.meta };
				};
			}
			return core.webSearch(params, signal, { extensionContext: ctx, onUpdate, summarize, awaitContent: nested });
			}));
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? expandQueryString(input.query) : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${q}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				lines.push(theme.fg("muted", `  "${q}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			type QueryDetail = {
				query: string;
				provider: string | null;
				answer: string | null;
				sources: Array<{ title: string; url: string }>;
				error: string | null;
			};
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
				currentQuery?: string;
				curated?: boolean;
				curatedFrom?: number;
				curatedQueries?: QueryDetail[];
				cancelled?: boolean;
				cancelReason?: string;
				browserConnected?: boolean;
				lastHeartbeatAgeMs?: number | null;
				cancelledQueries?: import("./render-search-error.ts").CancelledQueryDetail[];
				curatorUrl?: string;
				browserOpenError?: string;
				timeoutSeconds?: number;
				shortcut?: string;
				summary?: {
					text: string;
					workflow: SummaryWorkflow;
					model: string | null;
					durationMs: number;
					tokenEstimate: number;
					fallbackUsed: boolean;
					fallbackReason?: string;
					phase?: "summary-model" | "deterministic-fallback";
					edited?: boolean;
				};
			};

			if (isPartial) {
				if (details?.phase === "curator-fallback") {
					const lines = [theme.fg("warning", "Open the search curator manually:")];
					if (details?.curatorUrl) lines.push(theme.fg("muted", `  ${details.curatorUrl}`));
					if (details?.browserOpenError) lines.push(theme.fg("dim", `  auto-open failed: ${details.browserOpenError}`));
					const timeout = typeof details?.timeoutSeconds === "number" ? details.timeoutSeconds : undefined;
					const shortcut = typeof details?.shortcut === "string" ? details.shortcut : curateKey;
					lines.push(theme.fg("dim", timeout ? `  auto-submits after ${timeout}s idle; ${shortcut} reopens` : `  ${shortcut} reopens`));
					return new Text(lines.join("\n"), 0, 0);
				}
				if (details?.phase === "curating" || details?.phase === "waiting-for-approval" || details?.phase === "generating-summary") {
					const phaseText = details?.phase === "generating-summary"
						? "generating summary draft..."
						: details?.phase === "waiting-for-approval"
							? "summary draft ready; approve in browser..."
							: "waiting for summary approval in browser...";
					const lines = [theme.fg("accent", phaseText)];
					if (details?.curatorUrl) {
						lines.push(theme.fg("muted", `  ${details.curatorUrl}`));
					}
					const timeout = typeof details?.timeoutSeconds === "number" ? details.timeoutSeconds : undefined;
					const shortcut = typeof details?.shortcut === "string" ? details.shortcut : curateKey;
					if (timeout) {
						lines.push(theme.fg("dim", `  auto-submits after ${timeout}s idle; ${shortcut} reopens`));
					} else {
						lines.push(theme.fg("dim", `  ${shortcut} reopens`));
					}
					return new Text(lines.join("\n"), 0, 0);
				}
				if (details?.phase === "searching") {
					const progress = details?.progress ?? 0;
					const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
					const query = details?.currentQuery || "";
					const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
					return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
				}
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
			}

			if (details?.error) {
				// Expandable Ctrl+O diagnostics: which queries completed, per-query errors,
				// browser connection state, cancel reason. See render-search-error.ts.
				const plan = buildSearchErrorPlan(details as SearchErrorDetails);
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.curated && details?.curatedFrom) {
				statusLine += theme.fg("muted", ` (${details.queryCount}/${details.curatedFrom} queries curated)`);
			}
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			// Build expanded lines first so collapsed view can reference total count
			const lines = [statusLine];
			if (details?.summary?.text) {
				lines.push("");
				lines.push(theme.fg("accent", `── Summary (${details.summary.workflow}) ` + "─".repeat(32)));
				lines.push("");
				for (const line of details.summary.text.split("\n")) {
					lines.push(`  ${line}`);
				}
				lines.push("");
				const metaParts = [
					details.summary.model ? `model=${details.summary.model}` : "model=deterministic",
					`duration=${details.summary.durationMs}ms`,
					`tokens~${details.summary.tokenEstimate}`,
					details.summary.fallbackUsed ? "fallback=true" : "fallback=false",
					details.summary.phase ? `phase=${details.summary.phase}` : "",
					details.summary.edited ? "edited=true" : "edited=false",
				];
				if (details.summary.fallbackReason) {
					metaParts.push(`reason=${details.summary.fallbackReason}`);
				}
				lines.push(theme.fg("dim", "  " + metaParts.filter(Boolean).join(" · ")));
			}

			const queryDetails = details?.curatedQueries;
			if (queryDetails?.length) {
				const kept = queryDetails.length;
				const from = details?.curatedFrom ?? kept;
				lines.push("");
				lines.push(theme.fg("accent", `\u2500\u2500 Curated Results (${kept} of ${from} queries kept) ` + "\u2500".repeat(24)));

				for (const cq of queryDetails) {
					lines.push("");
					const dq = cq.query.length > 65 ? cq.query.slice(0, 62) + "..." : cq.query;
					const providerLabel = cq.provider ? ` (${cq.provider})` : "";
					lines.push(theme.fg("accent", `  "${dq}"${providerLabel}`));

					if (cq.error) {
						lines.push(theme.fg("error", `  ${cq.error}`));
					} else if (cq.answer) {
						lines.push("");
						for (const line of cq.answer.split("\n")) {
							lines.push(`  ${line}`);
						}
					}

					if (cq.sources.length > 0) {
						lines.push("");
						for (const s of cq.sources) {
							const domain = s.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
							const title = s.title.length > 50 ? s.title.slice(0, 47) + "..." : s.title;
							lines.push(theme.fg("muted", `  \u25b8 ${title}`) + theme.fg("dim", ` \u00b7 ${domain}`));
						}
					}
				}
				lines.push("");
			} else {
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				for (const line of preview.split("\n")) {
					lines.push(theme.fg("dim", line));
				}
			}

			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				if (details.curated) {
					lines.push(theme.fg("muted", `Fetching ${details.fetchUrls.length} URLs in background`));
				} else {
					lines.push(theme.fg("muted", "Fetching:"));
					for (const u of details.fetchUrls.slice(0, 5)) {
						const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
						lines.push(theme.fg("dim", "  " + display));
					}
					if (details.fetchUrls.length > 5) {
						lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
					}
				}
			}

			const totalLines = lines.length;

			if (!expanded) {
				const box = new Box(1, 0);
				box.addChild(new Text(statusLine, 0, 0));

				let collapsedLines = 1; // statusLine
				const summaryPreview = details?.summary?.text?.trim() || "";
				if (summaryPreview) {
					const preview = summaryPreview.length > 120 ? summaryPreview.slice(0, 117) + "..." : summaryPreview;
					box.addChild(new Text(theme.fg("dim", preview), 0, 0));
					collapsedLines++;
				} else if (details?.curatedQueries?.length) {
					for (const cq of details.curatedQueries.slice(0, 3)) {
						const dq = cq.query.length > 55 ? cq.query.slice(0, 52) + "..." : cq.query;
						const srcCount = cq.sources?.length ?? 0;
						const suffix = cq.error ? theme.fg("error", " (error)") : theme.fg("dim", ` · ${srcCount} sources`);
						box.addChild(new Text(theme.fg("accent", `  "${dq}"`) + suffix, 0, 0));
						collapsedLines++;
					}
					if (details.curatedQueries.length > 3) {
						box.addChild(new Text(theme.fg("dim", `  ... and ${details.curatedQueries.length - 3} more`), 0, 0));
						collapsedLines++;
					}
				} else {
					const textContent = result.content.find((c) => c.type === "text")?.text || "";
					const firstContentLine = textContent.split("\n").find(l => {
						const t = l.trim();
						return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
					});
					const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
					if (fallbackLine) {
						const preview = fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine;
						box.addChild(new Text(theme.fg("dim", preview), 0, 0));
						collapsedLines++;
					}
				}
				const moreLines = Math.max(0, totalLines - collapsedLines);
				if (moreLines > 0) {
					box.addChild(new Text(theme.fg("muted", `\n... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`), 0, 0));
				}
				return box;
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});

	if (sourceCheckEnabled) registerTool("source_check", {
		name: toolNames.sourceCheck,
		label: "Source Check",
		description: "Gather web sources for a claim and return a bounded machine-readable research artifact with exact passage citations for manual review.",
		promptSnippet: "Gather structured source evidence and passage-level citations for manual semantic review of a claim.",
		parameters: Type.Object({
			claim: Type.String({ description: "The assertion to gather web sources for." }),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Search queries (default: the claim)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)." })),
			fetchContent: Type.Optional(Type.Boolean({ description: "Fetch up to 5 result pages for exact passage extraction." })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency." })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude." })),
			provider: Type.Optional(searchProviderSchema(`Search provider or non-empty list of allowed providers to search simultaneously; ${allPolicyDescription}`, allowedSearchProviders)),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for every outbound request in this call (search APIs and result-page fetches). Empty string forces direct access.",
			})),
		}),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			return markToolError(await core.sourceCheck(params, signal, { extensionContext: ctx }));
		},
	});

	if (fetchContentEnabled) registerTool("fetch", {
		name: toolNames.fetchContent,
		label: "Fetch Content",
		description: `Fetch URL(s). Available modes: ${fetchModeDescription}. Direct image URLs return resized image content when supported by the selected mode. Supports YouTube transcripts, GitHub repositories, PDFs, and local videos when supported by the selected mode. ${fetchContentStorageNote}`,
		promptSnippet:
			"Use to fetch URL content, direct images, GitHub repos, and videos.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			prompt: Type.Optional(Type.String({
				description: fetchModeConfig.allowedModes.includes("answer")
					? "Question or instruction for video analysis, or the page-local question required by answer mode."
					: "Question or instruction for video analysis.",
			})),
			mode: Type.Optional(StringEnum(fetchModeConfig.allowedModes, {
				description: `Fetch mode. ${fetchModeDescription}.`,
			})),
			...(fetchModeConfig.allowedModes.includes("answer") ? {
				answerModel: Type.Optional(Type.String({
					description: "Optional provider/model-id override for answer mode. Defaults to fetch.answerProvider + fetch.answerModel when configured, otherwise the current Pi model.",
				})),
			} : {}),
			timestamp: Type.Optional(Type.String({
				description: "Extract video frame(s) at a timestamp or time range. Single: '1:23:45', '23:45', or '85' (seconds). Range: '23:41-25:00' extracts evenly-spaced frames across that span (default 6). Use frames with ranges to control density; single+frames uses a fixed 5s interval. YouTube requires yt-dlp + ffmpeg; local videos require ffmpeg. Use a range when you know the approximate area but not the exact moment — you'll get a contact sheet to visually identify the right frame.",
			})),
			frames: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 12,
				description: "Number of frames to extract. Use with timestamp range for custom density, with single timestamp to get N frames at 5s intervals, or alone to sample across the entire video. Requires yt-dlp + ffmpeg for YouTube, ffmpeg for local video.",
			})),
			model: Type.Optional(Type.String({
				description: "Override the Gemini model for video/YouTube analysis (e.g. 'gemini-3.6-flash'). Defaults to config or gemini-3.6-flash.",
			})),
			auth: Type.Optional(Type.Union([Type.String(), Type.Boolean()], {
				description: "Opt into an authFetch profile for local browser-cookie fetching. Use a profile name, or true only when exactly one profile exists.",
			})),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for this fetch. Needed when the target is unreachable directly; localhost and NO_PROXY hosts always bypass the proxy. Empty string forces direct access.",
			})),
		}),
		outputSchema: fetchContentOutputSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			return markToolError(await core.fetchContent(params, signal, { extensionContext: ctx, onUpdate }));
		},

		renderCall(args, theme) {
			let normalized: ReturnType<typeof normalizeFetchContentParams>;
			try {
				normalized = normalizeFetchContentParams(args);
			} catch {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(invalid parameters)"), 0, 0);
			}
			const { urlList, options } = normalized;
			const { prompt, timestamp, frames, model, mode, answerModel, auth } = options;
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", urlList[0]));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					lines.push(theme.fg("muted", "  " + u));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			if (mode && mode !== "readable") {
				lines.push(theme.fg("dim", "  mode: ") + theme.fg("warning", mode));
			}
			if (timestamp) {
				lines.push(theme.fg("dim", "  timestamp: ") + theme.fg("warning", timestamp));
			}
			if (typeof frames === "number") {
				lines.push(theme.fg("dim", "  frames: ") + theme.fg("warning", String(frames)));
			}
			if (prompt) {
				const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
				lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${display}"`));
			}
			if (model) {
				lines.push(theme.fg("dim", "  model: ") + theme.fg("warning", model));
			}
			if (answerModel) {
				lines.push(theme.fg("dim", "  answer model: ") + theme.fg("warning", answerModel));
			}
			if (auth !== undefined) {
				lines.push(theme.fg("dim", "  auth: ") + theme.fg("warning", auth === true ? "true" : auth));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
				hasImage?: boolean;
				imageCount?: number;
				prompt?: string;
				timestamp?: string;
				frames?: number;
				duration?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				const fd = details as typeof details & { urls?: string[] };
				const extras: string[] = [];
				if (typeof fd.urlCount === "number" || typeof fd.successful === "number") {
					extras.push(`urls: ${fd.successful ?? 0}/${fd.urlCount ?? 0} succeeded`);
				}
				if (fd.responseId) extras.push(`response id: ${fd.responseId}`);
				if (fd.urls && fd.urls.length > 0) {
					for (const u of fd.urls.slice(0, 8)) extras.push(`  \u25b8 ${u}`);
					if (fd.urls.length > 8) extras.push(`  ... and ${fd.urls.length - 8} more`);
				}
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
				const imageBadge = imgCount > 1
					? theme.fg("accent", ` [${imgCount} images]`)
					: imgCount === 1
						? theme.fg("accent", " [image]")
						: "";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				if (typeof details?.duration === "number") {
					statusLine += theme.fg("muted", ` | ${formatSeconds(Math.floor(details.duration))} total`);
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const lines = [statusLine];
				if (details?.prompt) {
					const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
					lines.push(theme.fg("dim", `  prompt: "${display}"`));
				}
				if (details?.timestamp) {
					lines.push(theme.fg("dim", `  timestamp: ${details.timestamp}`));
				}
				if (typeof details?.frames === "number") {
					lines.push(theme.fg("dim", `  frames: ${details.frames}`));
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				lines.push(theme.fg("dim", preview));
				return new Text(lines.join("\n"), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", getSearchContentEnabled ? " (content stored)" : " (content fetched)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	if (getSearchContentEnabled) {
		const maxInlineContentChars = getMaxInlineContentChars(initConfig);
		registerTool("content", {
		name: toolNames.getSearchContent,
		label: "Get Search Content",
		description: `Retrieve bounded pages of full stored search results or fetched content, or find matching passages, from a previous ${storedContentSources} call.`,
		promptSnippet:
			`Use after ${storedContentSources} to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.`,
		parameters: Type.Object({
			responseId: Type.String({ description: `The responseId from ${storedContentSources}` }),
			query: Type.Optional(Type.String({ description: searchQueryDescription })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset in stored search or fetched URL content (default 0). Ignored when findText is supplied." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxInlineContentChars, description: "Requested maximum stored-content characters (default and max use maxInlineContentChars). Search-page continuation guidance shares the global output cap and may reduce returnedChars. Ignored when findText is supplied." })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Text or texts to find in the selected stored content. When supplied, offset and limit are ignored." })),
			findMode: Type.Optional(StringEnum(["exact", "case-insensitive", "fuzzy"], { description: "Matching mode for findText (default: case-insensitive). Requires findText." })),
		}),

		async execute(_toolCallId, rawParams): Promise<AgentToolResult<Record<string, unknown>>> {
			return markToolError(await core.getSearchContent(rawParams));
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex, offset, findText } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
				offset?: number;
				findText?: string | string[];
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			if (offset !== undefined) target += target ? ` @ ${offset}` : `offset=${offset}`;
			if (findText !== undefined) {
				const queries = Array.isArray(findText) ? findText : [findText];
				target += `${target ? " · " : ""}find ${queries.length}`;
			}
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
				offset?: number;
				returnedChars?: number;
				nextOffset?: number | null;
				matchCount?: number;
				returnedMatches?: number;
			};

			if (details?.error) {
				const extras: string[] = [];
				if (details.query) extras.push(`query: ${details.query}`);
				if (details.url) extras.push(`url: ${details.url}`);
				else if (details.title) extras.push(`resource: ${details.title}`);
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (typeof details?.matchCount === "number") {
				statusLine = theme.fg("success", details?.title || details?.query || "Content") + theme.fg("muted", ` (${details.matchCount} matches, ${details.returnedMatches ?? 0} shown)`);
			} else if (details?.query) {
				statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
			} else {
				const start = details?.offset ?? 0;
				const returned = details?.returnedChars ?? details?.contentLength ?? 0;
				const end = start + returned;
				const slice = details?.nextOffset !== undefined || start > 0
					? `, showing ${start}-${end}`
					: "";
				statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars${slice})`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
	}

	if (toolActivation !== "eager") registerWebToolActivation(pi, [
		...(webSearchEnabled ? [{ name: toolNames.webSearch, capability: "search" as const }] : []),
		...(sourceCheckEnabled ? [{ name: toolNames.sourceCheck, capability: "source-check" as const }] : []),
		...(fetchContentEnabled ? [{ name: toolNames.fetchContent, capability: "fetch" as const }] : []),
		...(getSearchContentEnabled ? [{ name: toolNames.getSearchContent, capability: "stored-content" as const }] : []),
	], toolActivation);

	const closeCommandCurators = isCommandEnabled(initConfig, "websearch")
		? registerWebSearchCommand(pi, buildSearchReturn) : () => {};
	if (isCommandEnabled(initConfig, "curator")) registerCuratorCommand(pi, toolNames.webSearch);
	if (isCommandEnabled(initConfig, "google-account")) registerGoogleAccountCommand(pi);
	if (isCommandEnabled(initConfig, "search")) registerStoredSearchCommand(pi, ownedResults);
}
