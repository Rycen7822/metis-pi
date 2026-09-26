// Token rewriting and completion consume explicit body data; no discovery IO.
import test from "node:test";
import assert from "node:assert/strict";
import { createSkillInput, createSkillAutocompleteWrapper } from "../../src/skill-input.ts";

const alpha = '<skill name="alpha" location="/skills/alpha/SKILL.md">\nAlpha body.\n</skill>';
const beta = '<skill name="beta" location="/skills/beta/SKILL.md">\nBeta body.\n</skill>';

test("skill input preserves native commands and rewrites explicit requests without changing images", () => {
  const mux = createSkillInput((name) => ({ alpha, beta })[name as "alpha" | "beta"] ?? null);
  for (const input of ["hello world", "/skill:alpha hello", " /skill:alpha /skill:beta", "$alpha rest", "plain"]) {
    assert.equal(mux.onInput({ type: "input", source: "interactive", text: input }).action, "continue", input);
  }

  for (const images of [[{ type: "image" as const, data: "offline-image", mimeType: "image/png" }], undefined]) {
    const result = mux.onInput({ type: "input", source: "interactive", text: "/skill:alpha /skill:beta go", images });
    assert.ok(result.action === "transform");
    assert.equal(result.images, images);
    assert.ok(result.text.includes("go"));
  }

  assert.equal(mux.expand("￥alpha just do it"), `${alpha}\n\njust do it`);
});

const skills = [
  { name: "alpha", description: "the alpha skill" },
  { name: "beta", description: "the beta skill" },
  { name: "alphabet", description: "longer" },
];
const baseResult = { items: [{ value: "builtin", label: "builtin" }], prefix: "/skill:a" };
const query = (force = false) => ({ signal: new AbortController().signal, force });

test("autocomplete yields to native results except a forced skill menu, then returns to files", async () => {
  let nativeResult: typeof baseResult | null = null;
  const wrapped = createSkillAutocompleteWrapper(() => skills)({
    async getSuggestions() { return nativeResult; },
    applyCompletion(): never { throw new Error("completion is not exercised by this fixture"); },
    shouldTriggerFileCompletion() { return false; },
  });
  const yen = await wrapped.getSuggestions(["￥al"], 0, 3, query());
  assert.ok(yen && "items" in yen);
  assert.equal(yen.prefix, "￥al");
  assert.deepEqual(yen.items.map((item) => item.value), ["￥alpha ", "￥alphabet "]);
  assert.equal(yen.items[0].label, "skill:alpha");
  assert.equal(yen.items[0].description, "the alpha skill");
  const second = await wrapped.getSuggestions(["/skill:alpha /ta"], 0, 16, query());
  assert.ok(second && "items" in second);
  assert.deepEqual(second.items.map((item) => item.value), ["/skill:beta "]);
  assert.equal(second.prefix, "/ta");
  for (const [text, column] of [["/skill:alpha /zzz", 17], ["hello /", 7]] as const) {
    assert.equal(await wrapped.getSuggestions([text], 0, column, query()), null);
  }
  nativeResult = baseResult;
  for (const [text, column] of [["/skill:a", 8], ["/skill:alpha /a", 15]] as const) {
    assert.equal(await wrapped.getSuggestions([text], 0, column, query()), baseResult);
  }
  const fileResult = { items: [{ value: "./file.txt", label: "./file.txt" }], prefix: "/" };
  nativeResult = fileResult;
  for (const [text, column, trigger] of [
    ["/skill:alpha /", 14, true], ["/skill:alpha ￥", 15, true], ["￥alpha /", 9, true], ["plain text", 10, false],
  ] as const) assert.equal(wrapped.shouldTriggerFileCompletion?.([text], 0, column), trigger);
  const forced = await wrapped.getSuggestions(["/skill:alpha /"], 0, 14, query(true));
  assert.ok(forced && "items" in forced);
  assert.deepEqual(forced.items.map((item) => item.value), ["/skill:alpha ", "/skill:beta ", "/skill:alphabet "]);
  assert.equal(forced.prefix, "/");
  for (const [text, column] of [["/skill:alpha /zzz", 17], ["/etc/", 5]] as const) {
    assert.equal(await wrapped.getSuggestions([text], 0, column, query(true)), fileResult);
  }
});
