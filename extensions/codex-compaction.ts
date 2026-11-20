import { hasMetisHostSDK } from "../src/pi-sdk/host.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "../src/remote-compaction/runtime.ts";

/** OpenAI / Codex remote checkpoints for Pi /compact and automatic compaction. */
export default function (pi: ExtensionAPI) {
  if (!hasMetisHostSDK()) return;
  registerCodexCompaction(pi);
}
