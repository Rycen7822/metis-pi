import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGatewayRetry } from "../src/retry-policy.ts";

export default function retryPolicyExtension(pi: ExtensionAPI): void {
  let release: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    release?.();
    release = undefined;
    try { release = installGatewayRetry(AgentSession, ctx.sessionManager); }
    catch (error) { ctx.ui.notify(String(error), "warning"); }
  });
  pi.on("session_shutdown", () => { release?.(); release = undefined; });
}
