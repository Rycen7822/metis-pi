// Pi command I/O and per-instance command resources. Curator decisions live in
// curator-workflow; the tool host returns its result while this host sends follow-ups.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { startCuratorServer, type CuratorServerHandle, type IndexedCuratorSearchEntry } from "./curator-server.ts";
import { search } from "./search-router.ts";
import type { SearchProvider, SearchProviderSelection } from "./search-providers.ts";
import type { QueryResultData } from "./search-types.ts";
import { getAllResults, deleteHeldResult } from "./storage.ts";
import { loadWebAccessConfig, saveWebAccessConfig } from "./utils.ts";
import { runWithProxy } from "./proxy-transport.ts";
import { generateCuratorSummary, buildCuratedSearchOptions, curatorResultIndex, curatorResultIndexCapacity, toCuratorSearchEntries, indexedCuratorEntryToQueryResult, loadCuratorBootstrap, resolveCuratorSearchProvider, saveDefaultSearchProvider, type CuratorBootstrap } from "./curator-workflow.ts";
import { loadSummaryModelChoices, type SummaryGenerationContext } from "./summary-review.ts";
import { rewriteSearchQuery } from "./query-rewrite.ts";
import { openCuratorBrowserWindow, shouldAutoOpenCuratorBrowser, type GlimpseWindow } from "./curator-browser.ts";
import { normalizeProviderInput, normalizeQueryList, resolveRequestedProvider, runSearchQueries, toCuratorProvider, WEB_SEARCH_CONFIG_PATH, type SearchReturnOptions } from "./web-tool-core.ts";
import { resolveWebSearchWorkflow, type WebSearchWorkflow } from "./curator-run.ts";
import type { WebToolResult } from "./web-tool-contract.ts";
import { isBrowserCookieAccessAllowed } from "./gemini-web-config.ts";
import { getActiveGoogleEmail, getGeminiWebAvailability, getGeminiWebAvailabilityDiagnostic, getGeminiWebAvailabilityDiagnosticDetails } from "./gemini-web.ts";

