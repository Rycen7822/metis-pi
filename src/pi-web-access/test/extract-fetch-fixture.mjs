import { registerHooks } from "node:module";

export let extractFetch;

// Pi entry wiring stays real; only its extraction transport receives the fixture.
export function injectExtractFetch(fetch) {
	extractFetch = fetch;
	const extractUrl = new URL("../extract.ts", import.meta.url).href;
	const actualUrl = `${extractUrl}?explicit-fetch-fixture`;
	const source = `
		import * as actual from ${JSON.stringify(actualUrl)};
		import { extractFetch } from ${JSON.stringify(import.meta.url)};
		export * from ${JSON.stringify(actualUrl)};
		export function extractContent(url, signal, options) {
			return actual.extractContent(url, signal, { ...options, fetch: extractFetch });
		}
		export function fetchAllContent(urls, signal, options) {
			return actual.fetchAllContent(urls, signal, { ...options, fetch: extractFetch });
		}
	`;
	const hook = registerHooks({
		load(url, context, nextLoad) {
			return url === extractUrl
				? { format: "module", shortCircuit: true, source }
				: nextLoad(url, context);
		},
	});
	return {
		setFetch(fetch) { extractFetch = fetch; },
		dispose() { hook.deregister(); extractFetch = undefined; },
	};
}
