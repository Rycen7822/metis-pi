// Derived from mitsuhiko/agent-stuff extensions/btw.ts (Apache-2.0).
// Source revision and local maintenance scope are recorded in NOTICE.
import {
	buildSessionContext,
	createAgentSession,
	createExtensionRuntime,
	getMarkdownTheme,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type Message, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import {
	Container,
	Input,
	Markdown,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";

const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"Be direct and practical.",
].join(" ");

const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";

type SessionThinkingLevel = "off" | AiThinkingLevel;

type BtwDetails = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	thinkingLevel: SessionThinkingLevel;
	usage?: AssistantMessage["usage"];
};

type BtwResetDetails = {
	timestamp: number;
};

type OverlayRuntime = {
	handle?: OverlayHandle;
	view?: BtwOverlay;
	finish?: () => void;
	closed: boolean;
};

type SideSessionRuntime = {
	session: AgentSession;
	modelKey: string;
	unsubscribe: () => void;
};

type ToolCallInfo = {
	toolName: string;
	args: string;
	status: "running" | "done" | "error";
};

type PendingReply = {
	question: string;
	answer: string;
	error: string | null;
	tools: ToolCallInfo[];
	busy: boolean;
};

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function createBtwResourceLoader(ctx: ExtensionContext, appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT]): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => appendSystemPrompt,
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function parentModelRuntime(ctx: ExtensionContext): ModelRuntime {
	// Pi 1.4 exposes a registry facade to extensions but requires its native
	// runtime for child sessions. Borrow that owner read-only; never copy auth
	// or silently fall back to a new runtime when this host contract changes.
	const runtime = Reflect.get(ctx.modelRegistry, "runtime");
	if (!(runtime instanceof ModelRuntime)) {
		throw new Error("BTW requires the Pi 1.4 model runtime.");
	}
	return runtime;
}

function extractText(parts: AssistantMessage["content"]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	return session.state.messages.findLast((message) => message.role === "assistant") ?? null;
}

function buildSeedMessages(ctx: ExtensionContext, thread: BtwDetails[]): Message[] {
	const seed: Message[] = [];

	try {
		const contextMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
		seed.push(...(contextMessages.filter((message) => "role" in message) as Message[]));
	} catch {
		// Ignore context seed failures and continue with an empty side thread.
	}

	for (const item of thread) {
		seed.push(
			{
				role: "user",
				content: [{ type: "text", text: item.question }],
				timestamp: item.timestamp,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: item.answer }],
				provider: item.provider,
				model: item.model,
				api: ctx.model?.api ?? "openai-responses",
				usage:
					item.usage ??
					{
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				stopReason: "stop",
				timestamp: item.timestamp,
			},
		);
	}

	return seed;
}

