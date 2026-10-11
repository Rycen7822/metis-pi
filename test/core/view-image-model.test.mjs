import test from "node:test";
import assert from "node:assert/strict";
import { resolveImageDescriptionModel } from "../../src/execution/view-image/tool.ts";

const context = models => ({ modelRegistry: { getAvailable: () => models } });

for (const provider of ["openai", "openai-codex"]) {
  test(`image descriptions accept an authenticated ${provider} vision model`, () => {
    const model = { provider, id: "gpt-5.6-luna", input: ["text", "image"] };
    assert.equal(resolveImageDescriptionModel(context([model])), model);
  });
}

test("image descriptions prefer the latest mini with vision and exclude text-only candidates", () => {
  const older = { provider: "openai-codex", id: "gpt-4.1-mini", input: ["image"] };
  const newer = { provider: "openai", id: "gpt-5.4-mini", input: ["image"] };
  const textOnly = { provider: "openai", id: "gpt-6-mini", input: ["text"] };
  assert.equal(resolveImageDescriptionModel(context([older, newer, textOnly])), newer);
  assert.throws(() => resolveImageDescriptionModel(context([textOnly])), /authenticated OpenAI/);
});
