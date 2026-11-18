import assert from "node:assert/strict";
import test from "node:test";
import toolSearch from "../../extensions/tool-search.ts";
import { OWNED_TOOL_SEARCH_ENTRY } from "../../src/presentation/tool-source.mjs";

function fixture() {
  const handlers = new Map(), tools = new Map();
  let active = ["direct"];
  const pi = {
    registerTool: tool => tools.set(tool.name, { ...tool, sourceInfo: { path: OWNED_TOOL_SEARCH_ENTRY } }),
    on: (name, fn) => handlers.set(name, fn),
    getAllTools: () => [...tools.values()], getActiveTools: () => [...active], setActiveTools: names => { active = [...names]; },
  };
  const namespace = { name: "fixtures", aliases: ["fixture-alias"], description: "Fixtures", instructions: "Fixture usage" };
  for (const [name, exposure] of [["direct", "direct"], ["mcp__a__lookup", "deferred"], ["mcp__b__lookup", "codemode"], ["secret", "hidden"]]) {
    pi.registerTool({ name, exposure, description: "lookup", ...(exposure === "direct" ? {} : { namespace }),
      parameters: { type: "object", properties: { value: { type: "integer" } } },
      outputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } });
  }
  toolSearch(pi);
  const emit = (type, event = {}) => handlers.get(type)(event, {});
  emit("session_start");
  return {
    tools, active: pi.getActiveTools, emit,
    call: async args => (await tools.get("tool_search").execute("call", args)).structuredContent,
    notice: () => emit("context", { messages: [] })?.messages.at(-1)?.content,
    end: stopReason => emit("message_end", { message: { role: "assistant", stopReason } }),
  };
}

test("search only lists candidates; describe activates one exact visible match", async () => {
  const f = fixture(), original = f.active();
  const result = await f.call({ query: "lookup" });
  assert.deepEqual(result.activated, []);
  assert.deepEqual(f.active(), original);
  assert.deepEqual(result.matches.filter(m => !m.active && m.callable).map(m => m.name), ["mcp__a__lookup", "mcp__b__lookup"]);
  assert.ok(!result.matches.some(m => m.name === "secret"));
  for (const name of ["lookup", "secret"]) assert.deepEqual((await f.call({ action: "describe", name })).matches, []);
  assert.deepEqual(f.active(), original);
  const name = "mcp__a__lookup";
  const described = await f.call({ action: "describe", name });
  assert.deepEqual(described.activated, [name]);
  assert.equal(described.matches[0].active, true);
  assert.equal(described.matches[0].parameters.properties.value.type, "integer");
  assert.match(described.matches[0].signature, /Promise<[\s\S]*token: string/);
  assert.deepEqual((await f.call({ action: "describe", name })).activated, []);
  const again = await f.call({ query: "lookup" });
  assert.deepEqual(again.activated, []);
  assert.ok(again.matches.some(m => m.name === name && m.active));
  assert.deepEqual(f.active(), [...original, name]);
});

test("namespace-only search follows aliases, returns instructions and pages only visible tools", async () => {
  const f = fixture(), original = f.active();
  const args = { namespace: "fixture-alias", limit: 1 };
  const first = await f.call(args);
  assert.deepEqual(first.matches.map(tool => tool.name), ["mcp__a__lookup"]);
  assert.deepEqual(first.namespaces, [{ name: "fixtures", description: "Fixtures", instructions: "Fixture usage" }]);
  assert.equal(first.nextOffset, 1);
  const next = await f.call({ ...args, offset: first.nextOffset });
  assert.deepEqual(next.matches.map(tool => tool.name), ["mcp__b__lookup"]);
  assert.equal(next.nextOffset, undefined);
  assert.deepEqual(f.active(), original);
});

test("only previously declared or described parameter changes are announced, and failed requests do not acknowledge them", async () => {
  const f = fixture(), lookup = "mcp__a__lookup", unseen = "mcp__b__lookup";
  assert.equal(f.notice(), undefined);
  f.end("stop");
  await f.call({ action: "describe", name: lookup });
  for (const name of [lookup, unseen, "direct"]) f.tools.get(name).parameters.properties.value.type = "string";
  const notice = f.notice();
  assert.match(notice, /direct/);
  assert.ok(notice.includes(lookup));
  assert.ok(!notice.includes(unseen));
  assert.match(notice, /describe/);
  f.end("error");
  // A script can inspect the latest schema without emitting it to the model. It cannot acknowledge a failed request.
  await f.call({ action: "describe", name: lookup });
  assert.equal(f.notice(), notice);
  f.end("aborted");
  assert.equal(f.notice(), notice);
  f.tools.get(lookup).parameters.properties.value.type = "boolean"; // changed again while the request was in flight
  f.end("stop");
  const next = f.notice();
  assert.ok(next.includes(lookup) && !next.includes("direct"));
  f.end("stop");
  const { properties, type } = f.tools.get(lookup).parameters;
  f.tools.get(lookup).parameters = { properties, type };
  assert.equal(f.notice(), undefined, "reordering object keys is not a parameter change");
  f.emit("session_shutdown");
  f.emit("session_start");
  properties.value.type = "number";
  assert.equal(f.notice(), undefined, "another session did not see this deferred definition");
});
