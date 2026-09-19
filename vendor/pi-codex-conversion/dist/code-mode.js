import { toNestedTool } from "./adapter/code-mode/nested-tool-adapter.js";
import { codeModeNameForToolIdentity } from "./tools/code-mode/tool-identity.js";
export { registerCodeModeExtensionTools, } from "./code-mode-extension-tools.js";
export function adaptToolForCodeMode(tool, options) {
    if (options.kind === "freeform" && !options.prepareInput) {
        throw new Error("Freeform Code Mode tools require prepareInput");
    }
    const nestedTool = options.toolName
        ? { ...tool, name: codeModeNameForToolIdentity(options.toolName) }
        : tool;
    const adapted = toNestedTool(nestedTool, options.usage, {}, {
        modelVisibleResult: true,
        translatePromptMetadata: options.promptMetadata !== false,
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.prepareInput ? { prepareInput: options.prepareInput } : {}),
        ...(options.toolName ? { toolName: options.toolName } : {}),
        ...(options.resultValue ? { resultValue: options.resultValue } : {}),
        ...(options.blocking === true ? { blocking: true } : {}),
        ...(typeof options.blocking === "function"
            ? { isBlocking: options.blocking }
            : {}),
        ...(options.deferLoading
            ? { deferLoading: true, discoverWhenDeferred: true }
            : {}),
    });
    return { ...adapted, topLevelName: tool.name };
}
