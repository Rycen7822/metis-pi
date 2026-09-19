const MAX_EXECUTION_OUTPUT_CHARS = 32 * 1024 * 1024;
const MAX_EXECUTION_OUTPUT_ITEMS = 10_000;
const MAX_ERROR_CHARS = 256 * 1024;
const MAX_ERROR_FIELD_CHARS = 64 * 1024;
export function applyKernelOutput(message, execution) {
    const type = message.header.msg_type;
    if (type === "stream") {
        const text = message.content["text"];
        if (typeof text === "string" && text)
            emit(execution, { type: "input_text", text });
        return undefined;
    }
    if (type === "execute_result" || type === "display_data") {
        const data = message.content["data"];
        if (!data || typeof data !== "object" || Array.isArray(data))
            return undefined;
        const bundle = data;
        for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
            const encoded = bundle[mime];
            if (typeof encoded === "string") {
                emit(execution, { type: "input_image", image_url: `data:${mime};base64,${encoded}` });
                return undefined;
            }
        }
        const text = bundle["text/markdown"] ?? bundle["text/plain"];
        if (typeof text === "string" && text !== "undefined")
            emit(execution, { type: "input_text", text });
        return undefined;
    }
    if (type === "error") {
        const error = readKernelError(message.content);
        execution.status = "error";
        execution.errorName = error.errorName;
        execution.errorValue = error.errorValue;
        execution.errorText = error.errorText;
        return undefined;
    }
    return type === "status" && message.content["execution_state"] === "idle" ? "idle" : undefined;
}
export function finishKernelExecution(execution) {
    return {
        status: execution.status,
        items: execution.items,
        ...(execution.errorText ? { errorText: execution.errorText } : {}),
        ...(execution.errorName ? { errorName: execution.errorName } : {}),
        ...(execution.errorValue ? { errorValue: execution.errorValue } : {}),
    };
}
export function applyExecuteReplyError(result, reply) {
    if (result.status !== "ok" || reply.content["status"] !== "error")
        return result;
    return { ...result, status: "error", ...readKernelError(reply.content) };
}
function emit(execution, item) {
    if (execution.outputTruncated)
        return;
    const size = item.type === "input_text" ? item.text?.length ?? 0 : item.image_url?.length ?? 0;
    if (execution.items.length >= MAX_EXECUTION_OUTPUT_ITEMS || execution.outputChars + size > MAX_EXECUTION_OUTPUT_CHARS) {
        item = { type: "input_text", text: "[Notebook cell output truncated]" };
        execution.outputTruncated = true;
    }
    execution.items.push(item);
    execution.outputChars += item.type === "input_text" ? item.text?.length ?? 0 : item.image_url?.length ?? 0;
    execution.onOutput?.(item);
}
function boundedTraceback(value) {
    if (!Array.isArray(value))
        return undefined;
    let output = "";
    for (const line of value) {
        if (typeof line !== "string")
            continue;
        const separator = output ? "\n" : "";
        const remaining = MAX_ERROR_CHARS - output.length - separator.length;
        if (remaining <= 0)
            return markErrorTruncated(output);
        output += separator + line.slice(0, remaining);
        if (line.length > remaining)
            return markErrorTruncated(output);
    }
    return output || undefined;
}
function readKernelError(content) {
    const errorName = truncateErrorField(typeof content["ename"] === "string" ? content["ename"] : "Error");
    const errorValue = truncateErrorField(typeof content["evalue"] === "string" ? content["evalue"] : "Notebook cell failed");
    return {
        errorName,
        errorValue,
        errorText: boundedTraceback(content["traceback"]) ?? truncateErrorText(`${errorName}: ${errorValue}`),
    };
}
function truncateErrorField(value) {
    const marker = "\n[Notebook error field truncated]";
    return value.length <= MAX_ERROR_FIELD_CHARS
        ? value
        : `${value.slice(0, MAX_ERROR_FIELD_CHARS - marker.length)}${marker}`;
}
function truncateErrorText(value) {
    return value.length <= MAX_ERROR_CHARS ? value : markErrorTruncated(value);
}
function markErrorTruncated(value) {
    const marker = "\n[Notebook error truncated]";
    return `${value.slice(0, MAX_ERROR_CHARS - marker.length)}${marker}`;
}
