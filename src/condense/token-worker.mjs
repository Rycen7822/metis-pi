import { parentPort } from "node:worker_threads";
import { Tiktoken } from "tiktoken/lite";
import ranks from "tiktoken/encoders/o200k_base.json" with { type: "json" };
import { createHash } from "node:crypto";

const encoding = new Tiktoken(ranks.bpe_ranks, ranks.special_tokens, ranks.pat_str);
const cache = new Map();
function difference(before, after, used) {
  const remaining = new Map();
  for (const [messages, sign] of [[before, 1], [after, -1]]) for (const message of messages) {
    const text = JSON.stringify(message);
    const key = createHash("sha256").update(text).digest("hex");
    used.add(key);
    const old = remaining.get(key);
    remaining.set(key, { text, copies: (old?.copies ?? 0) + sign });
  }
  let delta = 0;
  for (const [key, { text, copies }] of remaining) {
    if (!copies) continue; // Identical whole messages cancel exactly, including multiplicity.
    let tokens = cache.get(key);
    if (tokens === undefined) { tokens = encoding.encode(text, [], []).length; cache.set(key, tokens); }
    delta += copies * tokens;
  }
  return delta;
}

parentPort.on("message", ({ id, before, after }) => {
  try {
    const used = new Set();
    const result = { id, delta: difference(before, after, used) };
    for (const key of cache.keys()) if (!used.has(key)) cache.delete(key);
    parentPort.postMessage(result);
  }
  catch { parentPort.postMessage({ id, error: true }); }
});
parentPort.on("close", () => encoding.free());
