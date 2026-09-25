import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ContextManagementMode } from "../adapter/activation/config.ts";
import { historyNotesRenderers } from "./rendering.ts";
import {
	codexToolProviderHeaders,
	resolveCodexToolProvider,
} from "../adapter/codex-tool-provider.ts";
import {
	getPiSessionHistoryRecoveryHint,
	readPiSessionHistory,
} from "./local-history.ts";
import {
	renderPiSessionNotesThreadHint,
	usePiSessionNotes,
} from "./local-notes.ts";
import {
	CONTEXT_OPERATIONS,
	type ContextOperation,
	HISTORY_ACTIONS,
	HISTORY_DESCRIPTION,
	HISTORY_PARAMETERS,
	type HistoryAction,
	NOTES_ACTIONS,
	NOTES_DESCRIPTION,
	NOTES_PARAMETERS,
	type NotesAction,
} from "./tool-contract.ts";

const BACKEND_TIMEOUT_MS = 35_000;
const THREAD_HINT_MAX_BYTES = 4_000;
const TOOL_OUTPUT_TOKEN_LIMIT = 10_000;

const HISTORY_ACTION_SET = new Set<string>(HISTORY_ACTIONS);
const NOTES_ACTION_SET = new Set<string>(NOTES_ACTIONS);

export interface CodexHistoryNotesDetails {
	codexHistoryNotes: Record<string, unknown>;
}

export function createHistoryNotesTools(
	pi?: Pick<ExtensionAPI, "appendEntry">,
	resolveMode: (ctx: ExtensionContext) => ContextManagementMode = () =>
		"local",
	prepareNoteWrite?: (action: NotesAction, path: unknown, ctx: ExtensionContext) => () => boolean,
): [
	ToolDefinition<typeof HISTORY_PARAMETERS, CodexHistoryNotesDetails>,
	ToolDefinition<typeof NOTES_PARAMETERS, CodexHistoryNotesDetails>,
] {
	return [
		{
			name: "history",
			label: "history",
			description: HISTORY_DESCRIPTION,
			parameters: HISTORY_PARAMETERS,
			...historyNotesRenderers("history"),
			async execute(_id, params, signal, _update, ctx) {
				const action = historyAction(params.action);
				const operation = CONTEXT_OPERATIONS.history[action];
				validateArguments("history", action, params, operation);
				return callHistoryNotesTool(
					"history",
					action,
					operation,
					params,
					ctx,
					signal,
					resolveMode(ctx),
					pi,
				);
			},
		},
		{
			name: "notes",
			label: "notes",
			description: NOTES_DESCRIPTION,
			parameters: NOTES_PARAMETERS,
			...historyNotesRenderers("notes"),
			executionMode: "sequential",
			async execute(_id, params, signal, _update, ctx) {
				const action = notesAction(params.action);
				const operation = CONTEXT_OPERATIONS.notes[action];
				validateArguments("notes", action, params, operation);
				const finishNoteWrite = action === "write_file" || action === "append_to_file"
					? prepareNoteWrite?.(action, params.path, ctx)
					: undefined;
				const result = await callHistoryNotesTool(
					"notes",
					action,
					operation,
					params,
					ctx,
					signal,
					resolveMode(ctx),
					pi,
				);
				return finishNoteWrite?.()
					? { ...result, terminate: true }
					: result;
			},
		},
	];
}

