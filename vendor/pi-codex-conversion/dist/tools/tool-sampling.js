const PREFER_STRICT_TOOL_SAMPLING = {
    type: "json_schema",
    strict: "prefer",
};
const STRICT_FUNCTION_TOOLS = new Set(["exec_command", "apply_patch", "wait", "notebook"]);
export function getExperimentalToolSampling(toolName) {
    return process.env["PI_EXPERIMENTAL"] === "1" && STRICT_FUNCTION_TOOLS.has(toolName)
        ? PREFER_STRICT_TOOL_SAMPLING
        : undefined;
}
