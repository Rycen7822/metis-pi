import { fusionFailed } from "./action-fusion.ts";
import { isActionFusionEnabled } from "./action-fusion-availability.ts";
import { runExecFusionCommand } from "./action-fusion-command.ts";
import { type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionRuntime } from "./runtime.ts";
import { getCodeModeExtensionTools } from "../code-mode/extension-tools.ts";
import {
	type CodeModeRegistration,
	registerCodeModeTools,
	registerCustomTools,
} from "../code-mode/tools.ts";
import type { ProgrammaticCodeModeToolDefinition } from "../code-mode/types.ts";
import { createApplyPatchTool } from "./apply-patch/tool.ts";
import { createExecCommandTool } from "./exec/command-tool.ts";
import { createWriteStdinTool } from "./exec/write-stdin-tool.ts";
import { createViewImageTool } from "./view-image/tool.ts";
import { supportsViewImageInputs } from "./view-image/support.ts";

import { codeModeImageResult, toNestedTool } from "../code-mode/nested-tool-adapter.ts";


const LONG_RUNNING_TOOL_OUTER_YIELD_MS = 1_800_000;

export async function registerExecutionCodeMode(
	pi: ExtensionAPI,
	runtime: ExecutionRuntime,
): Promise<CodeModeRegistration> {
	const isActive = () => pi.getActiveTools().includes("exec");
	const customToolsRuntime = await registerCustomTools(pi, undefined, {
		isActive,
	});
	const programmaticRuntime = await registerCodeModeTools(pi, {
		getTools: (ctx, callable = []) => {
			const context = ctx as ExtensionContext | undefined;
			const allowed = new Set(callable.map(tool => tool.name));
			const specialized = [ ...createNestedTools(pi, runtime, context), ...getCodeModeExtensionTools(pi, context) ]
				.filter(tool => allowed.has(tool.topLevelName ?? tool.name));
			return specialized;
		},
		isActive,
		providesRenderers: true,
		richRendering: () => runtime.config.ui.codeModeDetails,
		minimalOutput: () => runtime.config.ui.compactTools === "minimal",
	});
	return {
		prepare: (ctx) => programmaticRuntime.prepare(ctx),
		refreshPromptTools: (systemPrompt, ctx) =>
			programmaticRuntime.refreshPromptTools(systemPrompt, ctx),
		shutdownHost: () => programmaticRuntime.shutdownHost(),
		async shutdown() {
			await programmaticRuntime.shutdown();
			await customToolsRuntime.shutdown();
		},
	};
}

