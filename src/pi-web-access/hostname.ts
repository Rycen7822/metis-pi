import { isIP } from "node:net";

export function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	return normalized === "localhost"
		|| normalized === "::1"
		|| (isIP(normalized) === 4 && normalized.split(".", 1)[0] === "127");
}