export function registerWebSearchCommand(pi: ExtensionAPI, buildSearchReturn: (options: SearchReturnOptions) => WebToolResult): () => void {
	let generation = 0;
	const runs = new Map<string, { abort: AbortController; handle: CuratorServerHandle | null; window: GlimpseWindow | null }>();
	function closeCurator(callId: string): void {
		const run = runs.get(callId);
		if (!run) return;
		runs.delete(callId);
		run.abort.abort();
		try { run.window?.close(); } catch {}
		try { run.handle?.close(); } catch {}
	}
	pi.registerCommand("websearch", {
		description: "Open web search curator",
		handler: async (args, ctx) => {
			const sessionToken = randomUUID();
			const commandCallId = `cmd:${sessionToken}`;
			const currentGeneration = generation;

			const raw = args.trim();
			const queries = raw.length > 0
				? normalizeQueryList(raw.split(","))
				: [];

			let bootstrap: CuratorBootstrap;
			try {
				bootstrap = await loadCuratorBootstrap(resolveRequestedProvider(undefined), ctx);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to load web search config: ${message}`, "error");
				return;
			}
			const availableProviders = bootstrap.availableProviders;
			const initialProvider = bootstrap.defaultProvider;
			const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
			const commandConfig = loadWebAccessConfig();
			const rawSearchProvider = normalizeProviderInput(
				commandConfig.searchProvider ?? commandConfig.provider ?? "auto",
				`provider in ${WEB_SEARCH_CONFIG_PATH}`,
			) ?? "auto";
			let currentSearchProvider: SearchProviderSelection = Array.isArray(rawSearchProvider)
				? rawSearchProvider
				: rawSearchProvider === "auto" ? "auto" : initialProvider;
			const summaryContext: SummaryGenerationContext = {
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				sessionManager: ctx.sessionManager,
				scopedModels: ctx.scopedModels,
			};
			const summaryModelChoices = await loadSummaryModelChoices(summaryContext);
			if (generation !== currentGeneration) return;

			ctx.ui.notify("Opening web search curator...", "info");

			const collected = new Map<number, QueryResultData>();
			const searchAbort = new AbortController();
			let aborted = false;
			const run = { abort: searchAbort, handle: null as CuratorServerHandle | null, window: null as GlimpseWindow | null };
			runs.set(commandCallId, run);
			const isCommandActive = () => runs.get(commandCallId) === run;

			function sendFollowUpFromReturn(payload: ReturnType<typeof buildSearchReturn>) {
				pi.sendMessage({
					customType: "web-search-results",
					content: payload.content,
					display: true,
					details: payload.details,
				}, { triggerTurn: true, deliverAs: "followUp" });
			}

			try {
				const handle = await startCuratorServer(
					{
						queries,
						initialResultIndexCapacity: curatorResultIndexCapacity(queries.length),
						sessionToken,
						timeout: curatorTimeoutSeconds,
						availableProviders,
						defaultProvider: initialProvider,
						searchProvider: toCuratorProvider(currentSearchProvider) ?? "auto",
						summaryModels: summaryModelChoices.summaryModels,
						defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
						summaryModelError: summaryModelChoices.summaryModelError,
					},
					{
						async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
							if (!isCommandActive()) {
								throw new Error("Curator session is no longer active.");
							}
							return generateCuratorSummary(
								selectedQueryIndices,
								collected,
								summaryContext,
								summarizeSignal,
								model,
								feedback,
							);
						},
						onSubmit(payload) {
							if (!isCommandActive()) return;
							aborted = true;
							searchAbort.abort();
							sendFollowUpFromReturn(buildSearchReturn({
								...buildCuratedSearchOptions(collected, payload), includeContent: false,
							}));
							closeCurator(commandCallId);
						},
						onCancel(reason) {
							if (!isCommandActive()) return;
							aborted = true;
							searchAbort.abort();
							if (reason === "timeout") {
								sendFollowUpFromReturn(buildSearchReturn({
									...buildCuratedSearchOptions(collected, { selectedQueryIndices: [] }), includeContent: false,
								}));
							}
							closeCurator(commandCallId);
						},
						onProviderChange(provider) {
							if (!isCommandActive()) return;
							const normalized = normalizeProviderInput(provider);
							if (!normalized || normalized === "auto" || Array.isArray(normalized)) return;
							currentSearchProvider = normalized;
							try {
								saveDefaultSearchProvider(normalized);
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								console.error(`Failed to persist default provider: ${message}`);
							}
						},
						async onAddSearch(query, provider) {
							return runWithProxy(undefined, async () => {
								if (!isCommandActive()) {
									throw new Error("Curator session is no longer active.");
								}
								const requestedProvider = resolveCuratorSearchProvider(provider, currentSearchProvider);
								const response = await search(query, {
									provider: requestedProvider,
									signal: searchAbort.signal,
									extensionContext: ctx,
								});
								if (!isCommandActive()) {
									throw new Error("Curator session is no longer active.");
								}
								return toCuratorSearchEntries(response);
							});
						},
						onAddSearchResults(entries) {
							if (!isCommandActive()) return;
							for (const entry of entries) {
								collected.set(entry.queryIndex, indexedCuratorEntryToQueryResult(entry));
							}
						},
						async onRewriteQuery(query, rewriteSignal) {
							if (!isCommandActive()) {
								throw new Error("Curator session is no longer active.");
							}
							return rewriteSearchQuery(query, summaryContext, rewriteSignal);
						},
					},
				);

				if (!isCommandActive()) { handle.close(); return; }
				run.handle = handle;
				let browserOpenError: string | null = null;
				if (!shouldAutoOpenCuratorBrowser(loadWebAccessConfig())) {
					ctx.ui.notify(`Search curator is running. Open manually: ${handle.url}`, "info");
				} else {
					try {
						const win = await openCuratorBrowserWindow(pi, handle.url);
						if (!isCommandActive()) { win?.close(); return; }
						if (win) {
							run.window = win;
							win.on("closed", () => {
								if (run.window === win) {
									run.window = null;
									closeCurator(commandCallId);
								}
							});
						}
					} catch (error) { browserOpenError = error instanceof Error ? error.message : String(error); }
					if (browserOpenError) {
						console.error(`Failed to open curator UI: ${browserOpenError}`);
						ctx.ui.notify(`Search curator is running, but the browser did not open automatically. Open manually: ${handle.url}`, "info");
					}
				}

				if (queries.length > 0) {
					(async () => {
						await runSearchQueries(queries, async (query, qi) => {
							if (aborted || !isCommandActive()) return;
							const requestedProvider = currentSearchProvider;
							try {
								const response = await runWithProxy(undefined, () => search(query, {
									provider: requestedProvider,
									signal: searchAbort.signal,
									extensionContext: ctx,
								}));
								if (aborted || !isCommandActive()) return;
								const entries = toCuratorSearchEntries(response);
								for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
									const entry = entries[entryIndex];
									const resultIndex = curatorResultIndex(qi, entryIndex, queries.length);
									const indexedEntry: IndexedCuratorSearchEntry = {
										...entry,
										queryIndex: resultIndex,
										query,
									};
									collected.set(resultIndex, indexedCuratorEntryToQueryResult(indexedEntry));
									if (entry.error) {
										handle.pushError(resultIndex, entry.error, entry.provider, { query, slotIndex: qi });
									} else {
										handle.pushResult(resultIndex, { ...entry, query, slotIndex: qi });
									}
								}
							} catch (err) {
								if (aborted || !isCommandActive()) return;
								const message = err instanceof Error ? err.message : String(err);
								const failedProvider = toCuratorProvider(requestedProvider);
								handle.pushError(qi, message, failedProvider, { query, slotIndex: qi });
								collected.set(qi, { query, answer: "", results: [], error: message, provider: failedProvider });
							}
						});
						if (!aborted && isCommandActive()) handle.searchesDone();
					})();
				} else {
					if (isCommandActive()) handle.searchesDone();
				}
			} catch (err) {
				closeCurator(commandCallId);
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to open curator: ${message}`, "error");
			}
		},
	});

	return () => { generation++; for (const callId of runs.keys()) closeCurator(callId); };
}