export function createNestedTools(
	pi: ExtensionAPI,
	runtime: ExecutionRuntime,
	ctx?: ExtensionContext,
): ProgrammaticCodeModeToolDefinition[] {
	const options = {
		describeImagesForTextModels: runtime.config.tools.viewImageFallback,
		promptSnippet: false,
		customRendering: runtime.config.ui.toolRenaming,
		showOutputWhenCollapsed: true,
	};
	const execOptions = {
		...options,
		waitForNonInteractiveExit: true,
	};
	const textOutput = runtime.config.tools.plainCommandOutput
		? { textOutput: "plain-command" as const }
		: {};
	const fusionEnabled = isActionFusionEnabled(pi);
	const patchTool = createApplyPatchTool({
		customRustBinariesDir: runtime.config.tools.customRustBinariesDir,
		promptSnippet: false,
		showDiffWhenCollapsed: runtime.config.ui.compactTools === "off",
		runThenRun: fusionEnabled
			? (context) => (input, signal, update) => runExecFusionCommand(runtime.sessions, input, context, signal, update)
			: undefined,
	});
	const tools: ProgrammaticCodeModeToolDefinition[] = [
		toNestedTool(
			patchTool,
			"await tools.apply_patch(patch) // *** Begin Patch / *** End Patch; actions: *** Add File: path | *** Update File: path | *** Delete File: path; *** Move to: path must immediately follow its Update File header and still needs a nonempty @@ hunk (use one unchanged context line for a pure move); Update hunks MUST follow file order; copy exact context; @@ text is context, not a line range; reread a file before patching if it changed since your last read",
			{},
			{
				kind: "freeform",
				prepareInput(input) {
					if (typeof input !== "string")
						throw new Error("apply_patch expects a patch string");
					return { input };
				},
				resultError(result) {
					if (
						result.details &&
						typeof result.details === "object" &&
						"status" in result.details &&
						result.details.status === "partial_failure"
					)
						return result.content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n") || "apply_patch partially failed";
					return undefined;
				},
			},
		),
		...(fusionEnabled ? [{ ...toNestedTool(
			{ ...patchTool, name: "apply_patch_then_run", label: "apply_patch_then_run" },
			"await tools.apply_patch_then_run({ input: string, then_run: { command: string, timeout?: number } }) // apply the entire patch, then run one already-chosen command; failure keeps applied changes",
			{},
			{
				yieldTimeMs: LONG_RUNNING_TOOL_OUTER_YIELD_MS,
				modelVisibleResult: true,
				resultError(result) {
					return fusionFailed(result.details) ? result.content.filter(item => item.type === "text").map(item => item.text).join("\n") : undefined;
				},
			},
		), topLevelName: "apply_patch" }] : []),
		toNestedTool(
			createExecCommandTool(runtime.tracker, runtime.sessions, execOptions),
			"await tools.exec_command({ cmd: string, workdir?: string, shell?: string, tty?: boolean, yield_time_ms?: number, max_output_tokens?: number, login?: boolean }) // returns { output: string, session_id?: number, exit_code?: number }",
			{
				start(id, input) {
					const cmd =
						input &&
						typeof input === "object" &&
						"cmd" in input &&
						typeof input.cmd === "string"
							? input.cmd
							: "";
					if (cmd) runtime.tracker.recordStart(id, cmd);
				},
				end: (id) => runtime.tracker.recordEnd(id),
			},
			{
				yieldTimeMs: LONG_RUNNING_TOOL_OUTER_YIELD_MS,
				...textOutput,
				resultValue(result) {
					const details = result.details;
					if (result.content.some((item) => item.type === "image")) {
						const outputHint = isExecResult(details)
							? details.output
							: result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || undefined;
						return codeModeImageResult(result, outputHint);
					}
					if (isExecResult(details)) return details;
					return result.content
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text)
						.join("\n") || "(no output)";
				},
			},
		),
		toNestedTool(
			createWriteStdinTool(runtime.sessions, options),
			"await tools.write_stdin({ session_id: number, chars?: string, yield_time_ms?: number, max_output_tokens?: number }) // non-empty chars only when the original exec_command used tty=true",
			{},
			{ yieldTimeMs: LONG_RUNNING_TOOL_OUTER_YIELD_MS, ...textOutput },
		),
	];
	if (!ctx || supportsViewImageInputs(ctx.model) || runtime.config.tools.viewImageFallback) {
		const imageCapable = !ctx || supportsViewImageInputs(ctx.model);
		tools.push(toNestedTool(
			createViewImageTool({
				customRustBinariesDir: runtime.config.tools.customRustBinariesDir,
				describeForTextModels: runtime.config.tools.viewImageFallback,
				promptSnippet: false,
				customRendering: runtime.config.ui.toolRenaming,
			}),
			imageCapable
				? "const result = await tools.view_image({ path: string, detail?: \"original\" }); image(result)"
				: "const description = await tools.view_image({ path: string }); text(description)",
			{},
			{ ...(imageCapable ? { resultValue: codeModeImageResult } : {}) },
		));
	}
	if (runtime.config.tools.autoReasoning && ctx?.model?.reasoning && runtime.reasoning) tools.push(toNestedTool(runtime.reasoning, "await tools.change_reasoning({ level: \"low\" | \"medium\" | \"high\" })"));
	return tools;
}

function isExecResult(details: AgentToolResult<unknown>["details"]): details is Record<string, unknown> & { output: string } {
	return Boolean(details && typeof details === "object" && "output" in details && typeof details.output === "string");
}
