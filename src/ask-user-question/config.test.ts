import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MetisConfigError } from "../metis-config.ts";
import {
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	formatKeySpecForDisplay,
	loadConfig,
	resolveCollapseKey,
} from "./config.ts";

describe("formatKeySpecForDisplay", () => {
	it("capitalizes each +-part of a resolved spec", () => {
		expect(formatKeySpecForDisplay("ctrl+]")).toBe("Ctrl+]");
		expect(formatKeySpecForDisplay("alt+o")).toBe("Alt+O");
		expect(formatKeySpecForDisplay("ctrl+shift+h")).toBe("Ctrl+Shift+H");
	});

	it("handles named special keys and bare keys", () => {
		expect(formatKeySpecForDisplay("f9")).toBe("F9");
		expect(formatKeySpecForDisplay("alt+escape")).toBe("Alt+Escape");
		expect(formatKeySpecForDisplay("]")).toBe("]");
	});

	it("cases compound-word named keys conventionally", () => {
		expect(formatKeySpecForDisplay("ctrl+pagedown")).toBe("Ctrl+PageDown");
		expect(formatKeySpecForDisplay("pageup")).toBe("PageUp");
	});

	it("round-trips the default key to the historical hint casing", () => {
		expect(formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY)).toBe("Ctrl+]");
	});
});

describe("resolveCollapseKey", () => {
	it("returns the default when config has no collapseKey", () => {
		expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: undefined })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns the default when collapseKey is empty or whitespace", () => {
		expect(resolveCollapseKey({ collapseKey: "" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "   " })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("normalizes the spec (trim + lowercase)", () => {
		expect(resolveCollapseKey({ collapseKey: "  Ctrl+}  " })).toBe("ctrl+}");
		expect(resolveCollapseKey({ collapseKey: "ALT+O" })).toBe("alt+o");
	});

	it("returns the off sentinel unchanged (case-insensitive)", () => {
		expect(resolveCollapseKey({ collapseKey: "off" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "OFF" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "  off  " })).toBe(COLLAPSE_KEY_OFF);
	});

	it("falls back to the default for malformed specs", () => {
		// Leading/trailing +, double ++, or empty
		expect(resolveCollapseKey({ collapseKey: "+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl++" })).toBe(DEFAULT_COLLAPSE_KEY);
		// The default itself is valid
		expect(resolveCollapseKey({ collapseKey: "ctrl+]" })).toBe("ctrl+]");
		// Multi-modifier specs are valid
		expect(resolveCollapseKey({ collapseKey: "ctrl+shift+h" })).toBe("ctrl+shift+h");
	});

	it("falls back to the default for typo'd modifiers and unknown key names", () => {
		// `ctr+]` is the dangerous one: pi-tui's parseKeyId takes the LAST `+`-part as
		// the key and ignores unknown parts, so an unvalidated `ctr+]` would match every
		// bare `]` keypress and the raw terminal listener would consume them globally.
		expect(resolveCollapseKey({ collapseKey: "ctr+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "control+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+nosuchkey" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "hello" })).toBe(DEFAULT_COLLAPSE_KEY);
		// Duplicate modifiers are not part of the KeyId grammar
		expect(resolveCollapseKey({ collapseKey: "ctrl+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("accepts named special keys and bare base keys", () => {
		expect(resolveCollapseKey({ collapseKey: "ctrl+pageup" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "Ctrl+PageUp" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "f5" })).toBe("f5");
		expect(resolveCollapseKey({ collapseKey: "alt+escape" })).toBe("alt+escape");
	});
});

describe("loadConfig", () => {
	// Each Vitest worker uses a disposable global agent directory.
	const configPath = join(process.env.PI_CODING_AGENT_DIR!, "metis-pi.toml");

	// Neither the production agent directory nor personal JSON is touched.
	const removeConfig = (): void => {
		if (existsSync(configPath)) rmSync(configPath);
	};

	afterEach(removeConfig);

	it("returns an empty config when no file is present", () => {
		removeConfig();
		expect(loadConfig().collapseKey).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("reads the global TOML config", () => {
		mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
		writeFileSync(configPath, '[askUserQuestion]\ncollapseKey = "alt+o"\n[askUserQuestion.guidance]\npromptSnippet = "x"\n');
		const c = loadConfig();
		expect(c.collapseKey).toBe("alt+o");
		expect(c.guidance?.promptSnippet).toBe("x");
	});
	it("ignores old rpiv JSON even when global TOML is missing", () => {
		const old = join(process.env.HOME!, ".config", "rpiv-ask-user-question");
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, "config.json"), '{"collapseKey":"alt+o","guidance":{"promptSnippet":"OLD_JSON"}}');
		expect(loadConfig().collapseKey).toBe(DEFAULT_COLLAPSE_KEY);
		expect(loadConfig().guidance?.promptSnippet).toBeUndefined();
	});
	it("reports malformed TOML and invalid enable flags rather than falling back", () => {
		writeFileSync(configPath, "[broken");
		expect(() => loadConfig()).toThrow(MetisConfigError);
		writeFileSync(configPath, '[askUserQuestion]\nenabled = "false"\n');
		expect(() => loadConfig()).toThrow(/must be a boolean/);
	});
});