export function registerCuratorCommand(pi: ExtensionAPI, webSearchToolName: string): void {
	pi.registerCommand("curator", {
		description: "Toggle or configure the search curator workflow",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			let newWorkflow: WebSearchWorkflow;
			if (arg.length === 0) {
				let current: WebSearchWorkflow = "none";
				try { current = resolveWebSearchWorkflow(loadWebAccessConfig().workflow, true); }
				catch (error) { console.error(`[pi-web-access] ${error instanceof Error ? error.message : String(error)}`); }
				newWorkflow = current === "none" ? "summary-review" : "none";
			} else if (arg === "on") {
				newWorkflow = "summary-review";
			} else if (arg === "off") {
				newWorkflow = "none";
			} else if (arg === "none" || arg === "summary-review" || arg === "auto-summary") {
				newWorkflow = arg;
			} else {
				ctx.ui.notify(`Unknown option: ${arg}. Use on, off, summary-review, or auto-summary.`, "error");
				return;
			}

			try {
				saveWebAccessConfig({ workflow: newWorkflow });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to save config: ${message}`, "error");
				return;
			}

			const label = newWorkflow === "none"
				? `Curator disabled — ${webSearchToolName} will return raw results`
				: newWorkflow === "auto-summary"
					? `Auto-summary enabled — ${webSearchToolName} will generate a summary without opening the curator`
					: `Curator enabled — ${webSearchToolName} will open curator and auto-generate a summary draft`;
			pi.sendMessage({
				customType: "curator-config",
				content: [{ type: "text", text: label }],
				display: true,
				details: { workflow: newWorkflow },
			}, { triggerTurn: false, deliverAs: "followUp" });
		},
	});

}

export function registerGoogleAccountCommand(pi: ExtensionAPI): void {
	pi.registerCommand("google-account", {
		description: "Show the active Google account for Gemini Web",
		handler: async () => {
			if (!isBrowserCookieAccessAllowed()) {
				pi.sendMessage({
					customType: "google-account",
					content: [{ type: "text", text: `Gemini Web browser cookie access is disabled. Set allowBrowserCookies: true in ${WEB_SEARCH_CONFIG_PATH} to enable it.` }],
					display: true,
					details: { available: false, cookieAccessAllowed: false },
				}, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}

			const outcome = await getGeminiWebAvailability();
			const cookies = outcome?.ok ? outcome.cookies : null;
			if (!cookies) {
				const diagnostic = getGeminiWebAvailabilityDiagnostic(outcome);
				const diagnosticDetails = getGeminiWebAvailabilityDiagnosticDetails(outcome);
				const attempted = formatCookieAttempts(diagnosticDetails?.attempts ?? []);
				const text = diagnostic
					? `Gemini Web is unavailable: ${diagnostic}${attempted ? ` Attempted browser profiles: ${attempted}.` : ""}`
					: "Gemini Web is unavailable. Sign into gemini.google.com in a supported Chromium-based browser.";
				pi.sendMessage({
					customType: "google-account",
					content: [{ type: "text", text }],
					display: true,
					details: { available: false, cookieAccessAllowed: true, diagnostic, cookieDiagnostic: diagnosticDetails },
				}, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}

			const email = await getActiveGoogleEmail(cookies);
			const text = email
				? `Active Google account: ${email}`
				: "Gemini Web is available, but the active Google account could not be determined.";

			pi.sendMessage({
				customType: "google-account",
				content: [{ type: "text", text }],
				display: true,
				details: { available: true, email: email ?? null },
			}, { triggerTurn: true, deliverAs: "followUp" });
		},
	});

	function formatCookieAttempts(attempts: { browser: string; profile: string; status: string }[]): string {
		return attempts.map(({ browser, profile, status }) => `${browser}/${profile} (${status})`).join(", ");
	}

}

export function registerStoredSearchCommand(pi: ExtensionAPI, ownedResults: Set<string>): void {
	pi.registerCommand("search", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults().filter((r) => ownedResults.has(r.id));

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && (r.urls || r.urlMetadata)) {
					return `[${r.id.slice(0, 6)}] ${(r.urls ?? r.urlMetadata ?? []).length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteHeldResult(selected.id);
				ownedResults.delete(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && (selected.urls || selected.urlMetadata)) {
					info += "URLs:\n";
					const urlItems = selected.urls ?? selected.urlMetadata ?? [];
					const urls = urlItems.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						const contentLength = "content" in u ? u.content.length : u.contentLength;
						info += `- ${urlDisplay} (${u.error || `${contentLength} chars`})\n`;
					}
					if (urlItems.length > 10) {
						info += `... and ${urlItems.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}
