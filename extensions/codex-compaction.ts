import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "../src/codex-compaction.ts";

/** Codex remote checkpoints for both Pi /compact and automatic compaction. */
export default function (pi: ExtensionAPI) {
  registerCodexCompaction(pi);
}
