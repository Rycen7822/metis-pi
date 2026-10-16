import type { QuestionParams } from "./tool/types.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";
import type { QuestionnaireSessionConfig } from "./state/questionnaire-session.ts";

import { type Presentation, resolvePresentation } from "./presentation.ts";

/**
 * Integration tests for the raw `ctx.ui.onTerminalInput` collapse listener.
 * The factory tests drive the component `handleInput` path (the fallback when
 * no raw listener is available); these drive the listener path that pi-tui
 * needs while the overlay is hidden, using the real QuestionnaireSession via
 * the `ctx.ui.custom` factory and a fake OverlayHandle.
 */

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

const CTRL_RBRACKET = "\x1d"; // GS byte — what legacy terminals send for Ctrl+]
const KITTY_CTRL_RBRACKET_PRESS = "\x1b[93;5u";
const KITTY_CTRL_RBRACKET_REPEAT = "\x1b[93;5:2u";
const KITTY_CTRL_RBRACKET_RELEASE = "\x1b[93;5:3u";
const ALT_O = "\x1bo"; // ESC-prefixed 'o' — legacy encoding for Alt+O

const params = {
	questions: [
		{
			question: "Pick one",
			header: "Choice",
			options: [{ label: "Alpha", description: "" }, { label: "Beta", description: "" }],
		},
	],
} satisfies QuestionParams;

interface FakeHandle {
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	isFocused(): boolean;
}

function makeHandle(over: { isFocused?: () => boolean } = {}): FakeHandle {
	let hidden = false;
	return {
		setHidden: (h: boolean) => {
			hidden = h;
		},
		isHidden: () => hidden,
		// Mirrors pi-tui: a visible questionnaire overlay normally has focus;
		// a hidden one never does. Overridable for the other-overlay-on-top case.
		isFocused: over.isFocused ?? (() => !hidden),
	};
}

type RawListener = (data: string) => { consume?: boolean } | undefined;
type SessionComponent = { render(width: number): string[]; handleInput(data: string): void };

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/**
 * Fake `ctx.ui` that mimics interactive-mode wiring: `onTerminalInput` captures
 * the raw listener, `custom` runs the real factory then hands out the overlay
 * handle via `onHandle`, and `script` drives the interaction before resolving.
 */
function driveWithListener(
	handle: FakeHandle,
	script: (done: (v: unknown) => void) => void,
	keybindings: QuestionnaireSessionConfig["keybindings"] = { matches: () => false },
	tui = { requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } },
) {
	const notify = vi.fn();
	const removeListener = vi.fn();
	const listenerRef: { current: RawListener | undefined } = { current: undefined };
	const componentRef: { current: SessionComponent | undefined } = { current: undefined };
	const onTerminalInput = vi.fn((h: RawListener) => {
		listenerRef.current = h;
		return removeListener;
	});
	const custom = vi.fn(
		(
			factory: (
				tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
				theme: typeof identityTheme,
				kb: QuestionnaireSessionConfig["keybindings"],
				done: (v: unknown) => void,
			) => unknown,
			options?: { onHandle?: (handle: FakeHandle) => void },
		) => {
			return new Promise((resolve) => {
				componentRef.current = factory(
					tui,
					identityTheme,
					keybindings,
					resolve,
				) as SessionComponent;
				options?.onHandle?.(handle);
				script(resolve);
			});
		},
	);
	const ctx = { hasUI: true, ui: { custom, onTerminalInput, notify } } as never;
	return { ctx, notify, onTerminalInput, removeListener, listenerRef, componentRef };
}

const configDir = process.env.PI_CODING_AGENT_DIR!;
const configPath = join(configDir, "metis-pi.toml");

function writeCollapseKeyConfig(collapseKey: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, `[askUserQuestion]\ncollapseKey = ${JSON.stringify(collapseKey)}\n`);
}

// The raw listener belongs to the overlay, which a questionnaire uses only as a fallback.
// Holding the inline slot (as a concurrent questionnaire would) routes each case here to it.
let slotHolder: Presentation | undefined;
beforeEach(() => {
	slotHolder = resolvePresentation();
});

afterEach(() => {
	slotHolder?.release?.();
	if (existsSync(configPath)) rmSync(configPath);
});

