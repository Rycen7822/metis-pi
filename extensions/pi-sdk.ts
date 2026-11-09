import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureSDK } from "../src/pi-sdk/install.mjs";

export default function installPiSDK(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const result = await ensureSDK({ runningPackageDir: getPackageDir() });
      if (result.status === "unmanaged") {
        ctx.ui.notify("Metis SDK 补丁需要 Pi managed 安装布局；当前宿主未修改。", "warning");
      } else if (result.restartRequired) {
        ctx.ui.notify("Metis 已安装全部 Pi SDK 补丁，请重启 Pi；/reload 无法替换当前 SDK。", "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Metis SDK 安装异常：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
}
