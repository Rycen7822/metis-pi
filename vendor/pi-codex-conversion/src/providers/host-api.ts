import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

// Pi aliases pi-ai's root to compat.js, which cannot resolve API subpaths.
// Resolve the running host's public export without installing a second pi-ai.
const host = pathToFileURL(join(getPackageDir(), "package.json"));
const manifest = findPackageJSON("@earendil-works/pi-ai/api/constrained-sampling", host);
if (!manifest) throw new Error("Pi 0.87.0 or newer must provide the provider APIs");
const { exports: entries } = JSON.parse(readFileSync(manifest, "utf8")) as {
	exports: Record<string, string | { import?: string }>;
};
const requireHost = createRequire(host);

function loadModule(group: "api" | "utils", name: string): unknown {
	const entry = entries[`./${group}/${name}`] ?? entries[`./${group}/*`];
	const target = typeof entry === "string" ? entry : entry?.import;
	if (!target) throw new Error(`Pi must expose ${group}/${name} as an import entry`);
	return requireHost(join(dirname(manifest!), target.replace("*", name)));
}

export const {
	getGrammarToolInput,
	createGrammarToolInputProperties,
} = loadModule("api", "constrained-sampling") as
	typeof import("@earendil-works/pi-ai/api/constrained-sampling");

export const { convertResponsesTools, processResponsesStream } = loadModule("api", "openai-responses-shared") as
	typeof import("@earendil-works/pi-ai/api/openai-responses-shared");
export const { parseStreamingJson } = loadModule("utils", "json-parse") as
	typeof import("@earendil-works/pi-ai/utils/json-parse");
