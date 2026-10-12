import type { AuthFetchProfile } from "./auth-fetch.ts";
import type { Lookup } from "./ssrf-protection.ts";

/** Names of the search/fetch tools the caller has actually registered, so
 * failure guidance never points at tools that do not exist in the session. */
export interface RegisteredToolNames {
	webSearch?: string;
	fetchContent?: string;
}

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
	mimeType?: string;
	status?: number;
}

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
	mode?: "readable" | "raw" | "answer";
	answerModel?: string;
	authFetchProfile?: AuthFetchProfile;
	toolNames?: RegisteredToolNames;
	/** Optional HTTP(S) or SOCKS proxy URL; routed through the curl-backed transport. */
	proxy?: string;
	/** Reject direct image URLs with this error instead of decoding them with Pi's
	 * resizeImage. Hosts without the Pi runtime set it; Pi leaves it unset. */
	rejectDirectImages?: string;
	/** Custom DNS resolver used for SSRF validation. Primarily a test seam. */
	lookup?: Lookup;
	/** Request injection; URL checks and redirect policy remain owned by extraction. */
	fetch?: typeof globalThis.fetch;
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}
