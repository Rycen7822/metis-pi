import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { disableNetwork, FAKE_API_KEY } from "../helpers/vendor-codex-provider.mjs";
import { createHistoryNotesTools } from "../../vendor/pi-codex-conversion/dist/context-management/history-notes.js";
import {
	rewriteContextNamespaceTools,
	routeContextNamespaceToolStream,
	unrouteContextNamespaceToolCall,
} from "../../vendor/pi-codex-conversion/dist/context-management/namespace-tools.js";

test.beforeEach(disableNetwork);

// Independent wire/argument goldens, established against 312bc5d before changing
// the contract owner. Each example lists the operation's complete legal fields;
// schema types and required fields stay independent of the production specification.
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
// Columns: namespace, operation, every accepted argument, required arguments,
// encrypted argument. Descriptive prose is intentionally outside this wire contract.
const cases = [
	["history", "list_windows", { agent_name: null, limit: 1, recent_first: false }],
	["history", "list_items", {
		agent_name: null, limit: 1, max_chars_per_item: 1, recent_first: true,
		role: null, tool_name: null, tool_namespace: null, window_id: null,
	}],
	["history", "read_item", { agent_name: null, item_id: "user-entry", limit_chars: 1, offset_chars: 0, window_id: "window-0" }, ["item_id", "window_id"]],
	["history", "search_contents", {
		agent_name: null, limit: 1, query: "cipher-query", recent_first: false,
		role: "user", tool_name: null, tool_namespace: null, window_id: null,
	}, ["query"], "query"],
	["notes", "list_files_by_prefix", { file_order: "descending", file_order_by: "updated_at", max_results: 1, prefix: null }],
	["notes", "read_file", { path: "checkpoint.md", start_line: -1, stop_line: null }, ["path"]],
	["notes", "search_contents", { max_files: 1, max_matches_per_file: 1, path_prefix: null, query: "cipher-query", recent_file_first: false }, ["query"], "query"],
	["notes", "append_to_file", { path: "checkpoint.md", text: "" }, ["text", "path"], "text"],
	["notes", "write_file", { path: "checkpoint.md", text: "" }, ["text", "path"], "text"],
].map(([namespace, action, args, required, encrypted]) => ({ namespace, action, args, required, encrypted }));
const fieldsFor = (namespace) => namespace === "history" ? historyFields : notesFields;
const json = (value) => JSON.parse(JSON.stringify(value));
const contract = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === "description" && typeof item === "string" ? undefined : item));
const routers = () => createHistoryNotesTools().map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));

function goldenNamespace(namespace, encrypted) {
	return {
		type: "namespace", name: namespace,
		tools: cases.filter((item) => item.namespace === namespace).map((item) => {
			const properties = Object.fromEntries(Object.keys(item.args).map((field) => [field, json(fieldsFor(namespace)[field])]));
			if (item.action === "read_item") properties.window_id = { type: "string" };
			if (encrypted) {
				for (const property of Object.values(properties)) delete property.minimum;
				if (item.encrypted) properties[item.encrypted].encrypted = true;
			}
			return {
				type: "function", name: item.action, strict: false,
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
		assert.deepEqual(contract(result.tools), [...expected, untouched]);
		assert.deepEqual(contract(result.input[0].tools), expected);
		assert.deepEqual(json(input), before);
		assert.equal(result.tools[2], untouched);
		assert.deepEqual(json(rewriteContextNamespaceTools(result, { encrypted })), json(result));
		// Transport consumers may modify their request: no nested arrays may
		// alias the shared contract or another declaration in the same request.
		result.tools[0].tools[1].parameters.properties.role.anyOf[0].enum.push("MUTATED");
		result.tools[1].tools[4].parameters.required.push("MUTATED");
		assert.deepEqual(contract(result.input[0].tools), expected);
		assert.deepEqual(contract(rewriteContextNamespaceTools({ tools: routers() }, { encrypted }).tools), expected);
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

test("context operations enforce remote wire rules, failures and local completion semantics", async (t) => {
	const requests = [];
	const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
		requests.push({ url, init });
		return new Response(JSON.stringify({ encrypted_output: "opaque-result" }));
	});
	const entries = [];
	let mode = "remote", completedWrites = 0;
	const tools = createHistoryNotesTools({
		appendEntry(customType, data) { entries.push({ type: "custom", id: `note-${entries.length}`, customType, data }); },
	}, () => mode, () => () => { completedWrites++; return mode === "remote"; });
	const ctx = context(entries);
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
		const crossActionField = Object.keys(fieldsFor(item.namespace)).find((field) => !Object.hasOwn(item.args, field));
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
	assert.equal(entries.length, 0);

	// Failed remote writes cannot switch to local storage or complete a window.
	const notes = tools[1];
	for (const [respond, error] of [
		[() => new Response("failure", { status: 503 }), /backend failed \(503\)/],
		[() => new Response("[]"), /returned invalid data/],
		[() => new Response('{"images":[{"data":7}]}'), /invalid image content/],
		[() => { throw new Error("offline-abort"); }, /offline-abort/],
	]) {
		fetch.mock.mockImplementation(respond);
		for (const action of ["append_to_file", "write_file"])
			await assert.rejects(execute(notes, { action, path: "checkpoint.md", text: "" }, ctx), error);
	}
	const nonCodex = context();
	nonCodex.model.api = "openai-responses";
	await assert.rejects(execute(notes, { action: "write_file", path: "checkpoint.md", text: "" }, nonCodex), /require Codex transport/);
	assert.equal(fetch.mock.callCount(), 17);
	assert.equal(entries.length, 0);
	assert.equal(completedWrites, 2);

	fetch.mock.mockImplementation(() => assert.fail("local operations must not fetch"));
	for (mode of ["local", "tree"]) {
		for (const action of ["write_file", "append_to_file"]) {
			const result = await execute(notes, { action, path: "checkpoint.md", text: "" }, ctx);
			assert.equal(result.terminate, undefined);
		}
		const read = await execute(notes, { action: "read_file", path: "checkpoint.md" }, ctx);
		assert.equal(read.details.codexHistoryNotes.file.content, "");
	}
	assert.equal(completedWrites, 6, "reads do not complete writes");
});

test("all namespace operations round-trip through partial, completed and failed streams", async () => {
	const calls = cases.map((item, index) => ({ type: "toolCall", id: `call-${index}`, namespace: item.namespace, name: item.action, arguments: item.args }));
	const unknown = { type: "toolCall", id: "unknown", namespace: "history", name: "future_operation", arguments: {} };
	const message = { role: "assistant", content: [...calls, unknown], stopReason: "toolUse" };
	const expected = [...calls.map(({ namespace, name, arguments: args, ...rest }) => ({
		...rest, namespace, name: namespace, arguments: { action: name, ...args },
	})), unknown];
	assert.deepEqual(expected.map(unrouteContextNamespaceToolCall), message.content);
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
			assert.deepEqual(routedMessage.content, expected);
			if (event.type === "toolcall_end") assert.deepEqual(event.toolCall, expected[event.contentIndex]);
		}
		assert.deepEqual((await routed.result()).content, expected);
	}
});
