import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { comparePrefixes, observePrefix } from "../../src/cache-prefix.ts";

const model = { provider: "openai", api: "openai-responses", id: "fixture", baseUrl: "https://example.invalid/v1" };
const initial = { role: "developer", content: "private initial text" };
const tool = { type: "function", name: "codemode", parameters: { type: "object" } };
const context = rules => normalizeContext({ messages: [{ role: "system", content: "", sections: { rules }, timestamp: 0 }] });
const observe = (payload, rules = "private rules", route = model) => observePrefix(payload, route, context(rules));
const body = { model: "fixture", input: [initial], tools: [tool] };

test("prefix diagnostics distinguish append-only input from changed system sections, schema and cache settings", () => {
  const before = observe(body);
  const appended = observe({ ...body, input: [initial, { role: "user", content: "private extra text" }] });
  assert.deepEqual(comparePrefixes(before, appended), ["Input only appended: 1 new item(s) after 1 unchanged."]);
  const changed = observe({ ...body, input: [{ ...initial, content: "private revised initial text" }],
    tools: [{ ...tool, parameters: { type: "object", additionalProperties: false } }],
    prompt_cache_key: "private key" }, "private changed rules");
  const report = comparePrefixes(before, changed).join("\n");
  assert.match(report, /Cache request settings changed/);
  assert.match(report, /Top-level tool declarations changed at #1 \(codemode\)/);
  assert.match(report, /First changed input item: #1 \(system prompt\)/);
  assert.match(report, /Logical system sections changed: rules/);
  assert.doesNotMatch(JSON.stringify({ before, changed, report }), /private |example\.invalid/);
});

test("prefix diagnostics do not compare across routes or pretend oversized or unsupported captures match", () => {
  const before = observe(body);
  assert.match(comparePrefixes(before, observe(body, "private rules", { ...model, baseUrl: "https://other.invalid/v1" }))[0],
    /Model or route changed/);
  assert.match(comparePrefixes(before, observe({ input: new Array(20_000).fill(initial) }))[0], /capture limit/);
  assert.match(comparePrefixes(before, observe({ input: "not an item array" }))[0], /unsupported payload/);
});