function formatThread(thread: BtwDetails[]): string {
	return thread
		.map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`)
		.join("\n\n---\n\n");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}


class BtwOverlay extends Container implements Focusable {
	private readonly input = new Input();

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly keybindings: KeybindingsManager,
		private readonly getTranscript: (width: number, theme: ExtensionContext["ui"]["theme"]) => string[],
		private readonly getStatus: () => string,
		onSubmit: (value: string) => void,
		private readonly onDismiss: () => void,
	) {
		super();
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onDismiss;
	}

	refresh(focused: boolean): void {
		this.focused = focused;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDismiss();
			return;
		}

		this.input.handleInput(data);
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	override render(width: number): string[] {
		const dialogWidth = Math.max(56, Math.min(width, Math.floor(width * 0.9)));
		const innerWidth = Math.max(40, dialogWidth - 2);
		const terminalRows = process.stdout.rows ?? 30;
		const dialogHeight = Math.max(16, Math.min(30, Math.floor(terminalRows * 0.75)));
		const chromeHeight = 7;
		const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);

		// Markdown renders to innerWidth already — no manual wrapping needed
		const transcript = this.getTranscript(innerWidth, this.theme);
		const visibleTranscript = transcript.slice(-transcriptHeight);
		const transcriptPadding = Math.max(0, transcriptHeight - visibleTranscript.length);

		const status = this.getStatus();

		const previousFocused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(innerWidth)[0] ?? "";
		this.input.focused = previousFocused;

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(" BTW side chat ")), innerWidth),
			this.frameLine(this.theme.fg("dim", "Separate side conversation. Esc closes."), innerWidth),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
		];

		for (const line of visibleTranscript) {
			lines.push(this.frameLine(line, innerWidth));
		}
		for (let i = 0; i < transcriptPadding; i++) {
			lines.push(this.frameLine("", innerWidth));
		}

		lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
		lines.push(this.frameLine(this.theme.fg("warning", status), innerWidth));
		lines.push(
			`${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`,
		);
		lines.push(this.frameLine(this.theme.fg("dim", "Enter submit · Esc close"), innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let thread: BtwDetails[] = [];
	let pending: PendingReply | null = null;
	let overlayStatus = "Ready";
	let overlayDraft = "";
	let overlayRuntime: OverlayRuntime | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	const mdTheme = getMarkdownTheme();

	function renderMarkdownLines(text: string, width: number): string[] {
		if (!text) return [];
		try {
			const md = new Markdown(text, 0, 0, mdTheme);
			return md.render(width);
		} catch {
			// Fall back to plain text wrapping if Markdown rendering fails
			return text.split("\n").flatMap((line) => {
				if (!line) return [""];
				const wrapped: string[] = [];
				for (let i = 0; i < line.length; i += width) {
					wrapped.push(line.slice(i, i + width));
				}
				return wrapped.length > 0 ? wrapped : [""];
			});
		}
	}

	function formatToolArgs(toolName: string, args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		switch (toolName) {
			case "bash":
				return typeof a.command === "string" ? truncateToWidth(a.command.split("\n")[0], 50, "…") : "";
			case "read":
			case "write":
			case "edit":
				return typeof a.path === "string" ? a.path : "";
			default: {
				const first = Object.values(a)[0];
				return typeof first === "string" ? truncateToWidth(first.split("\n")[0], 40, "…") : "";
			}
		}
	}

	function renderToolCallLines(toolCalls: ToolCallInfo[], theme: ExtensionContext["ui"]["theme"], width: number): string[] {
		const lines: string[] = [];
		for (const tc of toolCalls) {
			const icon = tc.status === "running" ? "⚙" : tc.status === "error" ? "✗" : "✓";
			const color = tc.status === "error" ? "error" : tc.status === "done" ? "success" : "dim";
			const label = theme.fg(color, `${icon} `) + theme.fg("toolTitle", tc.toolName);
			const argsText = tc.args ? theme.fg("dim", ` ${tc.args}`) : "";
			lines.push(truncateToWidth(`  ${label}${argsText}`, width, ""));
		}
		return lines;
	}

	function getTranscriptLines(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		try {
			if (thread.length === 0 && !pending) {
				return [theme.fg("dim", "No BTW messages yet. Type a question below.")];
			}

			const lines: string[] = [];
			for (const item of thread.slice(-6)) {
				const userText = item.question.trim().split("\n")[0];
				lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));
				lines.push("", ...renderMarkdownLines(item.answer, width), "");
			}

			if (pending) {
				const userText = pending.question.trim().split("\n")[0];
				lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));
				lines.push(...renderToolCallLines(pending.tools, theme, width));
				if (pending.error) {
					lines.push(theme.fg("error", `❌ ${pending.error}`));
				} else if (pending.answer) {
					lines.push("", ...renderMarkdownLines(pending.answer, width));
				} else if (pending.tools.length === 0) {
					lines.push(theme.fg("dim", "…"));
				}
			}

			while (lines.at(-1) === "") lines.pop();
			return lines;
		} catch (error) {
			return [theme.fg("error", `Render error: ${error instanceof Error ? error.message : String(error)}`)];
		}
	}

	function syncOverlay(): void {
		overlayRuntime?.view?.refresh(overlayRuntime.handle?.isFocused() ?? false);
	}

	function setOverlayStatus(status: string, throttled = false): void {
		overlayStatus = status;
		if (throttled) {
			overlayRefreshTimer ??= setTimeout(() => {
				overlayRefreshTimer = null;
				syncOverlay();
			}, 16);
		} else {
			syncOverlay();
		}
	}

	function dismissOverlay(): void {
		const runtime = overlayRuntime;
		if (runtime && !runtime.closed) {
			overlayDraft = runtime.view?.getDraft() ?? overlayDraft;
			runtime.closed = true;
			runtime.handle?.hide();
			if (overlayRuntime === runtime) overlayRuntime = null;
			runtime.finish?.();
		}
		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	function setOverlayDraft(value: string): void {
		overlayDraft = value;
		overlayRuntime?.view?.setDraft(value);
	}

	async function disposeSideSession(): Promise<void> {
		const current = activeSideSession;
		activeSideSession = null;
		if (!current) {
			return;
		}

		try {
			current.unsubscribe();
		} catch {
			// Ignore unsubscribe errors during cleanup.
		}

		try {
			await current.session.abort();
		} catch {
			// Ignore abort errors during cleanup.
		}
		current.session.dispose();

		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	async function resetThread(): Promise<void> {
		thread = [];
		pending = null;
		setOverlayDraft("");
		setOverlayStatus("Ready");
		await disposeSideSession();
		const details: BtwResetDetails = { timestamp: Date.now() };
		pi.appendEntry(BTW_RESET_TYPE, details);
		syncOverlay();
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		await disposeSideSession();
		thread = [];
		pending = null;
		overlayStatus = "Ready";
		overlayDraft = "";
		const branch = ctx.sessionManager.getBranch();
		const lastResetIndex = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === BTW_RESET_TYPE);

		for (const entry of branch.slice(lastResetIndex + 1)) {
			if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) {
				continue;
			}
			const details = entry.data as BtwDetails | undefined;
			if (!details?.question || !details.answer) {
				continue;
			}
			thread.push(details);
		}

		syncOverlay();
	}

	async function ensureSideSession(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		const selected = ctx.model;
		if (!selected) return null;
		if (activeSideSession?.modelKey === `${selected.provider}/${selected.id}`) return activeSideSession;

		await disposeSideSession();
		// Pi command-context getters stay live across the abort above.
		const model = ctx.model;
		if (!model) return null;
		const modelKey = `${model.provider}/${model.id}`;
		const sessionManager = SessionManager.inMemory(ctx.cwd);
		for (const message of buildSeedMessages(ctx, thread)) sessionManager.appendMessage(message);
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			sessionManager,
			model,
			modelRuntime: parentModelRuntime(ctx),
			thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
			tools: ["read", "bash", "edit", "write"],
			resourceLoader: createBtwResourceLoader(ctx),
		});

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			const request = pending;
			if (!request?.busy) return;

			switch (event.type) {
				case "message_start":
				case "message_update":
				case "message_end": {
					const streamed = event.message.role === "assistant" ? extractText(event.message.content) : "";
					if (streamed) {
						request.answer = streamed;
						request.error = null;
					}
					setOverlayStatus(event.type === "message_end" ? "Finalizing side response..." : "Streaming side response...", true);
					return;
				}
				case "tool_execution_start": {
					try {
						request.tools.push({ toolName: event.toolName, args: formatToolArgs(event.toolName, event.args), status: "running" });
					} catch {
						// Tool display failures must not interrupt the request.
					}
					setOverlayStatus(`Running tool: ${event.toolName}...`, true);
					return;
				}
				case "tool_execution_end": {
					const tool = request.tools.find((tool) => tool.toolName === event.toolName && tool.status === "running");
					if (tool) tool.status = event.isError ? "error" : "done";
					setOverlayStatus("Streaming side response...", true);
					return;
				}
				case "turn_end":
					setOverlayStatus("Finalizing side response...", true);
			}
		});

		activeSideSession = { session, modelKey, unsubscribe };
		return activeSideSession;
	}

	async function ensureOverlay(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (overlayRuntime?.handle) {
			overlayRuntime.handle.setHidden(false);
			overlayRuntime.handle.focus();
			syncOverlay();
			return;
		}

		const runtime: OverlayRuntime = { closed: false };
		overlayRuntime = runtime;
		void ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => {
				runtime.finish = done;
				const view = new BtwOverlay(
					tui,
					theme,
					keybindings,
					getTranscriptLines,
					() => overlayStatus,
					(value) => void submitFromOverlay(ctx, value),
					() => void closeOverlayFlow(ctx),
				);
				runtime.view = view;
				view.focused = true;
				view.setDraft(overlayDraft);
				if (runtime.closed) done();
				return view;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "80%",
					minWidth: 72,
					maxHeight: "78%",
					anchor: "top-center",
					margin: { top: 1, left: 2, right: 2 },
				},
				onHandle: (handle) => {
					runtime.handle = handle;
					if (runtime.closed) handle.hide();
					else handle.focus();
				},
			},
		).catch((error) => {
			if (overlayRuntime === runtime) overlayRuntime = null;
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		});
	}

	async function summarizeThread(ctx: ExtensionContext, items: BtwDetails[]): Promise<string> {
		const model = ctx.model;
		if (!model) {
			throw new Error("No active model selected.");
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			throw new Error(auth.error);
		}

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			sessionManager: SessionManager.inMemory(ctx.cwd),
			model,
			modelRuntime: parentModelRuntime(ctx),
			thinkingLevel: "off",
			tools: [],
			resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARY_PROMPT]),
		});

		try {
			await session.prompt(formatThread(items), { source: "extension" });
			const response = getLastAssistantMessage(session);
			if (!response) {
				throw new Error("Summary finished without a response.");
			}
			if (response.stopReason === "aborted") {
				throw new Error("Summary request was aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "Summary request failed.");
			}

			return extractText(response.content) || "(No summary generated)";
		} finally {
			try {
				await session.abort();
			} catch {
				// Ignore abort errors during temporary session teardown.
			}
			session.dispose();
		}
	}

	async function injectSummaryIntoMain(ctx: ExtensionContext): Promise<void> {
		if (thread.length === 0) {
			notify(ctx, "No BTW thread to summarize.", "warning");
			return;
		}

		setOverlayStatus("Summarizing BTW thread for injection...");
		try {
			const summary = await summarizeThread(ctx, thread);
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}

			await resetThread();
			notify(ctx, "Injected BTW summary into main chat.", "info");
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function closeOverlayFlow(ctx: ExtensionContext): Promise<void> {
		dismissOverlay();
		if (!ctx.hasUI) {
			return;
		}

		if (thread.length === 0) {
			return;
		}

		const choice = await ctx.ui.select("Close BTW:", ["Keep side thread", "Inject summary into main chat"]);
		if (choice === "Inject summary into main chat") {
			await injectSummaryIntoMain(ctx);
		}
	}

	async function runBtwPrompt(ctx: ExtensionCommandContext, question: string): Promise<void> {
		const model = ctx.model;
		if (!model) {
			setOverlayStatus("No active model selected.");
			notify(ctx, "No active model selected.", "error");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			const message = auth.error;
			setOverlayStatus(message);
			notify(ctx, message, "error");
			return;
		}

		if (pending?.busy) {
			notify(ctx, "BTW is still processing the previous message.", "warning");
			return;
		}

		const side = await ensureSideSession(ctx);
		if (!side) {
			notify(ctx, "Unable to create BTW side session.", "error");
			return;
		}

		const request: PendingReply = { question, answer: "", error: null, tools: [], busy: true };
		pending = request;
		setOverlayStatus("Streaming side response...");

		try {
			await side.session.prompt(question, { source: "extension" });
			if (pending !== request) return;
			const response = getLastAssistantMessage(side.session);
			if (!response) {
				throw new Error("BTW request finished without a response.");
			}
			if (response.stopReason === "aborted") {
				throw new Error("BTW request aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "BTW request failed.");
			}

			const answer = extractText(response.content) || "(No text response)";
			const details: BtwDetails = {
				question,
				answer,
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
				usage: response.usage,
			};
			thread.push(details);
			pi.appendEntry(BTW_ENTRY_TYPE, details);

			pending = null;
			setOverlayStatus("Ready for the next side question.");
		} catch (error) {
			if (pending !== request) return;
			const message = error instanceof Error ? error.message : String(error);
			request.error = message;
			setOverlayStatus("BTW request failed.");
			notify(ctx, message, "error");
		} finally {
			request.busy = false;
			syncOverlay();
		}
	}

	async function submitFromOverlay(ctx: ExtensionCommandContext, rawValue: string): Promise<void> {
		const question = rawValue.trim();
		if (!question) {
			setOverlayStatus("Enter a question first.");
			return;
		}

		setOverlayDraft("");
		await runBtwPrompt(ctx, question);
	}

	pi.registerCommand("btw", {
		description: "Open a simple BTW side-chat popover. `/btw <text>` asks immediately, `/btw` opens the side thread.",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (!question) {
				if (thread.length > 0 && ctx.hasUI) {
					const choice = await ctx.ui.select("BTW side chat:", [
						"Continue previous conversation",
						"Start fresh",
					]);
					if (choice === "Continue previous conversation") {
						// Dispose session so it's recreated with fresh main context on next submit
						await disposeSideSession();
						setOverlayStatus("Continuing BTW thread.");
						await ensureOverlay(ctx);
					} else if (choice === "Start fresh") {
						await resetThread();
						setOverlayStatus("Ready");
						await ensureOverlay(ctx);
					}
					// null = user cancelled (Esc), do nothing
				} else {
					await resetThread();
					setOverlayStatus("Ready");
					await ensureOverlay(ctx);
				}
				return;
			}

			await ensureOverlay(ctx);
			await runBtwPrompt(ctx, question);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_shutdown", async () => {
		await disposeSideSession();
		dismissOverlay();
	});
}
