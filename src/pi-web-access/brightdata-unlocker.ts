import { getWebAccessConfigPath, loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./content.ts";
import { validateRemoteUrl, fetchRemoteUrl, type Lookup } from "./ssrf-protection.ts";

const CONFIG_PATH = getWebSearchConfigPath();
const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";
const EXTRACT_TIMEOUT_MS = 60_000;
const ZONE_PATTERN = /^[a-z0-9_-]+$/i;

export interface BrightDataSsrfOptions {
	allowRanges: string[];
	trustEnvProxy: boolean;
}

export interface BrightDataExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup" | "fetch"> {
	ssrf?: BrightDataSsrfOptions;
}

interface BrightDataConfig {
	brightdataApiKey?: unknown;
	brightdataUnlockerZone?: unknown;
}

let cachedConfig: BrightDataConfig | null = null;

function loadConfig(): BrightDataConfig {
	return cachedConfig ??= loadWebAccessConfig() as BrightDataConfig;
}

export function clearBrightDataUnlockerConfigCache(): void {
	cachedConfig = null;
}

function normalizeZone(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return ZONE_PATTERN.test(trimmed) ? trimmed : null;
}

interface ZoneSetting {
	raw: string;
	label: string;
}

function zoneSetting(): ZoneSetting | null {
	const fromEnv = process.env.BRIGHTDATA_UNLOCKER_ZONE;
	if (typeof fromEnv === "string" && fromEnv.trim()) return { raw: fromEnv.trim(), label: "BRIGHTDATA_UNLOCKER_ZONE" };
	const configured = loadConfig().brightdataUnlockerZone;
	if (typeof configured === "string" && configured.trim()) {
		return { raw: configured.trim(), label: `brightdataUnlockerZone in ${getWebAccessConfigPath()}` };
	}
	return null;
}

function getZone(): string | null {
	const setting = zoneSetting();
	return setting ? normalizeZone(setting.raw) : null;
}

// A zone is never defaulted. Zones are per-account names bound to a product
// type, they are billed separately, and a guess is either an HTTP 400 or a
// charge against the wrong product. The SERP zone from the search provider is
// a different zone type and cannot serve Web Unlocker requests.
function requireZone(): string {
	const setting = zoneSetting();
	const zone = setting ? normalizeZone(setting.raw) : null;
	if (zone) return zone;
	if (setting) {
		throw new Error(
			`Invalid Bright Data Unlocker zone: ${setting.label} must be a zone name of letters, digits, "-", or "_". ` +
			"The zone must be of type \"unblocker\"; a SERP zone will not serve Web Unlocker requests.",
		);
	}
	throw new Error(
		"Bright Data Web Unlocker zone not configured. Either:\n" +
		`  1. Set brightdataUnlockerZone in ${getWebAccessConfigPath()}\n` +
		"  2. Set BRIGHTDATA_UNLOCKER_ZONE environment variable\n" +
		"The zone must be of type \"unblocker\"; a SERP zone will not serve Web Unlocker requests.",
	);
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await resolveCredential({
		provider: "Bright Data",
		configuredValue: loadConfig().brightdataApiKey,
		environmentValue: process.env.BRIGHTDATA_API_KEY,
		signal,
	});
	if (!apiKey) {
		throw new Error(
			"Bright Data API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "brightdataApiKey": "your-key" }\n` +
			"  2. Set BRIGHTDATA_API_KEY environment variable\n" +
			"Get a key at https://brightdata.com/cp/setting/users",
		);
	}
	return apiKey;
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function ssrfOptions(options?: BrightDataExtractOptions): { lookup?: Lookup; allowRanges: string[]; trustEnvProxy: boolean } {
	return {
		allowRanges: options?.ssrf?.allowRanges ?? [],
		trustEnvProxy: options?.ssrf?.trustEnvProxy ?? false,
		...(options?.lookup ? { lookup: options.lookup } : {}),
	};
}

async function fetchBrightDataApi(
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
	options: BrightDataExtractOptions | undefined,
): Promise<Response> {
	return fetchRemoteUrl(url, init, {
		...ssrfOptions(options),
		fetch: options?.fetch,
		onRedirect: ({ from, to, init: next }) => {
			const headers = new Headers(next.headers);
			if (from.origin !== to.origin) {
				for (const name of ["Authorization", "Cookie", "X-API-Key"]) headers.delete(name);
			}
			// This API's existing redirect contract replays the original POST body, including 303.
			return { ...next, method: init.method, body: init.body, headers };
		},
	});
}

function unlockerBody(url: string, zone: string): Record<string, unknown> {
	return {
		url,
		zone,
		format: "raw",
		data_format: "markdown",
	};
}

async function brightDataRequest(
	url: string,
	zone: string,
	signal: AbortSignal | undefined,
	options: BrightDataExtractOptions | undefined,
): Promise<string> {
	const apiKey = await getApiKey(signal);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	try {
		const response = await fetchBrightDataApi(BRIGHTDATA_REQUEST_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(unlockerBody(url, zone)),
			signal: requestSignal(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS, signal),
		}, options);
		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(`Bright Data Web Unlocker error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		const text = await response.text();
		activityMonitor.logComplete(activityId, response.status);
		return text;
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}

function headingTitle(text: string): string {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return "";
	return match[1].replace(/\*+/g, "").trim();
}

export function isBrightDataUnlockerAvailable(): boolean {
	if (getZone() === null) return false;
	return hasCredentialSource({
		provider: "Bright Data",
		configuredValue: loadConfig().brightdataApiKey,
		environmentValue: process.env.BRIGHTDATA_API_KEY,
	});
}

export async function extractWithBrightDataUnlocker(
	url: string,
	signal?: AbortSignal,
	options?: BrightDataExtractOptions,
): Promise<ExtractedContent | null> {
	const zone = requireZone();
	await validateRemoteUrl(url, ssrfOptions(options));
	const raw = await brightDataRequest(url, zone, signal, options);
	// Bright Data bills a successful request whatever its length, so short
	// content is returned rather than discarded: a paywall stub or consent page
	// is a useful answer, and silently dropping it would hide the spend.
	const content = raw.trim();
	if (!content) return null;
	return { url, title: headingTitle(content), content, error: null };
}
