var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { mergeAdapterTools, restoreTools, stripAdapterTools } from "./adapter/activation/activation.js";
import { getCodexSkillPaths } from "./adapter/prompt/skills.js";
import { registerCodexConversion } from "./extension/register.js";
export default async function codexConversion(pi) {
    const changelogUrl = import.meta.url.endsWith(".ts")
        ? new URL("../changelog.ts", import.meta.url)
        : new URL("../changelog.js", import.meta.url);
    const { default: registerPackageChangelog } = (await import(__rewriteRelativeImportExtension(changelogUrl.href)));
    registerPackageChangelog(pi);
    await registerCodexConversion(pi);
}
export { createApplyPatchTool, isApplyPatchToolDetails, registerApplyPatchResultEvent, } from "./tools/apply-patch/tool.js";
export { sendCodexDeveloperMessage, trySendCodexDeveloperMessage, } from "./developer-messages.js";
export { getCodexSkillPaths, mergeAdapterTools, restoreTools, stripAdapterTools };
