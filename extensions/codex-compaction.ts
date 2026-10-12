import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "../src/codex-compaction.ts";

/** OpenAI / Codex remote checkpoints for Pi /compact and automatic compaction. */
export default function (pi: ExtensionAPI) {
  registerCodexCompaction(pi);
}
