import { fileURLToPath } from "node:url";

// Physical entry identities shared by UI loaders and the plain-Node worker.
export const OWNED_EXECUTION_ENTRY = fileURLToPath(new URL("../../extensions/execution.ts", import.meta.url));
export const OWNED_FUSION_ENTRY = fileURLToPath(new URL("../../extensions/action-fusion.ts", import.meta.url));
export const OWNED_NEURAL_SEARCH_ENTRY = fileURLToPath(new URL("../../extensions/neural-search.ts", import.meta.url));
export const OWNED_SUBAGENTS_ENTRY = fileURLToPath(new URL("../../extensions/subagents.ts", import.meta.url));

/** Registration authority only; never derive this from serialized model messages. */
export function toolPresentation(name, info) {
  if (!info || typeof info !== "object") return;
  const { source, path } = info;
  if (typeof source !== "string") return;
  if (source === "builtin" && path === `builtin:${name}`) return "builtin";
  if ((name === "edit" || name === "write") && path === OWNED_FUSION_ENTRY) return "fusion";
  if (name === "exec_command" && path === OWNED_EXECUTION_ENTRY) return "execution";
  if (name === "neural_search" && path === OWNED_NEURAL_SEARCH_ENTRY) return "neural";
  if ((name.startsWith("subagents_") || name.startsWith("pi_")) && path === OWNED_SUBAGENTS_ENTRY) return "subagents";
  if ((name === "ffgrep" || name === "fffind") && typeof path === "string"
    && (source === "npm:@ff-labs/pi-fff" || source.startsWith("npm:@ff-labs/pi-fff@"))) return "fff";
}
