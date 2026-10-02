/** Project instructions for a managed Pi child. Pi's project context discovery is
 * disabled for this child; keep Pi's global context and use the Codex scope's
 * SUBAGENT-PI.md instead of AGENTS.md from the child's working directory. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function readContext(dir: string, names: string[]) {
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    return { path, content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") };
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const scopeCwd = process.env.PI_AGENTS_SCOPE_CWD;
  delete process.env.PI_AGENTS_SCOPE_CWD;
  if (!scopeCwd) throw new Error("Managed context requires the Codex scope cwd");

  // Mirror Pi's single-file-per-directory precedence for its GLOBAL context.
  const global = readContext(getAgentDir(), ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
  const delegated = readContext(scopeCwd, ["SUBAGENT-PI.md"]);
  const contextFiles = [global, delegated].filter((file) => file !== undefined);

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.contextFiles = contextFiles.map((file) => ({ ...file }));
  });
  process.stderr.write("subagent-pi-context ready\n");
}
