import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHangingText } from "../../presentation/components/rows.ts";
import type { Foreground } from "../../presentation/terminal-text.ts";
import { asRecord } from "../../presentation/tool-names.ts";
import { Type } from "typebox";
import { getPiConfiguredShellPath } from "../runtime-shell.ts";
import { renderExecCommandCall, type ExecCallContext, type RenderTheme } from "../ui/rendering.ts";
import { firstText, renderExecOutput, trimOutputTail } from "../ui/output.ts";
import { renderTerminalOutput } from "./output.ts";
import { EXEC_OUTPUT_SCHEMA, execToolResult, isUnifiedExecResult } from "./results.ts";
import type { ExecCommandInput, ExecSessionManager, UnifiedExecResult } from "./session-manager.ts";
import { MAX_EXEC_YIELD_TIME_MS } from "./shell.ts";

const EXEC_COMMAND_PARAMETERS = Type.Object({
	cmd: Type.String({ description: "Raw command string interpreted by the current shell; do not quote the entire command" }),
	workdir: Type.Optional(Type.String({ description: "Cwd" })),
	shell: Type.Optional(Type.String()),
	tty: Type.Optional(Type.Boolean({ description: "Keep stdin open for input or interruption" })),
	yield_time_ms: Type.Optional(Type.Number({ description: "Wait ms" })),
	max_output_tokens: Type.Optional(Type.Number({ description: "Truncate" })),
	login: Type.Optional(Type.Boolean({ description: "Login shell" })),
});

interface ExecCommandParams {
	cmd: string;
	workdir?: string | undefined;
	shell?: string | undefined;
	tty?: boolean | undefined;
	yield_time_ms?: number | undefined;
	max_output_tokens?: number | undefined;
	login?: boolean | undefined;
}

interface ExecCommandToolOptions {
	customRendering?: boolean | undefined;
}

function prepareExecCommandArguments(args: unknown): ExecCommandParams {
	if (!args || typeof args !== "object") return args as ExecCommandParams;
	const prepared = { ...(args as Record<string, unknown>) };
	if (!("cmd" in prepared) && "command" in prepared) prepared["cmd"] = prepared["command"]!;
	if (!("workdir" in prepared)) {
		if ("cwd" in prepared) prepared["workdir"] = prepared["cwd"]!;
		else if ("working_directory" in prepared) prepared["workdir"] = prepared["working_directory"]!;
	}
	return prepared as unknown as ExecCommandParams;
}

function parseExecCommandParams(params: unknown): ExecCommandParams {
	if (!params || typeof params !== "object") throw new Error("exec_command requires an object parameter");
	const cmd = "cmd" in params ? params.cmd : undefined;
	if (typeof cmd !== "string") throw new Error("exec_command requires a string 'cmd' parameter");
	return {
		cmd,
		workdir: "workdir" in params && typeof params.workdir === "string" ? params.workdir : undefined,
		shell: "shell" in params && typeof params.shell === "string" ? params.shell : undefined,
		tty: "tty" in params && typeof params.tty === "boolean" ? params.tty : undefined,
		yield_time_ms: "yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined,
		max_output_tokens: "max_output_tokens" in params && typeof params.max_output_tokens === "number" ? params.max_output_tokens : undefined,
		login: "login" in params && typeof params.login === "boolean" ? params.login : undefined,
	};
}

export function renderExecCall(
  args: unknown,
  theme: RenderTheme,
  context?: ExecCallContext,
) {
  const { cmd } = asRecord(args);
  const rendered = renderExecCommandCall(typeof cmd === "string" ? cmd : "", theme, context);
  return typeof rendered === "string" ? createHangingText(rendered) : rendered;
}

export function renderExecResult(
  value: unknown,
  { expanded }: { expanded?: boolean },
  theme: Foreground,
) {
  const { details, content } = asRecord(value);
  const result = isUnifiedExecResult(details) ? details : undefined;
  const output = renderTerminalOutput(result?.output ?? firstText(content));
  const body = expanded ? { output: output || "(no output)", truncated: false } : trimOutputTail(output.trimEnd(), 16_000, 160);
  const status: string[] = [];
  if (result?.session_id !== undefined) status.push(theme.fg("accent", `Session ${result.session_id} still running`));
  if (result?.exit_code !== undefined && (expanded || result.exit_code !== 0))
    status.push(theme.fg("muted", `Exit code: ${result.exit_code}`));
  if (!expanded && typeof result?.wall_time_seconds === "number" && (body.output || status.length))
    status.push(theme.fg("muted", `Took ${result.wall_time_seconds.toFixed(1)}s`));
  return renderExecOutput(body.output, status, theme, expanded ? undefined : { lines: 5, hint: true, truncated: body.truncated });
}

export function createExecCommandTool(sessions: ExecSessionManager, options: ExecCommandToolOptions = {}) {
  const tool: Parameters<ExtensionAPI["registerTool"]>[0] = {
    name: "exec_command",
    label: "exec_command",
    description: "Run shell commands; may return session_id",
    promptSnippet: "Run command",
    parameters: EXEC_COMMAND_PARAMETERS,
    outputSchema: EXEC_OUTPUT_SCHEMA,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: prepareExecCommandArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("exec_command aborted");
      const parsedInput = parseExecCommandParams(params);
      const input: ExecCommandInput =
        parsedInput.shell === undefined ? { ...parsedInput, defaultShell: getPiConfiguredShellPath(ctx) } : parsedInput;
      const toToolResult = (partial: UnifiedExecResult) => execToolResult(partial, input.cmd);
      const execInput = input.tty
        ? input
        : {
            ...input,
            max_yield_time_ms: MAX_EXEC_YIELD_TIME_MS,
          };
      const sessionDir = ctx.sessionManager?.getSessionDir?.();
      const archiveDirectory = sessionDir ? join(sessionDir, `${ctx.sessionManager.getSessionId()}-blobs`) : undefined;
      const result = await sessions.exec(
        { ...execInput, ...(archiveDirectory ? { archiveDirectory } : {}) },
        ctx.cwd,
        signal,
        onUpdate ? (partial) => onUpdate(toToolResult(partial)) : undefined,
      );
      return toToolResult(result);
    },
    ...(options.customRendering === false
      ? {}
      : {
          renderCall: renderExecCall,
          renderResult: renderExecResult,
        }),
  };
  return tool;
}
