import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

export type BtwAccess = "read" | "write";

const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = [...READ_TOOLS, "bash", "edit", "write"];

export function btwTools(access: BtwAccess): string[] {
  return [...(access === "write" ? WRITE_TOOLS : READ_TOOLS)];
}

/** A dedicated native execution hook, not an instruction the model can override. */
export async function loadBtwAccessGuard(cwd: string, getAccess: () => BtwAccess): Promise<LoadExtensionsResult> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: "",
    extensionFactories: [pi => {
      pi.on("tool_call", event => {
        if (getAccess() === "read" && !READ_TOOLS.includes(event.toolName)) {
          return { block: true, reason: "BTW read mode: switch to write in the BTW page before using this tool." };
        }
      });
    }],
  });
  await loader.reload();
  const result = loader.getExtensions();
  if (result.errors.length) throw new Error(`BTW permission guard failed: ${result.errors[0].error}`);
  return result;
}
