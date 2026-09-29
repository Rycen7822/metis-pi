import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

// Pi aliases pi-ai's root to compat.js, which cannot resolve API subpaths.
// Resolve the running host's public export without installing a second pi-ai.
const host = pathToFileURL(join(getPackageDir(), "package.json"));
const manifest = findPackageJSON("@earendil-works/pi-ai/api/constrained-sampling", host);
if (!manifest) throw new Error("Pi 0.87.0 or newer must provide the sampling API");
const { exports: entries } = JSON.parse(readFileSync(manifest, "utf8")) as {
	exports: Record<string, string | { import?: string }>;
};
const entry = entries["./api/constrained-sampling"] ?? entries["./api/*"];
const target = typeof entry === "string" ? entry : entry?.import;
if (!target) throw new Error("Pi's sampling API must expose an import entry");

export const {
	makeStrictJsonSchema,
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
	getGrammarToolInput,
	appendGrammarToolInputJsonDelta,
	resolveGrammarConstrainedSampling,
	createGrammarToolInputProperties,
} = createRequire(host)(join(dirname(manifest), target.replace("*", "constrained-sampling"))) as
	typeof import("@earendil-works/pi-ai/api/constrained-sampling");

export type {
	GrammarConstrainedSampling,
	GrammarToolInputJsonBuffer,
} from "@earendil-works/pi-ai/api/constrained-sampling";
