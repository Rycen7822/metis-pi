import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { isToolSearch, OWNED_TOOL_SEARCH_ENTRY } from "../presentation/tool-source.mjs";
import { ASK_USER_QUESTION_TOOL_NAME, registerAskUserQuestionTool } from "./ask-user-question.ts";
import { type AskUserQuestionConfig, loadConfig } from "./config.ts";

const ownerPath = fileURLToPath(new URL("../../extensions/ask-user-question.ts", import.meta.url));
const guidance = "For a user decision, discover ask_user_question with codemode " +
	"describeTool('ask_user_question'), then await tools.ask_user_question(args).";
const nativeSearchGuidance = "For a user decision, use tool_search to load ask_user_question if not already active, " +
	"then call it with the declared parameters.";
const searchGuidance = "For a user decision, inspect ask_user_question with tool_search " +
	"(action=describe, name=ask_user_question), even if already loaded, then call it with the current parameters. " +
	"In codemode use tools.tool_search(args).";

/** Deferred availability follows UI/config; discovery never auto-activates the questionnaire. */
export function registerAskUserQuestionReconciler(pi: ExtensionAPI): void {
	let exposure: "deferred" | "hidden" | undefined;
	let fault: string | undefined;
	const diagnose = (ctx: ExtensionContext, message?: string) => {
		if (message && message !== fault) ctx.ui.notify(message, "warning");
		fault = message;
	};
	const reconcile = (ctx: ExtensionContext, start = false) => {
		const current = pi.getAllTools().find(tool => tool.name === ASK_USER_QUESTION_TOOL_NAME);
		if (current && current.sourceInfo.path !== ownerPath) {
			diagnose(ctx, "Metis questions inactive: another ask_user_question provider is loaded; " +
				"remove the old plugin before enabling this tool.");
			return false;
		}
		let config: AskUserQuestionConfig;
		try {
			config = loadConfig();
		} catch (error) {
			diagnose(ctx, `Metis questions unavailable: ${String(error)}`);
			if (current && exposure !== "hidden") {
				registerAskUserQuestionTool(pi, "hidden", { enabled: false });
				exposure = "hidden";
			}
			return false;
		}
		const next = ctx.hasUI && config.enabled === true ? "deferred" : "hidden";
		if (exposure !== next || start) {
			registerAskUserQuestionTool(pi, next, config);
			exposure = next;
		}
		const owned = pi.getAllTools().some(tool =>
			tool.name === ASK_USER_QUESTION_TOOL_NAME && tool.sourceInfo.path === ownerPath);
		if (next === "hidden" || !owned) {
			diagnose(ctx);
			return false;
		}
		const discovery = pi.getAllTools().filter(tool =>
			(tool.name === "codemode" && tool.sourceInfo.path === "builtin:codemode") ||
			isToolSearch(tool));
		const active = pi.getActiveTools();
		if (start && !discovery.some(tool => active.includes(tool.name))) {
			const gateway = discovery.find(tool => tool.name === "codemode") ??
				discovery.find(tool => tool.name === "tool_search");
			if (gateway) pi.setActiveTools([...active, gateway.name]);
		}
		const ready = discovery.find(tool => pi.getActiveTools().includes(tool.name));
		diagnose(ctx, ready ? undefined : "Metis questions need codemode or tool_search for discovery.");
		if (!ready) return false;
		const search = discovery.find(tool => isToolSearch(tool) && pi.getActiveTools().includes(tool.name));
		return search?.sourceInfo.path === OWNED_TOOL_SEARCH_ENTRY ? searchGuidance : search ? nativeSearchGuidance : guidance;
	};
	pi.on("session_start", (_event, ctx) => {
		fault = undefined;
		reconcile(ctx, true);
	});
	pi.on("before_agent_start", (event, ctx) => {
		delete event.systemPromptOptions.sections.metis_questions;
		const hint = reconcile(ctx);
		if (hint) event.systemPromptOptions.sections.metis_questions = hint;
	});
}
