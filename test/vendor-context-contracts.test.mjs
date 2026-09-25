import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { FAKE_API_KEY } from "./helpers/vendor-codex-provider.mjs";
import { createHistoryNotesTools } from "../vendor/pi-codex-conversion/dist/context-management/history-notes.js";
import {
	rewriteContextNamespaceTools,
	routeContextNamespaceToolStream,
	unrouteContextNamespaceToolCall,
} from "../vendor/pi-codex-conversion/dist/context-management/namespace-tools.js";

// Independent wire/argument goldens, established against 312bc5d before changing
// the contract owner. Do not import the implementation's operation specification.
const string = { type: "string" };
const boolean = { type: "boolean" };
const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });
const positive = { type: "integer", minimum: 1 };
const historyFields = {
	agent_name: nullable("string"), item_id: string, limit: positive,
	limit_chars: positive, max_chars_per_item: positive, offset_chars: { type: "integer", minimum: 0 },
	query: string, recent_first: boolean,
	role: { anyOf: [{ type: "string", enum: ["user", "assistant", "tool", "system", "developer"] }, { type: "null" }] },
	tool_name: nullable("string"), tool_namespace: nullable("string"), window_id: nullable("string"),
};
const notesFields = {
	file_order: { type: "string", enum: ["ascending", "descending"] },
	file_order_by: { type: "string", enum: ["name", "created_at", "updated_at"] },
	max_files: positive, max_matches_per_file: positive, max_results: positive,
	path: string, path_prefix: nullable("string"), prefix: nullable("string"), query: string,
	recent_file_first: boolean, start_line: nullable("integer"), stop_line: nullable("integer"), text: string,
};
const descriptions = {
	history: "Prior-window detail. Pass IDs unchanged. Search, never browse.",
	notes: "Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].",
};
const cases = [
	{
		namespace: "history", action: "list_windows", description: "List context windows",
		fields: ["agent_name", "limit", "recent_first"],
		args: { agent_name: null, limit: 1, recent_first: false },
	},
	{
		namespace: "history", action: "list_items", description: "List history items",
		fields: ["agent_name", "limit", "max_chars_per_item", "recent_first", "role", "tool_name", "tool_namespace", "window_id"],
		args: { agent_name: null, limit: 1, max_chars_per_item: 1, recent_first: true, role: null, tool_name: null, tool_namespace: null, window_id: null },
	},
	{
		namespace: "history", action: "read_item", description: "Read history item range",
		fields: ["agent_name", "item_id", "limit_chars", "offset_chars", "window_id"], required: ["item_id", "window_id"],
		args: { agent_name: null, item_id: "user-entry", limit_chars: 1, offset_chars: 0, window_id: "window-0" },
	},
	{
		namespace: "history", action: "search_contents", description: "Search history",
		fields: ["agent_name", "limit", "query", "recent_first", "role", "tool_name", "tool_namespace", "window_id"], required: ["query"], encrypted: "query",
		args: { agent_name: null, limit: 1, query: "cipher-query", recent_first: false, role: "user", tool_name: null, tool_namespace: null, window_id: null },
	},
	{
		namespace: "notes", action: "list_files_by_prefix", description: "List note files",
		fields: ["file_order", "file_order_by", "max_results", "prefix"],
		args: { file_order: "descending", file_order_by: "updated_at", max_results: 1, prefix: null },
	},
	{
		namespace: "notes", action: "read_file", description: "Read note file; line bounds inclusive, 1-based, negative from end",
		fields: ["path", "start_line", "stop_line"], required: ["path"],
		args: { path: "checkpoint.md", start_line: -1, stop_line: null },
	},
	{
		namespace: "notes", action: "search_contents", description: "Search note lines by literal substring",
		fields: ["max_files", "max_matches_per_file", "path_prefix", "query", "recent_file_first"], required: ["query"], encrypted: "query",
		args: { max_files: 1, max_matches_per_file: 1, path_prefix: null, query: "cipher-query", recent_file_first: false },
	},
	{
		namespace: "notes", action: "append_to_file", description: "Append text exactly",
		fields: ["path", "text"], required: ["text", "path"], encrypted: "text",
		args: { path: "checkpoint.md", text: "" },
	},
	{
		namespace: "notes", action: "write_file", description: "Create or replace a note file",
		fields: ["path", "text"], required: ["text", "path"], encrypted: "text",
		args: { path: "checkpoint.md", text: "" },
	},
];
const fieldsFor = (namespace) => namespace === "history" ? historyFields : notesFields;
const json = (value) => JSON.parse(JSON.stringify(value));
const routers = () => createHistoryNotesTools().map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));

function goldenNamespace(namespace, encrypted) {
	return {
		type: "namespace", name: namespace, description: descriptions[namespace],
		tools: cases.filter((item) => item.namespace === namespace).map((item) => {
			const properties = Object.fromEntries(item.fields.map((field) => [field, json(fieldsFor(namespace)[field])]));
			if (item.action === "read_item") {
				properties.window_id = { type: "string" };
				properties.item_id.description = "Suffix from the item's [id: …] marker.";
			}
			if (item.action === "search_contents") properties.query.description = "Case-sensitive";
			if (encrypted) {
				for (const property of Object.values(properties)) delete property.minimum;
				if (item.encrypted) properties[item.encrypted].encrypted = true;
			}
			return {
				type: "function", name: item.action, description: item.description, strict: false,
				parameters: {
					type: "object", properties, ...(item.required ? { required: item.required } : {}),
					...(encrypted ? {} : { additionalProperties: false }),
				},
			};
		}),
	};
}

