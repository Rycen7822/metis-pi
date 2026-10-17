import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isMetisConfigTable, readMetisConfig } from "../metis-config.ts";

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
	description?: string;
}

/** Preserve the upstream non-empty guidance override contract. */
function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!isMetisConfigTable(fields)) return {};
	const result: GuidanceFields = {};
	for (const key of ["promptSnippet", "description"] as const) {
		if (typeof fields[key] === "string" && fields[key].length > 0) result[key] = fields[key];
	}
	const rules = fields.promptGuidelines;
	if (Array.isArray(rules) && rules.length > 0 && rules.every(s => typeof s === "string" && s.length > 0)) {
		result.promptGuidelines = rules;
	}
	return result;
}

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

export interface AskUserQuestionConfig {
	enabled?: boolean;
	guidance?: GuidanceFields;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	// Consume modifier prefixes first so the remaining base key can itself be "+".
	let base = spec;
	const modifiers = new Set<string>();
	for (const part of spec.split("+")) {
		if (!MODIFIERS.has(part)) break;
		if (modifiers.has(part)) return false;
		modifiers.add(part);
		base = base.slice(part.length + 1);
	}
	return base.length === 1 ? /[a-z0-9_+\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

// The only compound-word names in SPECIAL_KEYS — first-letter capitalization
// alone would render them "Pageup"/"Pagedown".
const COMPOUND_KEY_DISPLAY: Record<string, string> = {
	pageup: "PageUp",
	pagedown: "PageDown",
};

/**
 * Pretty-print a resolved key spec for UI copy: each `+`-part gets its first
 * character uppercased (`"ctrl+]"` → `"Ctrl+]"`, `"alt+o"` → `"Alt+O"`,
 * `"f9"` → `"F9"`, `"ctrl+pagedown"` → `"Ctrl+PageDown"`). Display-only — key
 * matching always uses the raw lowercase spec (`matchesKey` lowercases ids),
 * so never feed the result back into it.
 */
export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map(
			(part) =>
				COMPOUND_KEY_DISPLAY[part] ??
				(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}

export function loadConfig(): AskUserQuestionConfig {
	const section = readMetisConfig(getAgentDir()).config.askUserQuestion;
	if (!isMetisConfigTable(section)) throw new Error("askUserQuestion must be a TOML table");
	if (typeof section.enabled !== "boolean") throw new Error("askUserQuestion.enabled must be a boolean");
	return {
		enabled: section.enabled,
		collapseKey: typeof section.collapseKey === "string" ? section.collapseKey : undefined,
		guidance: validateGuidanceFields(section.guidance),
	};
}
