import type {
	ExtensionAPI,
	ExtensionToolContext,
	ExtensionUIContext,
	Theme,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { MockTheme } from "./theme.ts";

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
	allTools: ToolInfo[];
}

export interface MockPi {
	pi: ExtensionAPI;
	captured: CapturedPi;
}

export type CreateMockPiOptions = Partial<ExtensionAPI>;

export function createMockPi(options: CreateMockPiOptions = {}): MockPi {
	const captured: CapturedPi = {
		tools: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
	};

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			const info = {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				exposure: tool.exposure ?? "direct",
				sourceInfo: {
					path: fileURLToPath(new URL("../../../extensions/ask-user-question.ts", import.meta.url)),
					source: "local", baseDir: "",
				},
			} as ToolInfo;
			captured.allTools = [...captured.allTools.filter(t => t.name !== tool.name), info];
			if (tool.exposure === "hidden") captured.activeTools = captured.activeTools.filter(n => n !== tool.name);
			else if ((!tool.exposure || tool.exposure === "direct" || tool.exposure === "model-only")
				&& !captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const list = captured.events.get(event) ?? [];
			list.push(handler);
			captured.events.set(event, list);
		}),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const list = captured.eventsEmitted.get(channel) ?? [];
				list.push(data);
				captured.eventsEmitted.set(channel, list);
			}),
			on: vi.fn(() => () => {}),
		},
		...options,
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

export interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	onTerminalInput: ReturnType<typeof vi.fn>;
	/** Only present when a test passes one in; overlay renders fall back to the factory theme otherwise. */
	theme?: Theme | MockTheme;
}

export function createMockUI(
	overrides: Partial<Omit<ExtensionUIContext, "theme">> & { theme?: Theme | MockTheme } = {},
): MockUI {
	return {
		notify: vi.fn(),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		onTerminalInput: vi.fn(() => () => {}),
		...overrides,
	} as unknown as MockUI;
}

export interface MockCtxOptions {
	hasUI?: boolean;
	/** Host mode the ctx advertises (`"rpc"` for ACP hosts). */
	mode?: string;
	cwd?: string;
	ui?: Partial<ExtensionUIContext>;
}

/** Context fields used by the questionnaire tests. */
export function createMockCtx(opts: MockCtxOptions = {}): ExtensionToolContext {
	return {
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		ui: createMockUI(opts.ui),
	} as unknown as ExtensionToolContext;
}