test("all nine operation declarations retain the baseline flat and namespace contracts", () => {
	for (const tool of createHistoryNotesTools()) {
		assert.equal(tool.description, descriptions[tool.name]);
		assert.deepEqual(json(tool.parameters), {
			type: "object", required: ["action"], additionalProperties: false,
			properties: {
				action: { type: "string", enum: cases.filter((item) => item.namespace === tool.name).map((item) => item.action) },
				...fieldsFor(tool.name),
			},
		});
	}
	// Alternate modes repeatedly: deriving a Remote schema must not mutate the
	// shared Local/Tree fields (bounds, nullability, closed objects, encryption).
	for (const encrypted of [false, true, false, true]) {
		const untouched = { type: "function", name: "other", parameters: {} };
		const input = { tools: [...routers(), untouched], input: [{ type: "additional_tools", tools: routers() }] };
		const before = json(input);
		const result = rewriteContextNamespaceTools(input, { encrypted });
		const expected = ["history", "notes"].map((name) => goldenNamespace(name, encrypted));
		assert.deepEqual(json(result.tools), [...expected, untouched]);
		assert.deepEqual(json(result.input[0].tools), expected);
		assert.deepEqual(json(input), before);
		assert.equal(result.tools[2], untouched);
		assert.deepEqual(json(rewriteContextNamespaceTools(result, { encrypted })), json(result));
		// Transport consumers may modify their request: no nested arrays may
		// alias the shared contract or another declaration in the same request.
		result.tools[0].tools[1].parameters.properties.role.anyOf[0].enum.push("MUTATED");
		result.tools[1].tools[4].parameters.required.push("MUTATED");
		assert.deepEqual(json(result.input[0].tools), expected);
		assert.deepEqual(json(rewriteContextNamespaceTools({ tools: routers() }, { encrypted }).tools), expected);
	}
	const noRouters = { input: [], tools: [{ type: "function", name: "other" }] };
	assert.equal(rewriteContextNamespaceTools(noRouters), noRouters);
});

function context(entries = []) {
	return {
		model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra", baseUrl: "https://chatgpt.com/backend-api" },
		sessionManager: { getSessionId: () => "contract-session", getBranch: () => entries, getEntries: () => entries },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: FAKE_API_KEY }) },
	};
}
const execute = (tool, params, ctx) => tool.execute("contract-call", params, undefined, undefined, ctx);

test("all nine remote routes accept only their action fields and encrypt exactly the sensitive operations", async (t) => {
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		requests.push({ url, init });
		return new Response(JSON.stringify({ encrypted_output: "opaque-result" }));
	});
	let localWrites = 0;
	let completedWrites = 0;
	const tools = createHistoryNotesTools({ appendEntry() { localWrites++; } }, () => "remote", () => () => { completedWrites++; return true; });
	const ctx = context();
	for (const item of cases) {
		const tool = tools.find((candidate) => candidate.name === item.namespace);
		const result = await execute(tool, { action: item.action, ...item.args }, ctx);
		const { url, init } = requests.at(-1);
		assert.equal(url, `https://chatgpt.com/backend-api/codex/alpha/${item.namespace}/v2/${item.action}`);
		assert.equal(init.method, "POST");
		assert.equal(new Headers(init.headers).get("x-openai-encrypted-tool-arguments"), item.encrypted ? "true" : null);
		assert.equal(new Headers(init.headers).get("x-openai-tool-output-truncation-policy"), '{"mode":"tokens","limit":10000}');
		assert.deepEqual(JSON.parse(init.body), { ...item.args, context: { session_id: "contract-session", current_agent_name: "/root" } });
		assert.deepEqual(result.details, { codexHistoryNotes: { encrypted_output: "opaque-result" } });
		assert.deepEqual(result.content, [{ type: "text", text: `${item.namespace} operation completed` }]);
		assert.equal(result.terminate, item.encrypted === "text" ? true : undefined);

		const acceptedRequests = requests.length;
		const crossActionField = Object.keys(fieldsFor(item.namespace)).find((field) => !item.fields.includes(field));
		for (const field of [crossActionField, "unknown", "context"]) {
			await assert.rejects(execute(tool, { action: item.action, ...item.args, [field]: "forbidden" }, ctx), {
				message: `${item.namespace} ${item.action} does not accept ${field}`,
			});
		}
		for (const field of item.required ?? []) {
			for (const invalid of [undefined, null, 7, ...(field === "text" ? [] : [""])]) {
				const args = { action: item.action, ...item.args, [field]: invalid };
				if (invalid === undefined) delete args[field];
				await assert.rejects(execute(tool, args, ctx), { message: `${item.namespace} ${item.action} requires ${field}` });
			}
		}
		assert.equal(requests.length, acceptedRequests, "invalid args never reach the backend");
	}
	for (const tool of tools) {
		for (const action of [undefined, "unknown", "toString", null])
			await assert.rejects(execute(tool, { action }, ctx), { message: `${tool.name} requires a supported action` });
	}
	for (const action of ["append_to_file", "write_file"])
		await assert.rejects(execute(tools[1], { action }, ctx), { message: `notes ${action} requires path` });
	assert.equal(requests.length, 9);
	assert.equal(completedWrites, 2);
	assert.equal(localWrites, 0);
});

