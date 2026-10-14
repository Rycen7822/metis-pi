import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	Theme,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { MockTheme } from "./theme.ts";

/** A captured `registerShortcut` registration (KeyId → handler). */
export interface CapturedShortcut {
	description?: string;
	handler: (ctx: unknown) => Promise<void> | void;
}

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	/** Keyboard shortcuts registered via `pi.registerShortcut(keyId, opts)`. */
	shortcuts: Map<string, CapturedShortcut>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
	allTools: ToolInfo[];
	/** Custom entries appended via `pi.appendEntry(customType, data)`, in call order. */
	entries: Array<{ customType: string; data: unknown }>;
}

export interface MockPi {
	pi: ExtensionAPI;
	captured: CapturedPi;
}

export type CreateMockPiOptions = Partial<ExtensionAPI>;

export function createMockPi(options: CreateMockPiOptions = {}): MockPi {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
		entries: [],
	};

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			const info = { name: tool.name, description: tool.description, parameters: tool.parameters,
				exposure: tool.exposure ?? "direct", sourceInfo: { path: fileURLToPath(new URL("../../../extensions/ask-user-question.ts", import.meta.url)), source: "local", baseDir: "" } } as ToolInfo;
			captured.allTools = [...captured.allTools.filter(t => t.name !== tool.name), info];
			if (tool.exposure === "hidden") captured.activeTools = captured.activeTools.filter(n => n !== tool.name);
			else if ((!tool.exposure || tool.exposure === "direct" || tool.exposure === "model-only") && !captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, cmd);
		}),
		registerShortcut: vi.fn((shortcut: string, opts: CapturedShortcut) => {
			captured.shortcuts.set(shortcut, opts);
		}),
		registerFlag: vi.fn((name: string, value: unknown) => {
			captured.flags.set(name, value);
		}),
		getFlag: vi.fn((name: string) => captured.flags.get(name)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const list = captured.events.get(event) ?? [];
			list.push(handler);
			captured.events.set(event, list);
		}),
		appendEntry: vi.fn((customType: string, data?: unknown) => {
			captured.entries.push({ customType, data });
		}),
		sendMessage: vi.fn(async () => {}),
		sendUserMessage: vi.fn((_content: unknown, _options?: unknown) => {
			// Sync fire-and-forget; callers assert directly on this spy.
		}),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium" as unknown as string),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const list = captured.eventsEmitted.get(channel) ?? [];
				list.push(data);
				captured.eventsEmitted.set(channel, list);
			}),
			on: vi.fn(() => () => {}),
		},
		getCommands: vi.fn(() => []),
		...options,
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

export interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWorkingMessage: ReturnType<typeof vi.fn>;
	setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
	onTerminalInput: ReturnType<typeof vi.fn>;
	pasteToEditor: ReturnType<typeof vi.fn>;
	setEditorComponent: ReturnType<typeof vi.fn>;
	/** Only present when a test passes one in; overlay renders fall back to the factory theme otherwise. */
	theme?: Theme | MockTheme;
}

export function createMockUI(
	overrides: Partial<Omit<ExtensionUIContext, "theme">> & { theme?: Theme | MockTheme } = {},
): MockUI {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		pasteToEditor: vi.fn(),
		setEditorComponent: vi.fn(),
		...overrides,
	} as unknown as MockUI;
}

export function createMockSessionManager(
	branch: SessionEntry[] = [],
	sessionId = "test-session",
	sessionName?: string,
) {
	return {
		getBranch: vi.fn(() => branch),
		getEntries: vi.fn(() => branch),
		getLeafId: vi.fn(() => (branch.length ? branch[branch.length - 1].id : null)),
		getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
		getSessionId: vi.fn(() => sessionId),
		// Pi reports an UNNAMED session as `undefined`, so the default mirrors a
		// session the user never renamed.
		getSessionName: vi.fn(() => sessionName),
	};
}

export function createMockModelRegistry(models: Model<Api>[] = []) {
	return {
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => [...models]),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
	};
}

export interface MockCtxOptions {
	hasUI?: boolean;
	/** Host mode the ctx advertises (`"rpc"` for ACP hosts). */
	mode?: string;
	cwd?: string;
	model?: Model<Api>;
	branch?: SessionEntry[];
	models?: Model<Api>[];
	ui?: Partial<ExtensionUIContext>;
	/** Session id the ctx advertises via `sessionManager.getSessionId()`. Defaults to "test-session". */
	sessionId?: string;
	/** Display name the ctx advertises via `sessionManager.getSessionName()`. Omitted = unnamed session. */
	sessionName?: string;

}

/** A tool `execute()` ctx (Pi ≥ 1.1: `ExtensionToolContext`), which also satisfies `ExtensionContext`. */
export function createMockCtx(opts: MockCtxOptions = {}): ExtensionToolContext {
	return {
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		model: opts.model,
		ui: createMockUI(opts.ui),
		sessionManager: createMockSessionManager(opts.branch ?? [], opts.sessionId, opts.sessionName),
		modelRegistry: createMockModelRegistry(opts.models ?? []),
		isIdle: vi.fn(() => true),
		tools: [],
		executeTool: vi.fn(),
	} as unknown as ExtensionToolContext;
}
