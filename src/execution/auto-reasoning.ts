import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";



import { auxiliaryToolRenderers, displayRecord } from "./ui/auxiliary-tool.ts";

type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;
const levels: readonly Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PARAMETERS = Type.Object({ level: StringEnum(["low", "medium", "high"] as const) });

interface AutoReasoning {
	begin(ctx: ExtensionContext): void;
	settle(ctx: ExtensionContext): void;
	tool: ToolDefinition<typeof PARAMETERS, { level: Level; floor: Level }>;
}

export function createAutoReasoning(pi: ExtensionAPI, enabled: () => boolean): AutoReasoning {
	let baseline: { level: Level; lane: string; session: string } | undefined;
	let applied: Level | undefined;
	const matches = (ctx: ExtensionContext) => baseline && ctx.model
		&& baseline.lane === `${ctx.model.provider}/${ctx.model.id}`
		&& baseline.session === ctx.sessionManager.getSessionId();
	const begin = (ctx: ExtensionContext) => {
		if (!(enabled() && ctx.model?.reasoning) || !ctx.model) return;
		if (!matches(ctx)) {
			baseline = { level: pi.getThinkingLevel(), lane: `${ctx.model.provider}/${ctx.model.id}`, session: ctx.sessionManager.getSessionId() };
			applied = undefined;
		}
	};
	return {
		begin,
		settle(ctx: ExtensionContext) {
			const restore = matches(ctx) && applied !== undefined && pi.getThinkingLevel() === applied ? baseline?.level : undefined;
			baseline = undefined;
			applied = undefined;
			if (restore !== undefined) pi.setThinkingLevel(restore);
		},
		tool: {
			name: "change_reasoning",
			exposure: "codemode",
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
			async execute(_id: string, params: { level: "low" | "medium" | "high" }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
				if (!(enabled() && ctx.model?.reasoning)) throw new Error("change_reasoning requires Auto reasoning enabled on a reasoning model");
				begin(ctx);
				if (!baseline) throw new Error("No reasoning baseline");
				const previous = pi.getThinkingLevel();
				// A user selector change supersedes the tool's last selection.
				if (previous !== (applied ?? baseline.level)) baseline.level = previous;
				const effective = levels.indexOf(params.level) < levels.indexOf(baseline.level) ? baseline.level : params.level;
				pi.setThinkingLevel(effective);
				applied = pi.getThinkingLevel();
				const details = { level: applied, floor: baseline.level };
				return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
			},
		},
	};
}
