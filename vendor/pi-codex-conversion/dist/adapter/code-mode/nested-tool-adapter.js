import { Check } from "typebox/value";
export function toNestedTool(tool, usage, lifecycle = {}, contract = {}) {
    const kind = contract.kind ?? "function";
    const prepareInput = (input) => contract.prepareInput ? contract.prepareInput(input) : input;
    const invoke = async (input, context, signal) => {
        if (signal.aborted)
            throw new Error(`${tool.name} aborted`);
        const extensionContext = requireExtensionContext(context);
        const toolInput = prepareInput(input);
        const prepared = tool.prepareArguments
            ? tool.prepareArguments(toolInput)
            : toolInput;
        if (!Check(tool.parameters, prepared))
            throw new Error(`Invalid ${tool.name} arguments`);
        if (signal.aborted)
            throw new Error(`${tool.name} aborted`);
        const toolCallId = context.toolCallId ?? `code-mode-${tool.name}`;
        lifecycle.start?.(toolCallId, prepared);
        context.refreshTrace?.();
        let acceptingUpdates = true;
        try {
            const result = await tool.execute(toolCallId, prepared, signal, (update) => {
                if (acceptingUpdates)
                    forwardUpdate(update, context);
            }, extensionContext);
            acceptingUpdates = false;
            context.captureResult?.(result);
            const resultError = contract.resultError?.(result);
            if (resultError)
                throw new Error(resultError);
            return contract.resultValue?.(result) ??
                (contract.modelVisibleResult
                    ? modelVisibleNestedResult(result)
                    : compactNestedResult(result));
        }
        finally {
            acceptingUpdates = false;
            lifecycle.end?.(toolCallId);
        }
    };
    return {
        name: tool.name,
        usage,
        description: tool.description,
        ...(contract.translatePromptMetadata && tool.promptSnippet
            ? { promptSnippet: tool.promptSnippet }
            : {}),
        ...(contract.translatePromptMetadata && tool.promptGuidelines?.length
            ? { promptGuidelines: tool.promptGuidelines }
            : {}),
        deferLoading: contract.deferLoading ?? false,
        kind,
        ...(contract.textOutput ? { textOutput: contract.textOutput } : {}),
        ...(contract.blocking ? { blocking: true } : {}),
        ...(contract.isBlocking ? { isBlocking: contract.isBlocking } : {}),
        ...(contract.discoverWhenDeferred ? { discoverWhenDeferred: true } : {}),
        ...(contract.translatePromptMetadata ? { translatePromptMetadata: true } : {}),
        ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
        ...(contract.toolName ? { toolName: contract.toolName } : {}),
        ...(contract.yieldTimeMs === undefined ? {} : { yieldTimeMs: contract.yieldTimeMs }),
        ...(kind === "function" ? { inputSchema: tool.parameters } : {}),
        ...(tool.renderCall
            ? {
                renderCall: (input, theme, context) => tool.renderCall(prepareInput(input), theme, context),
            }
            : {}),
        ...(tool.renderResult
            ? {
                renderResult: (result, options, theme, context) => tool.renderResult(result, options, theme, context),
            }
            : {}),
        invoke,
    };
}
export function codeModeImageResult(result, outputHint) {
    const image = result.content.find((item) => item.type === "image");
    if (!image || image.type !== "image")
        return compactNestedResult(result);
    const detail = "detail" in image && typeof image.detail === "string"
        ? image.detail
        : "high";
    return {
        image_url: `data:${image.mimeType};base64,${image.data}`,
        detail,
        ...(outputHint ? { output_hint: outputHint } : {}),
    };
}
function requireExtensionContext(context) {
    if (!context.extensionContext)
        throw new Error("Code-mode Pi context is unavailable");
    return context.extensionContext;
}
function forwardUpdate(update, context) {
    context.onUpdate?.(update);
}
function compactNestedResult(result) {
    const images = result.content.filter((item) => item.type === "image");
    if (images.length > 0)
        return { content: result.content, details: result.details };
    if (result.details &&
        typeof result.details === "object" &&
        "output" in result.details)
        return result.details;
    const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    return text || "(no output)";
}
function modelVisibleNestedResult(result) {
    if (result.content.every((item) => item.type === "text"))
        return result.content.map((item) => item.text).join("\n") || "(no output)";
    return {
        content: result.content.map((item) => ({ ...item })),
    };
}
