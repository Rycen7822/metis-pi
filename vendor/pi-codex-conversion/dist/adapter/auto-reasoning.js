import { StringEnum, Type } from "@earendil-works/pi-ai";
import { resolveCodexRuntimePlanForState } from "./activation/runtime-plan.js";
import { codexReasoningLane } from "./reasoning-updates.js";
import { auxiliaryToolRenderers, displayRecord } from "../ui/tool-rendering/auxiliary-tool.js";
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PARAMETERS = Type.Object({ level: StringEnum(["low", "medium", "high"]) });
export function createAutoReasoning(pi, state) {
    let baseline;
    let applied;
    const matches = (ctx) => baseline && ctx.model
        && baseline.lane === codexReasoningLane(ctx.model)
        && baseline.session === ctx.sessionManager.getSessionId();
    const begin = (ctx) => {
        if (!resolveCodexRuntimePlanForState(ctx, state).autoReasoning || !ctx.model)
            return;
        if (!matches(ctx)) {
            baseline = { level: pi.getThinkingLevel(), lane: codexReasoningLane(ctx.model), session: ctx.sessionManager.getSessionId() };
            applied = undefined;
        }
    };
    return {
        begin,
        settle(ctx) {
            const restore = matches(ctx) && applied !== undefined && pi.getThinkingLevel() === applied ? baseline?.level : undefined;
            baseline = undefined;
            applied = undefined;
            if (restore !== undefined)
                pi.setThinkingLevel(restore);
        },
        tool: {
            name: "change_reasoning",
            label: "Change Reasoning",
            description: "Adjust effort by work phase, not per tool call; user starting level is the floor, restored when the run settles",
            parameters: PARAMETERS,
            ...auxiliaryToolRenderers("Reasoning adjustment failed", (_args, result) => {
                const details = displayRecord(result?.details);
                return {
                    active: "Adjusting reasoning",
                    complete: "Adjusted reasoning",
                    ...(result ? { summary: `${details["level"]} effort · user floor ${details["floor"]}`, body: "" } : {}),
                };
            }),
            async execute(_id, params, _signal, _update, ctx) {
                if (!resolveCodexRuntimePlanForState(ctx, state).autoReasoning)
                    throw new Error("change_reasoning requires Auto reasoning enabled on Astra Codex transport");
                begin(ctx);
                if (!baseline)
                    throw new Error("No Astra reasoning baseline");
                const previous = pi.getThinkingLevel();
                // A user selector change supersedes the tool's last selection.
                if (previous !== (applied ?? baseline.level))
                    baseline.level = previous;
                const effective = levels.indexOf(params.level) < levels.indexOf(baseline.level) ? baseline.level : params.level;
                pi.setThinkingLevel(effective);
                applied = pi.getThinkingLevel();
                const details = { level: applied, floor: baseline.level };
                return { content: [{ type: "text", text: JSON.stringify(details) }], details };
            },
        },
    };
}
