import { stringify } from "smol-toml";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderEnvironment } from "./provider-env.mjs";

// Fixtures install their own credentials and endpoints after this preload.
clearProviderEnvironment(process.env);

const root = mkdtempSync(join(tmpdir(), "pi-web-access-test-"));
const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "metis-pi.toml"), stringify({ webAccess: { toolActivation: "eager" } }));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
