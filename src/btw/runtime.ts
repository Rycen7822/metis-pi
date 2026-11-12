// Derived from mitsuhiko/agent-stuff extensions/btw.ts (Apache-2.0).
// Source revision and local maintenance scope are recorded in NOTICE.
import {
	createAgentSession, createExtensionRuntime, convertToLlm, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionCommandContext,
	type ExtensionContext, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { branchEntryReferences, readHistoryEntries } from "../session-history.ts";
import { detectColorLevel } from "../presentation/palette.ts";
import { createTranscriptSurface } from "../appearance/transcript/surface.ts";
import { requestEmbeddedTranscript } from "../appearance/transcript/embedded.ts";
import { btwTools, loadBtwAccessGuard, type BtwAccess } from "./access.ts";
import { BtwOverlay, type BtwSessionView } from "./view.ts";
import { embeddedHost } from "../appearance/transcript/embedded-host.ts";

const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";

const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"The user controls tool access in the BTW header; never grant yourself permissions.",
	"Be direct and practical.",
].join(" ");

const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. "
	+ "Keep key decisions, findings, risks, and next actions. Output only the summary.";

type SessionThinkingLevel = "off" | AiThinkingLevel;

type BtwDetails = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	thinkingLevel: SessionThinkingLevel;
	usage?: AssistantMessage["usage"];
	messages?: AgentMessage[];
	error?: string;
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

type SideSessionRuntime = BtwSessionView & {
	modelKey: string;
	unsubscribe: () => void;
};