export async function loadHistoryNotesThreadHint(
	ctx: ExtensionContext,
	mode: ContextManagementMode,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (mode === "local" || mode === "tree")
		return piSessionThreadHint(ctx, mode);
	if (!usesRemoteHistoryNotes(ctx, mode)) return undefined;
	try {
		const result = await callHistoryNotesBackend(
			"alpha/notes/v2/thread_hint",
			{},
			ctx,
			signal,
			{ mode: "bytes", limit: THREAD_HINT_MAX_BYTES },
		);
		const text = typeof result["text"] === "string" ? result["text"] : "";
		return text && Buffer.byteLength(text, "utf8") <= THREAD_HINT_MAX_BYTES
			? text
			: undefined;
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
}

function piSessionThreadHint(
	ctx: ExtensionContext,
	mode: ContextManagementMode,
): string | undefined {
	const recovery = getPiSessionHistoryRecoveryHint(ctx, mode);
	const recoveryHint = recovery
		? `Previous window history IDs: ${JSON.stringify(recovery)}`
		: undefined;
	const recoveryBytes = recoveryHint
		? Buffer.byteLength(`\n${recoveryHint}`, "utf8")
		: 0;
	const notesHint = renderPiSessionNotesThreadHint(
		ctx.sessionManager.getBranch(),
		Math.max(0, THREAD_HINT_MAX_BYTES - recoveryBytes),
	);
	const hint = [notesHint, recoveryHint].filter(
		(value): value is string => Boolean(value),
	).join("\n");
	return hint && Buffer.byteLength(hint, "utf8") <= THREAD_HINT_MAX_BYTES
		? hint
		: undefined;
}

async function callHistoryNotesTool(
	namespace: "history" | "notes",
	action: HistoryAction | NotesAction,
	operation: ContextOperation,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	mode: ContextManagementMode,
	pi: Pick<ExtensionAPI, "appendEntry"> | undefined,
): Promise<AgentToolResult<CodexHistoryNotesDetails>> {
	let result: Record<string, unknown>;
	if (mode === "remote") {
		if (!usesRemoteHistoryNotes(ctx, mode))
			throw new Error("Remote history and notes require Codex transport");
		result = await callHistoryNotesBackend(
			`alpha/${namespace}/v2/${action}`,
			stripAction(params),
			ctx,
			signal,
			{ mode: "tokens", limit: TOOL_OUTPUT_TOKEN_LIMIT },
			operation.encryptedField !== undefined,
		);
	} else result = callLocalHistoryNotes(namespace, action, params, ctx, pi, mode);
	const modelResult = { ...result };
	delete modelResult["images"];
	const content: AgentToolResult<CodexHistoryNotesDetails>["content"] = [
		{
			type: "text",
			text:
				typeof modelResult["encrypted_output"] === "string"
					? `${namespace} operation completed`
					: JSON.stringify(modelResult),
		},
	];
	for (const image of parseBackendImages(result["images"])) content.push(image);
	return {
		content,
		details: { codexHistoryNotes: modelResult },
	};
}

async function callHistoryNotesBackend(
	endpoint: string,
	arguments_: Record<string, unknown>,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	truncationPolicy: { mode: "bytes" | "tokens"; limit: number },
	encryptedArguments = false,
): Promise<Record<string, unknown>> {
	const provider = await resolveCodexToolProvider(ctx);
	if (provider.route !== "openai-codex")
		throw new Error("History and notes require the OpenAI Codex backend");
	const headers = codexToolProviderHeaders(provider);
	headers.set(
		"x-openai-tool-output-truncation-policy",
		JSON.stringify(truncationPolicy),
	);
	if (encryptedArguments)
		headers.set("x-openai-encrypted-tool-arguments", "true");
	const timeoutSignal = AbortSignal.timeout(BACKEND_TIMEOUT_MS);
	const response = await fetch(
		`${provider.baseUrl.replace(/\/+$/, "")}/${endpoint}`,
		{
			method: "POST",
			headers,
			signal: signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal,
			body: JSON.stringify({
				...arguments_,
				context: {
					session_id: ctx.sessionManager.getSessionId(),
					current_agent_name: "/root",
				},
			}),
		},
	);
	if (!response.ok)
		throw new Error(`History and notes backend failed (${response.status})`);
	const result: unknown = JSON.parse(await response.text());
	if (!result || typeof result !== "object" || Array.isArray(result))
		throw new Error("History and notes backend returned invalid data");
	return result as Record<string, unknown>;
}

export function usesRemoteHistoryNotes(
	ctx: Pick<ExtensionContext, "model" | "sessionManager">,
	mode: ContextManagementMode,
): boolean {
	return mode === "remote" &&
		(ctx.model?.api ?? "").trim().toLowerCase() ===
			"openai-codex-responses";
}

function callLocalHistoryNotes(
	namespace: "history" | "notes",
	action: HistoryAction | NotesAction,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "appendEntry"> | undefined,
	mode: ContextManagementMode,
): Record<string, unknown> {
	if (namespace === "history")
		return readPiSessionHistory(action as HistoryAction, params, ctx, mode);
	if (!pi) throw new Error("Local notes require an active Pi session");
	return usePiSessionNotes(pi, action as NotesAction, params, ctx);
}

function stripAction(params: Record<string, unknown>): Record<string, unknown> {
	const result = { ...params };
	delete result["action"];
	delete result["context"];
	return result;
}

function historyAction(value: unknown): HistoryAction {
	if (typeof value === "string" && HISTORY_ACTION_SET.has(value))
		return value as HistoryAction;
	throw new Error("history requires a supported action");
}

function notesAction(value: unknown): NotesAction {
	if (typeof value === "string" && NOTES_ACTION_SET.has(value))
		return value as NotesAction;
	throw new Error("notes requires a supported action");
}

function validateArguments(
	namespace: "history" | "notes",
	action: HistoryAction | NotesAction,
	params: Record<string, unknown>,
	operation: ContextOperation,
): void {
	const allowed = Object.keys(operation.parameters.properties);
	const unexpected = Object.keys(params).find(
		(field) => field !== "action" && !allowed.includes(field),
	);
	if (unexpected)
		throw new Error(`${namespace} ${action} does not accept ${unexpected}`);
	// Validate in field order, not wire required-array order: notes reports a
	// missing path before missing text, while its namespace requires text first.
	for (const field of allowed) {
		if (!operation.parameters.required?.includes(field)) continue;
		if (typeof params[field] !== "string" || (!params[field] && !operation.allowEmpty?.includes(field)))
			throw new Error(`${namespace} ${action} requires ${field}`);
	}
}

function parseBackendImages(
	value: unknown,
): Array<{
	type: "image";
	data: string;
	mimeType: string;
	detail?: "auto" | "high" | "original" | undefined;
}> {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new Error("History backend returned invalid image content");
	return value.map((item) => {
		if (!item || typeof item !== "object")
			throw new Error("History backend returned invalid image content");
		const image = item as Record<string, unknown>;
		if (
			typeof image["data"] !== "string" ||
			typeof image["mime_type"] !== "string"
		)
			throw new Error("History backend returned invalid image content");
		const detail = image["detail"];
		if (
			detail !== undefined &&
			detail !== null &&
			detail !== "auto" &&
			detail !== "high" &&
			detail !== "original"
		)
			throw new Error("History backend returned invalid image detail");
		return {
			type: "image" as const,
			data: image["data"],
			mimeType: image["mime_type"],
			...(detail ? { detail } : {}),
		};
	});
}
