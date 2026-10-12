// Standalone MCP host policy and bounded result ownership. The execution core
// stays shared with Pi; this adapter decides which host-only features to reject.
import { getWebSearchConfigPath } from "./utils.ts";
import { isOpenAISearchAvailable } from "./openai-search.ts";
import { deleteResult, storeResult } from "./storage.ts";
import type { SearchProviderSelection } from "./search-providers.ts";
import type { FetchContentCallParams, WebToolCore, WebToolResult } from "./web-tool-contract.ts";
import { createWebToolCore, DEFAULT_TOOL_NAMES, getMaxInlineContentChars, isToolEnabled, loadConfig, markToolError, resolveFetchModeConfig, resolveRequestedProvider, WEB_SEARCH_CONFIG_PATH, type FetchModeConfig, type ToolNames, type WebToolCoreSettings } from "./web-tool-core.ts";

const MAX_STORED_RESULTS = 50;
const STANDALONE_DIRECT_IMAGE_ERROR = "Direct image fetch is not supported over MCP; fetch_content returns text there. Fetch images from the Pi extension instead.";

export interface StandaloneWebToolCore extends WebToolCore {
	/** Default names of the tools web-search.json enables; hosts list only these. */
	enabledToolNames: string[];
}

function standaloneError(error: string): WebToolResult {
	return { content: [{ type: "text", text: `Error: ${error}` }], details: { error }, isError: true };
}

// Explicit requests for providers that need Pi's model registry or login state
// fail here instead of silently falling back. Automatic selection already skips
// them without a Pi context and picks among the providers usable here.
async function standaloneProviderRejection(requested: unknown): Promise<string | undefined> {
	let selection: SearchProviderSelection;
	try {
		selection = resolveRequestedProvider(requested);
	} catch {
		return undefined; // The core reports the same validation error.
	}
	const explicit: string[] = Array.isArray(selection) ? selection : [selection];
	if (explicit.includes("kimi")) {
		return "Kimi search is not supported over MCP: it authenticates only through Pi's /login kimi-coding. Choose another provider, or search from Pi.";
	}
	if (explicit.includes("openai")) {
		let available: boolean;
		try {
			available = await isOpenAISearchAvailable();
		} catch {
			return undefined; // The core reports the same configuration error.
		}
		if (!available) {
			return `OpenAI search over MCP needs an API key: set openaiApiKey in ${getWebSearchConfigPath()} or OPENAI_API_KEY. ` +
				"ChatGPT/Codex sign-in, openaiUseProviderBaseUrl, and Pi model credentials work only inside Pi.";
		}
	}
	return undefined;
}

function standaloneFetchRejection(params: FetchContentCallParams, fetchModes: FetchModeConfig): string | undefined {
	if (params.mode === "answer") {
		return "fetch_content mode \"answer\" is not supported over MCP: page answers use Pi's models. Use mode \"readable\" or \"raw\".";
	}
	if (params.mode === undefined && fetchModes.defaultMode === "answer") {
		return `fetch.defaultMode in ${WEB_SEARCH_CONFIG_PATH} is "answer", which is not supported over MCP. Pass mode "readable" or "raw".`;
	}
	return undefined;
}

/** Core for hosts without Pi: no extension context, curator, or summaries; results
 * live in a bounded in-memory store; includeContent waits for the page fetch. */
export function createStandaloneWebToolCore(): StandaloneWebToolCore {
	const config = loadConfig();
	const settings: WebToolCoreSettings = {
		toolNames: { ...DEFAULT_TOOL_NAMES },
		enabledTools: {
			webSearch: isToolEnabled(config, "webSearch"),
			sourceCheck: isToolEnabled(config, "sourceCheck"),
			fetchContent: isToolEnabled(config, "fetchContent"),
			getSearchContent: isToolEnabled(config, "getSearchContent"),
		},
		maxInlineContentChars: getMaxInlineContentChars(config),
		fetchModes: resolveFetchModeConfig(config),
	};
	const storedIds: string[] = [];
	const remember = (id: string) => {
		storedIds.push(id);
		while (storedIds.length > MAX_STORED_RESULTS) deleteResult(storedIds.shift()!);
	};
	const core = createWebToolCore({
		settings,
		storeFetchedContent(id, data) {
			storeResult(id, data);
			remember(id);
		},
		publishResult(data) {
			remember(data.id);
		},
		extractOptions: { rejectDirectImages: STANDALONE_DIRECT_IMAGE_ERROR },
	});

	return {
		enabledToolNames: (Object.keys(DEFAULT_TOOL_NAMES) as (keyof ToolNames)[])
			.filter((key) => settings.enabledTools[key])
			.map((key) => DEFAULT_TOOL_NAMES[key]),
		async webSearch(params, signal) {
			const rejection = await standaloneProviderRejection(params.provider);
			return rejection ? standaloneError(rejection) : markToolError(await core.webSearch(params, signal));
		},
		async fetchContent(params, signal) {
			const rejection = standaloneFetchRejection(params, settings.fetchModes);
			return rejection ? standaloneError(rejection) : markToolError(await core.fetchContent(params, signal));
		},
		async getSearchContent(params, signal) {
			return markToolError(await core.getSearchContent(params, signal));
		},
		async sourceCheck(params, signal) {
			const rejection = await standaloneProviderRejection(params.provider);
			return rejection ? standaloneError(rejection) : markToolError(await core.sourceCheck(params, signal));
		},
	};
}