describe("ask_user_question — raw terminal collapse listener", () => {
	it("reopens the upper hidden questionnaire before a focused lower one can consume its key", async () => {
		const tui = { requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } };
		let upperMounted = false;
		const upperHandle = makeHandle({ isFocused: () => upperMounted && !upperHandle.isHidden() });
		const lowerHandle = makeHandle({ isFocused: () => !lowerHandle.isHidden() && (!upperMounted || upperHandle.isHidden()) });
		let finishLower: (value: unknown) => void = () => {};
		let finishUpper: (value: unknown) => void = () => {};
		const lower = driveWithListener(lowerHandle, done => { finishLower = done; }, undefined, tui);
		const upper = driveWithListener(upperHandle, done => { finishUpper = done; upperMounted = true; }, undefined, tui);
		const tool = register();
		const lowerRun = tool.execute("lower", params as never, undefined, undefined, lower.ctx);
		await vi.waitFor(() => expect(lower.listenerRef.current).toBeDefined());
		const upperRun = tool.execute("upper", params as never, undefined, undefined, upper.ctx);
		try {
			await vi.waitFor(() => expect(upper.listenerRef.current).toBeDefined());
			const press = () => {
				for (const dialog of [lower, upper]) {
					if (dialog.removeListener.mock.calls.length > 0) continue;
					if (dialog.listenerRef.current?.(CTRL_RBRACKET)?.consume) break;
				}
			};
			press();
			expect(upperHandle.isHidden()).toBe(true);
			expect(lowerHandle.isHidden()).toBe(false);
			press();
			expect(upperHandle.isHidden()).toBe(false);
			expect(lowerHandle.isHidden()).toBe(false);
			finishUpper({ answers: [], cancelled: true });
			await upperRun;
			upperMounted = false;
			press();
			expect(lowerHandle.isHidden()).toBe(true);
			press();
			expect(lowerHandle.isHidden()).toBe(false);
		} finally {
			finishLower({ answers: [], cancelled: true });
			finishUpper({ answers: [], cancelled: true });
			await Promise.all([lowerRun, upperRun]);
		}
		expect(lower.removeListener).toHaveBeenCalledTimes(1);
		expect(upper.removeListener).toHaveBeenCalledTimes(1);
	});

	it.each([
		["escape", "\x1b", "tui.select.cancel"], ["ctrl+]", CTRL_RBRACKET, "tui.select.cancel"],
		["enter", "\r", "tui.select.confirm"], ["return", "\r", "tui.input.submit"],
	])("preserves %s's primary action instead of collapsing", async (collapseKey, data, action) => {
		writeCollapseKeyConfig(collapseKey);
		const handle = makeHandle();
		const tool = register();
		const { ctx, listenerRef, componentRef } = driveWithListener(handle, () => {
			expect(listenerRef.current?.(data)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			componentRef.current?.handleInput(data);
		}, { matches: (key, name) => name === action && key === data });
		const result = await tool.execute("tc", params as never, undefined, undefined, ctx);
		expect(result.details).toMatchObject(action === "tui.select.cancel"
			? { cancelled: true } : { cancelled: false, answers: [{ answer: "Alpha" }] });
	});

	it("hides via OverlayHandle.setHidden, notifies once, and unhides on the second press", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, notify, removeListener, listenerRef } = driveWithListener(handle, (done) => {
			// First press: hide + one-shot notification with the reopen key.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("press Ctrl+] to reopen"), "info");
			// Second press: unhide, and the notification stays one-shot.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(false);
			// Third round-trip re-hides without a second announcement.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(notify).toHaveBeenCalledTimes(1);
			done({ answers: [], cancelled: true });
		});
		await tool.execute("tc", params as never, undefined, undefined, ctx);
		// execute's finally must tear the raw listener down once the tool resolves.
		expect(removeListener).toHaveBeenCalledTimes(1);
	});

	it("toggles once for Kitty keyboard press, repeat, and release events", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_PRESS)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);

			// Repeat and release still belong to the collapse binding, so consume them
			// without toggling or leaking them into the newly focused chat editor.
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_REPEAT)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_RELEASE)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);

			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_PRESS)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute("tc", params as never, undefined, undefined, ctx);
	});

	it("ignores non-matching keys", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, notify, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.("x")).toBeUndefined();
			expect(listenerRef.current?.(ALT_O)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(notify).not.toHaveBeenCalled();
			done({ answers: [], cancelled: true });
		});
		await tool.execute("tc", params as never, undefined, undefined, ctx);
	});

	it("leaves the key to another focused overlay (visible but unfocused questionnaire)", async () => {
		const tool = register();
		// e.g. `/btw` opened on top: the questionnaire is visible underneath but
		// not focused — the listener must not toggle it from under the top overlay.
		const handle = makeHandle({ isFocused: () => false });
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute("tc", params as never, undefined, undefined, ctx);
	});

	it("host with an overlay handle but no raw input keeps the overlay visible on collapse (fallback row, no trap)", async () => {
		// A host that delivers onHandle but not onTerminalInput has exactly one input
		// path: the component's handleInput — which pi-tui does not deliver to a hidden
		// overlay. If collapsing hid the overlay here, nothing could ever reopen it, so
		// the session must suppress setHidden and rely on the one-line collapsed row.
		const tool = register();
		const handle = makeHandle();
		const componentRef: { current: SessionComponent | undefined } = { current: undefined };
		const custom = vi.fn(
			(
				factory: (
					tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
					theme: typeof identityTheme,
					kb: QuestionnaireSessionConfig["keybindings"],
					done: (v: unknown) => void,
				) => unknown,
				options?: { onHandle?: (handle: FakeHandle) => void },
			) => {
				return new Promise((resolve) => {
					componentRef.current = factory(
						{ requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } },
						identityTheme,
						{ matches: () => false },
						resolve,
					) as SessionComponent;
					options?.onHandle?.(handle);
					componentRef.current.handleInput(CTRL_RBRACKET);
					expect(handle.isHidden()).toBe(false);
					const collapsed = componentRef.current.render(120);
					expect(collapsed).toHaveLength(1);
					expect(collapsed[0]).toContain("Ctrl+] to expand");
					// The visible row still routes input, so the same key expands it again.
					componentRef.current.handleInput(CTRL_RBRACKET);
					expect(componentRef.current.render(120).length).toBeGreaterThan(1);
					resolve({ answers: [], cancelled: true });
				});
			},
		);
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute("tc", params as never, undefined, undefined, ctx);
	});

	it("honours a configured collapseKey (alt+o toggles, ctrl+] does not)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const handle = makeHandle();
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(listenerRef.current?.(ALT_O)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			done({ answers: [], cancelled: true });
		});
		await tool.execute("tc", params as never, undefined, undefined, ctx);
	});

	it("footer hint and collapsed row name the configured collapseKey (#176)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const handle = makeHandle();
		const { ctx, componentRef } = driveWithListener(handle, (done) => {
			const expanded = componentRef.current!.render(120).join("\n");
			expect(expanded).toContain("Alt+O to collapse");
			expect(expanded).not.toContain("Ctrl+]");
			// Collapse via the component input path — the one-line footer must name
			// the same key the router actually honours.
			componentRef.current!.handleInput(ALT_O);
			const collapsed = componentRef.current!.render(120);
			expect(collapsed).toHaveLength(1);
			expect(collapsed[0]).toContain("Alt+O to expand");
			done({ answers: [], cancelled: true });
		});
		await tool.execute("tc", params as never, undefined, undefined, ctx);
	});

	it("does not register a listener when collapseKey is 'off'", async () => {
		writeCollapseKeyConfig("off");
		const tool = register();
		const handle = makeHandle();
		const { ctx, onTerminalInput, componentRef } = driveWithListener(handle, (done) => {
			// The footer must not advertise a collapse shortcut that cannot fire (#176).
			const rendered = componentRef.current!.render(120).join("\n");
			expect(rendered).not.toContain("to collapse");
			expect(rendered).toContain("Esc to cancel");
			done({ answers: [], cancelled: true });
		});
		await tool.execute("tc", params as never, undefined, undefined, ctx);
		expect(onTerminalInput).not.toHaveBeenCalled();
	});
});