test("remote failures never fall back to local notes or confirm a completed write", async (t) => {
	let writes = 0;
	let finished = 0;
	const [, notes] = createHistoryNotesTools({ appendEntry() { writes++; } }, () => "remote", () => () => { finished++; return true; });
	const fetch = t.mock.method(globalThis, "fetch");
	for (const [respond, error] of [
		[() => new Response("failure", { status: 503 }), /backend failed \(503\)/],
		[() => new Response("[]"), /returned invalid data/],
		[() => new Response('{"images":[{"data":7}]}'), /invalid image content/],
		[() => { throw new Error("offline-abort"); }, /offline-abort/],
	]) {
		fetch.mock.mockImplementation(respond);
		for (const action of ["append_to_file", "write_file"])
			await assert.rejects(execute(notes, { action, path: "checkpoint.md", text: "" }, context()), error);
	}
	const nonCodex = context();
	nonCodex.model.api = "openai-responses";
	await assert.rejects(execute(notes, { action: "write_file", path: "checkpoint.md", text: "" }, nonCodex), /require Codex transport/);
	assert.equal(fetch.mock.callCount(), 8);
	assert.equal(writes, 0);
	assert.equal(finished, 0);
});

for (const mode of ["local", "tree"]) {
	test(`${mode} executes all nine actions locally and preserves empty note text`, async (t) => {
		t.mock.method(globalThis, "fetch", () => assert.fail("local operations must not fetch"));
		const entries = [
			{ type: "custom_message", id: "window-entry", customType: "codex-context-window", details: { contextManagement: { kind: "window", currentWindowId: "window-0" } } },
			{ type: "message", id: "user-entry", parentId: "window-entry", message: { role: "user", content: "recover me", timestamp: 1 } },
		];
		const ctx = context(entries);
		let finished = 0;
		const [history, notes] = createHistoryNotesTools({
			appendEntry(customType, data) { entries.push({ type: "custom", id: `note-${entries.length}`, customType, data }); },
		}, () => mode, () => () => { finished++; return false; });
		for (const action of ["write_file", "append_to_file"]) {
			const result = await execute(notes, { action, path: "checkpoint.md", text: "" }, ctx);
			assert.equal(result.terminate, undefined);
		}
		const read = await execute(notes, { action: "read_file", path: "checkpoint.md" }, ctx);
		assert.equal(read.details.codexHistoryNotes.file.content, "");
		for (const item of cases.filter((item) => !["write_file", "append_to_file"].includes(item.action))) {
			const result = await execute(item.namespace === "history" ? history : notes, { action: item.action, ...item.args }, ctx);
			assert.equal(result.details.codexHistoryNotes.source, "pi-session", item.action);
		}
		assert.equal(finished, 2, "reads and searches do not complete writes");
		await assert.rejects(execute(notes, { action: "write_file", path: "checkpoint.md" }, ctx), /requires text/);
	});
}

test("all namespace operations round-trip through partial, completed and failed streams", async () => {
	const calls = cases.map((item, index) => ({ type: "toolCall", id: `call-${index}`, namespace: item.namespace, name: item.action, arguments: item.args }));
	const unknown = { type: "toolCall", id: "unknown", namespace: "history", name: "future_operation", arguments: {} };
	const message = { role: "assistant", content: [...calls, unknown], stopReason: "toolUse" };
	for (const end of ["done", "error"]) {
		const source = createAssistantMessageEventStream();
		const routed = routeContextNamespaceToolStream(source);
		source.push({ type: "start", partial: message });
		for (const [contentIndex, toolCall] of calls.entries()) source.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
		source.push(end === "done" ? { type: "done", reason: "toolUse", message } : { type: "error", reason: "error", error: message });
		source.end(message);
		const events = [];
		for await (const event of routed) events.push(event);
		for (const event of events) {
			const routedMessage = event.message ?? event.error ?? event.partial;
			assert.deepEqual(routedMessage.content.map(unrouteContextNamespaceToolCall), message.content);
			for (const [index, call] of routedMessage.content.slice(0, 9).entries()) {
				assert.equal(call.name, calls[index].namespace);
				assert.deepEqual(call.arguments, { action: calls[index].name, ...calls[index].arguments });
			}
			assert.equal(routedMessage.content.at(-1), unknown);
			if (event.type === "toolcall_end") assert.deepEqual(unrouteContextNamespaceToolCall(event.toolCall), calls[event.contentIndex]);
		}
		assert.deepEqual((await routed.result()).content.map(unrouteContextNamespaceToolCall), message.content);
	}
});
