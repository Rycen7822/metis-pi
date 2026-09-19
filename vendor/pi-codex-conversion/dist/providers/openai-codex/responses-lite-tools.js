const DEFAULT_TOOL_NAMESPACE = "functions";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isDefaultNamespace(value) {
    return isRecord(value)
        && value["type"] === "namespace"
        && value["name"] === DEFAULT_TOOL_NAMESPACE
        && Array.isArray(value["tools"]);
}
export function namespaceResponsesLiteTools(tools) {
    const children = [];
    const output = [];
    let insertionIndex;
    let description = "";
    for (const tool of tools) {
        if (isRecord(tool) && (tool["type"] === "function" || tool["type"] === "custom")) {
            insertionIndex ??= output.length;
            children.push(tool);
            continue;
        }
        if (isDefaultNamespace(tool)) {
            insertionIndex ??= output.length;
            children.push(...tool.tools);
            if (typeof tool["description"] === "string" && tool["description"].trim()) {
                description = tool["description"];
            }
            continue;
        }
        output.push(tool);
    }
    if (children.length === 0)
        return output;
    output.splice(insertionIndex ?? output.length, 0, {
        type: "namespace",
        name: DEFAULT_TOOL_NAMESPACE,
        description,
        tools: children,
    });
    return output;
}
export function namespaceResponsesLiteInputTools(input) {
    return input.map((item) => {
        if (!isRecord(item) || !Array.isArray(item["tools"]))
            return item;
        if (item["type"] !== "additional_tools" && item["type"] !== "tool_search_output")
            return item;
        return { ...item, tools: namespaceResponsesLiteTools(item["tools"]) };
    });
}