type PendingReply = {
	messages: AgentMessage[];
	busy: boolean;
	cancelledByAccess?: boolean;
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
	// Pi 1.5 exposes a registry facade to extensions but requires its native
	// runtime for child sessions. Borrow that owner read-only; never copy auth
	// or silently fall back to a new runtime when this host contract changes.
	const runtime = Reflect.get(ctx.modelRegistry, "runtime");
	if (!(runtime instanceof ModelRuntime)) {
		throw new Error("BTW requires the Pi 1.5 model runtime.");
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

function threadMessages(ctx: ExtensionContext, thread: BtwDetails[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const item of thread) {
		if (Array.isArray(item.messages)) {
			messages.push(...item.messages);
			continue;
		}
		messages.push(
			{ role: "user", content: [{ type: "text", text: item.question }], timestamp: item.timestamp },
			{
				role: "assistant", content: [{ type: "text", text: item.answer }],
				provider: item.provider, model: item.model, api: ctx.model?.api ?? "openai-responses",
				usage: item.usage ?? {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop", timestamp: item.timestamp,
			},
		);
	}
	return messages;
}

function buildSeedMessages(ctx: ExtensionContext, thread: BtwDetails[]): AgentMessage[] {
	let messages: AgentMessage[] = [];
	try {
		messages = ctx.sessionManager.buildSessionProjection().messages;
	} catch {
		// Preserve the existing fallback when the host cannot project main context.
	}
	return [...messages, ...threadMessages(ctx, thread)];
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


export default function (pi: ExtensionAPI) {
	let thread: BtwDetails[] = [];
	let pending: PendingReply | null = null;
	let overlayStatus = "Ready";
	let overlayDraft = "";
	let overlayRuntime: OverlayRuntime | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let access: BtwAccess = "read";
	let sideGeneration = 0;
	let changingAccess = false;

	async function toggleAccess(ctx: ExtensionContext): Promise<void> {
		if (changingAccess) return;
		changingAccess = true;
		access = access === "read" ? "write" : "read";
		setOverlayStatus(access === "read" ? "Switching to read; stopping active BTW work..." : "Write enabled for BTW.");
		try {
			const side = activeSideSession;
			if (side) {
				if (access === "read" && side.session.isStreaming) {
					if (pending) pending.cancelledByAccess = true;
					await side.session.abort();
				}
				if (activeSideSession === side) side.session.setActiveToolsByName(btwTools(access));
			}
			setOverlayStatus(`${access} mode · ${pending?.busy ? "BTW is responding." : "Ready."}`);
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
			setOverlayStatus("Permission change failed; active work may still be stopping.");
		} finally {
			changingAccess = false;
			syncOverlay();
		}
	}

	function syncOverlay(): void {
		overlayRuntime?.view?.setSession(activeSideSession ?? undefined);
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
			overlayDraft = runtime.view?.getInputText() ?? overlayDraft;
			runtime.closed = true;
			runtime.view?.dispose();
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
		overlayRuntime?.view?.setInputText(value);
	}

	async function disposeSideSession(): Promise<void> {
		sideGeneration += 1;
		const current = activeSideSession;
		if (!current) return;
		try {
			await current.session.abort();
		} finally {
			current.unsubscribe();
			current.session.dispose();
			if (activeSideSession === current) activeSideSession = null;
		}

		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	async function resetThread(): Promise<void> {
		access = "read";
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
		access = "read";
		await disposeSideSession();
		thread = [];
		pending = null;
		overlayStatus = "Ready";
		overlayDraft = "";
		const branch = branchEntryReferences(ctx.sessionManager);
		const lastResetIndex = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === BTW_RESET_TYPE);
		const active = new Set(branch.slice(lastResetIndex + 1)
			.filter(entry => entry.type === "custom" && entry.customType === BTW_ENTRY_TYPE).map(entry => entry.id));

		for (const entry of readHistoryEntries(ctx.sessionManager, "branch", reference => active.has(reference.id))) {
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
		if (activeSideSession && (activeSideSession.session.isStreaming
			|| activeSideSession.modelKey === `${selected.provider}/${selected.id}`)) return activeSideSession;

		await disposeSideSession();
		const generation = sideGeneration;
		const guarded = await loadBtwAccessGuard(ctx.cwd, () => access);
		const resources = createBtwResourceLoader(ctx);
		resources.getExtensions = () => guarded;
		// Pi command-context getters stay live across the abort and resource load above.
		const model = ctx.model;
		if (!model) return null;
		const modelKey = `${model.provider}/${model.id}`;
		const sessionManager = SessionManager.inMemory(ctx.cwd);
		for (const message of convertToLlm(buildSeedMessages(ctx, thread))) sessionManager.appendMessage(message);
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			sessionManager,
			model,
			modelRuntime: parentModelRuntime(ctx),
			thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
			tools: btwTools("write"),
			resourceLoader: resources,
		});

		const sourceInfoFor = (name: string) => session.getAllTools().find(tool => tool.name === name)?.sourceInfo;
		const presentation = await requestEmbeddedTranscript(pi.events, sourceInfoFor).catch(error => {
			session.dispose();
			throw error;
		});
		if (generation !== sideGeneration) {
			session.dispose();
			return null;
		}
		session.setActiveToolsByName(btwTools(access));
		const surface = presentation?.surface ?? createTranscriptSurface(detectColorLevel(), sourceInfoFor);
		const messages = threadMessages(ctx, thread);
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			const side = activeSideSession;
			if (side?.session !== session) return;
			surface.observe(event, ctx.cwd);
			if (event.type === "message_end") {
				messages.push(event.message);
				pending?.messages.push(event.message);
				if (event.message.role === "assistant") side.partial = undefined;
			} else if ((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant") {
				side.partial = event.message;
			}
			overlayRuntime?.view?.handleEvent(event);
			if (event.type === "tool_execution_start") setOverlayStatus(`Running tool: ${event.toolName}...`, true);
			else if (event.type === "message_update" || event.type === "tool_execution_update") {
				setOverlayStatus("Streaming side response...", true);
			} else syncOverlay();
		});
		activeSideSession = { session, modelKey, unsubscribe, surface, presentation, messages };
		overlayRuntime?.view?.setSession(activeSideSession);
		return activeSideSession;
	}

	async function ensureOverlay(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) return;
		embeddedHost();
		const side = ctx.model ? await ensureSideSession(ctx) : undefined;
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
				const view = new BtwOverlay({
					tui, theme, keybindings, presentation: side?.presentation,
					settings: side?.session.settingsManager ?? SettingsManager.create(ctx.cwd),
					getStatus: () => overlayStatus, getAccess: () => access,
					onToggleAccess: () => void toggleAccess(ctx),
					onSubmit: value => void submitFromOverlay(ctx, value),
					onDismiss: () => void closeOverlayFlow(ctx),
				});
				view.setSession(side ?? undefined);
				runtime.view = view;
				view.focused = true;
				view.setInputText(overlayDraft);
				if (runtime.closed) done();
				return view;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
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
		if (pending?.busy) {
			setOverlayDraft(question);
			notify(ctx, "BTW is still processing the previous message.", "warning");
			return;
		}
		const request: PendingReply = { messages: [], busy: true };
		pending = request;
		let side: SideSessionRuntime | null;
		try {
			side = await ensureSideSession(ctx);
		} catch (error) {
			if (pending !== request) return;
			pending = null;
			const message = error instanceof Error ? error.message : String(error);
			setOverlayStatus(`BTW could not start: ${message}`);
			notify(ctx, message, "error");
			return;
		}
		if (pending !== request) return;
		const model = side?.session.model;
		if (!side || !model) {
			pending = null;
			setOverlayStatus("No active model selected.");
			notify(ctx, "No active model selected.", "error");
			return;
		}
		setOverlayStatus("Streaming side response...");
		let response: AssistantMessage | undefined;
		let failure: string | undefined;
		try {
			await side.session.prompt(question, { source: "extension" });
			if (pending !== request) return;
			if (request.cancelledByAccess) throw new Error("BTW request stopped after switching to read mode.");
			response = request.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
			if (!response) throw new Error("BTW request finished without a response.");
			if (response.stopReason === "aborted") throw new Error("BTW request aborted.");
			if (response.stopReason === "error") throw new Error(response.errorMessage || "BTW request failed.");
		} catch (error) {
			if (pending !== request) return;
			failure = error instanceof Error ? error.message : String(error);
			if (!request.cancelledByAccess) notify(ctx, failure, "error");
		} finally {
			request.busy = false;
			if (pending === request) {
				// Preserve actual native tool/thinking/error messages, not a second Markdown transcript.
				const details: BtwDetails = {
					question, answer: response && extractText(response.content) || failure || "(No text response)",
					timestamp: Date.now(), provider: model.provider, model: model.id,
					thinkingLevel: side.session.thinkingLevel, usage: response?.usage,
					messages: request.messages, error: failure,
				};
				if (request.messages.length) {
					thread.push(details);
					pi.appendEntry(BTW_ENTRY_TYPE, details);
				}
				pending = null;
				setOverlayStatus(request.cancelledByAccess ? "Read mode. Active BTW request stopped."
					: failure ? `BTW request failed: ${failure}` : "Ready for the next side question.");
			}
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
