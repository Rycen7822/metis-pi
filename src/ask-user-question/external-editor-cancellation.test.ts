import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";
import { ASK_USER_BLOCKED_EVENT } from "./events.ts";
import { resolvePresentation } from "./presentation.ts";
import type { QuestionnaireSessionComponent } from "./state/questionnaire-session.ts";

const edit = vi.fn();
const editorModule = "./state/external-editor.ts";
beforeEach(() => {
	edit.mockReset();
	vi.doMock(editorModule, () => ({ editWithExternalEditor: edit }));
});
afterEach(() => {
	vi.doUnmock(editorModule);
});

const args = { questions: [{ question: "Approach?", header: "Approach", options: [
	{ label: "First", description: "First approach" },
	{ label: "Second", description: "Second approach" },
] }] };
const theme = {
	fg: (_: string, text: string) => text,
	bg: (_: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
};

function startQuestionnaire() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	let component!: QuestionnaireSessionComponent;
	let mounted!: () => void;
	const ready = new Promise<void>(resolve => { mounted = resolve; });
	// pi-tui supplies editor keys; the Pi host adds this application binding.
	const keys = getKeybindings();
	const keybindings = { matches: (data: string, action: Parameters<typeof keys.matches>[1] | "app.editor.external") =>
		action === "app.editor.external" ? data === "\x07" : keys.matches(data, action) };
	const ctx = createMockCtx({ hasUI: true, ui: {
		custom: vi.fn((factory) => new Promise(resolve => {
			component = factory(
				{ requestRender() {}, terminal: { columns: 120, rows: 24 }, hasOverlay: () => false },
				theme, keybindings, resolve,
			);
			mounted();
		})) as never,
	} });
	ctx.isProjectTrusted = () => true;
	const controller = new AbortController();
	const pending = captured.tools.get("ask_user_question")!.execute(
		"editor", args as never, controller.signal, undefined, ctx,
	);
	return { captured, ctx, controller, pending, ready, edit() {
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x07");
	} };
}

describe("external editor invocation ownership", () => {
	it("does not launch an editor when cancellation arrives during its lazy import", async () => {
		let releaseImport!: () => void;
		let startImport!: () => void;
		const importing = new Promise<void>(resolve => { startImport = resolve; });
		const gate = new Promise<void>(resolve => { releaseImport = resolve; });
		vi.doMock(editorModule, async () => {
			startImport();
			await gate;
			return { editWithExternalEditor: edit };
		});
		const call = startQuestionnaire();
		const outcome = call.pending.catch(error => error);
		try {
			await call.ready;
			call.edit();
			await importing;
			call.controller.abort();
		} finally {
			call.controller.abort();
			releaseImport();
		}
		expect(await outcome).toBeInstanceOf(Error);
		expect(edit).not.toHaveBeenCalled();
		expect(call.ctx.ui.notify).not.toHaveBeenCalled();
		expect(call.captured.eventsEmitted.get(ASK_USER_BLOCKED_EVENT)?.at(-1)).toEqual({ active: false });
	});

	it("keeps the inline slot and blocked event until editor cleanup finishes", async () => {
		let close!: () => void;
		let started!: () => void;
		let signal!: AbortSignal;
		const ready = new Promise<void>(resolve => { started = resolve; });
		edit.mockImplementation((_tui, _command, _value, abortSignal) => {
			signal = abortSignal;
			started();
			return new Promise<string>(resolve => { close = () => resolve("late edit"); });
		});
		const settings = vi.spyOn(SettingsManager, "create").mockReturnValue({
			getExternalEditorCommand: () => "controlled-editor",
		} as never);
		const call = startQuestionnaire();
		const outcome = call.pending.catch(error => error);
		try {
			await call.ready;
			call.edit();
			await ready;
			call.controller.abort();
			expect(signal.aborted).toBe(true);
			expect(call.captured.eventsEmitted.get(ASK_USER_BLOCKED_EVENT)?.at(-1)).toEqual({ active: true });
			expect(resolvePresentation().overlay).toBe(true);
		} finally {
			call.controller.abort();
			close?.();
			settings.mockRestore();
		}
		expect(await outcome).toBeInstanceOf(Error);
		const next = resolvePresentation();
		try {
			expect(next.overlay).toBe(false);
			expect(call.ctx.ui.notify).not.toHaveBeenCalled();
			expect(call.captured.eventsEmitted.get(ASK_USER_BLOCKED_EVENT)?.at(-1)).toEqual({ active: false });
		} finally {
			next.release?.();
		}
	});
});
