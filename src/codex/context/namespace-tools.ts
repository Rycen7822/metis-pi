import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	CONTEXT_OPERATIONS,
	type ContextOperation,
	HISTORY_ACTIONS,
	HISTORY_DESCRIPTION,
	NOTES_ACTIONS,
	NOTES_DESCRIPTION,
} from "./tool-contract.ts";
import { currentToolNamesOf } from "../providers/transcript.ts";

type ContextNamespace = "history" | "notes";

const ACTIONS = {
	history: new Set<string>(HISTORY_ACTIONS),
	notes: new Set<string>(NOTES_ACTIONS),
} satisfies Record<ContextNamespace, ReadonlySet<string>>;

function contextNamespace(
	name: ContextNamespace,
	encrypted: boolean,
): Record<string, unknown> {
	const operations: Readonly<Record<string, ContextOperation>> = CONTEXT_OPERATIONS[name];
	return {
		type: "namespace",
		name,
		description: name === "history" ? HISTORY_DESCRIPTION : NOTES_DESCRIPTION,
		tools: Object.entries(operations).map(([action, operation]) => {
			// Each request owns its schemas, including nested enums and required
			// arrays; transport transforms must not mutate the shared contract.
			const parameters = structuredClone(operation.parameters);
			if (encrypted) {
				for (const [field, schema] of Object.entries(parameters.properties)) {
					const property: { minimum?: number; encrypted?: true } = schema;
					// Codex's reserved Remote schemas omit numeric bounds.
					delete property.minimum;
					if (operation.encryptedField === field) property.encrypted = true;
				}
			}
			return {
				type: "function",
				name: action,
				description: operation.description,
				strict: false,
				parameters: {
					...parameters,
					// Remote also omits this keyword; false and absent differ.
					...(!encrypted ? { additionalProperties: false } : {}),
				},
			};
		}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function namespaceName(value: unknown): ContextNamespace | undefined {
	if (!isRecord(value)) return undefined;
	const name = value["name"];
	return (name === "history" || name === "notes") &&
		(value["type"] === "function" || value["type"] === "namespace")
		? name
		: undefined;
}

function rewriteTools(
	tools: readonly unknown[],
	encrypted: boolean,
): { tools: unknown[]; changed: boolean } {
	let changed = false;
	const rewritten = tools.map((tool) => {
		const name = namespaceName(tool);
		if (!name) return tool;
		changed = true;
		return contextNamespace(name, encrypted);
	});
	return { tools: rewritten, changed };
}

export function rewriteContextNamespaceTools(
	payload: unknown,
	options: { encrypted?: boolean } = {},
): unknown {
	if (!isRecord(payload)) return payload;
	const encrypted = options.encrypted === true;
	let changed = false;
	let tools = payload["tools"];
	if (Array.isArray(tools)) {
		const result = rewriteTools(tools, encrypted);
		tools = result.tools;
		changed ||= result.changed;
	}
	let input = payload["input"];
	if (Array.isArray(input)) {
		input = input.map((item) => {
			if (!isRecord(item) || !Array.isArray(item["tools"])) return item;
			const result = rewriteTools(item["tools"], encrypted);
			if (!result.changed) return item;
			changed = true;
			return { ...item, tools: result.tools };
		});
	}
	return changed ? { ...payload, tools, input } : payload;
}

export function hasContextNamespaceRouters(
	context: Pick<Context, "messages">,
): boolean {
	const names = currentToolNamesOf(context);
	return names.has("history") && names.has("notes");
}

function routedAction(call: ToolCall): string | undefined {
	if (call.namespace !== "history" && call.namespace !== "notes")
		return undefined;
	return ACTIONS[call.namespace].has(call.name) ? call.name : undefined;
}

function routeContextNamespaceToolCall(call: ToolCall): ToolCall {
	const action = routedAction(call);
	if (!action || !call.namespace) return call;
	return {
		...call,
		name: call.namespace,
		arguments: { action, ...call.arguments },
	};
}

export function unrouteContextNamespaceToolCall(call: ToolCall): ToolCall {
	if (
		(call.namespace !== "history" && call.namespace !== "notes") ||
		call.name !== call.namespace
	)
		return call;
	const action = call.arguments["action"];
	if (typeof action !== "string" || !ACTIONS[call.namespace].has(action))
		return call;
	const args = { ...call.arguments };
	delete args["action"];
	return { ...call, name: action, arguments: args };
}

function routeMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((block) =>
			block.type === "toolCall"
				? routeContextNamespaceToolCall(block)
				: block,
		),
	};
}

function routeEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type === "done")
		return { ...event, message: routeMessage(event.message) };
	if (event.type === "error")
		return { ...event, error: routeMessage(event.error) };
	const partial = routeMessage(event.partial);
	return event.type === "toolcall_end"
		? {
				...event,
				toolCall: routeContextNamespaceToolCall(event.toolCall),
				partial,
			}
		: { ...event, partial };
}

export function routeContextNamespaceToolStream(
	source: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		let latest: AssistantMessage | undefined;
		try {
			for await (const event of source) {
				const routed = routeEvent(event);
				latest = routed.type === "done"
					? routed.message
					: routed.type === "error"
						? routed.error
						: routed.partial;
				output.push(routed);
				if (routed.type === "done") output.end(routed.message);
				if (routed.type === "error") output.end(routed.error);
			}
		} catch (error) {
			if (!latest) throw error;
			const failed: AssistantMessage = {
				...latest,
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			output.push({ type: "error", reason: "error", error: failed });
			output.end(failed);
		}
	})();
	return output;
}
