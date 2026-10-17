import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { TSchema } from "typebox";

export interface SubagentTool {
  name: string; description: string; inputSchema: TSchema; outputSchema: TSchema;
  _op: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
/** Packaged backend assets; independent of any user state directory. */
export interface RuntimePackage { root: string; tools: SubagentTool[]; baseEnvKeys: string[]; scopeEnvKeys: string[]; maxFrame: number }
export function runtimePackage(): RuntimePackage {
  const root = fileURLToPath(new URL("../backend/", import.meta.url));
  const metadata = JSON.parse(readFileSync(join(root, "tools.json"), "utf8"));
  if (metadata.hostProtocol !== 1 || !Array.isArray(metadata.scopeEnvKeys))
    throw new Error("Metis subagent schema needs host protocol 1 with scopeEnvKeys; run npm run prepare:subagents");
  return { root, ...metadata };
}
