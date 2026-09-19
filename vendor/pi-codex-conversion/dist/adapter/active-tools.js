import { CODE_MODE_EXEC_CONSTRAINED_SAMPLING } from "../tools/code-mode/exec-contract.js";
import { getExperimentalToolSampling } from "../tools/tool-sampling.js";
export function getActiveToolsInActiveOrder(pi, codeMode = false) {
    const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    return pi.getActiveTools().flatMap((name) => {
        const tool = toolsByName.get(name);
        if (!tool)
            return [];
        const constrainedSampling = codeMode && tool.name === "exec"
            ? CODE_MODE_EXEC_CONSTRAINED_SAMPLING
            : getExperimentalToolSampling(tool.name);
        return [{
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                ...(constrainedSampling ? { constrainedSampling } : {}),
            }];
    });
}
