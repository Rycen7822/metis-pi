import { EXEC_OUTPUT_SCHEMA, execToolResult, isUnifiedExecResult } from "./results.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container } from "@earendil-works/pi-tui";
import { createHangingText } from "../../presentation/components/rows.ts";
import type { Foreground } from "../../presentation/terminal-text.ts";
import { asRecord } from "../../presentation/tool-names.ts";
import { firstText, renderExecOutput } from "../ui/output.ts";
import { renderWriteStdinCall, type RenderTheme } from "../ui/rendering.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./session-manager.ts";
import { renderTerminalOutput } from "./output.ts";

const WRITE_STDIN_PARAMETERS = Type.Object({
	session_id: Type.Number({ description: "Session ID" }),
	chars: Type.Optional(Type.String({ description: "Input; non-empty requires original exec_command tty=true. Empty polls" })),
	yield_time_ms: Type.Optional(Type.Number({ description: "Wait ms" })),
	max_output_tokens: Type.Optional(Type.Number({ description: "Truncate" })),
});

interface WriteStdinParams {
	session_id: number;
	chars?: string | undefined;
	yield_time_ms?: number | undefined;
	max_output_tokens?: number | undefined;
}

interface FormattedExecTranscript {
	output: string;
	sessionId?: number | undefined;
	exitCode?: number | undefined;
}

function parseFormattedExecTranscript(text: string): FormattedExecTranscript {
	const marker = "\nOutput:\n";
	const markerIndex = text.indexOf(marker);
	const output = markerIndex !== -1 ? text.slice(markerIndex + marker.length) : text;
	const metadata = markerIndex !== -1 ? text.slice(0, markerIndex) : text;
	const sessionMatch = metadata.match(/(?:Process running with session ID|Call write_stdin\(\{ session_id:) (\d+)(?: \}\))?/);
	const exitCodeMatch = metadata.match(/Process exited with code (-?\d+)/);
	return {
		output,
		sessionId: sessionMatch ? Number(sessionMatch[1]!) : undefined,
		exitCode: exitCodeMatch ? Number(exitCodeMatch[1]!) : undefined,
	};
}

function getResultState(value: unknown): FormattedExecTranscript {
  const { details, content } = asRecord(value);
  return isUnifiedExecResult(details)
    ? { output: details.output, sessionId: details.session_id, exitCode: details.exit_code }
    : parseFormattedExecTranscript(firstText(content));
}

function parseWriteStdinParams(params: unknown): WriteStdinParams {
  if (!params || typeof params !== "object" || !("session_id" in params) || typeof params.session_id !== "number") {
    throw new Error("write_stdin requires numeric 'session_id'");
  }
  const chars = "chars" in params && typeof params.chars === "string" ? params.chars : undefined;
  const yield_time_ms =
    "yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined;
  const max_output_tokens =
    "max_output_tokens" in params && typeof params.max_output_tokens === "number"
      ? params.max_output_tokens
      : undefined;
  return { session_id: params.session_id, chars, yield_time_ms, max_output_tokens };
}

export function renderStdinCall(args: unknown, theme: RenderTheme, getCommand?: ExecSessionManager["getSessionCommand"]) {
  const { session_id, chars } = asRecord(args);
  const id = typeof session_id === "number" ? session_id : "?";
  const input = typeof chars === "string" ? chars : undefined;
  return createHangingText(renderWriteStdinCall(id, input, typeof id === "number" ? getCommand?.(id) : undefined, theme));
}

export function renderStdinResult(
  value: unknown,
  { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean },
  theme: Foreground,
  context?: { isError?: boolean },
) {
  if (!expanded && !isPartial && !context?.isError) return new Container();
  const { output, sessionId, exitCode } = getResultState(value);
  const text = renderTerminalOutput(output);
  const tail = expanded ? text : text.trimEnd().slice(-8_000).split("\n").slice(-5).join("\n");
  const status = [];
  if (sessionId !== undefined) status.push(theme.fg(expanded ? "accent" : "dim", `Session ${sessionId} still running`));
  if (exitCode !== undefined && (expanded || exitCode !== 0)) status.push(theme.fg("muted", `Exit code: ${exitCode}`));
  const body = tail || (expanded ? "(no output)" : !status.length && isPartial ? "Waiting for output" : "");
  return renderExecOutput(body, status, theme, expanded ? undefined : { lines: 6 });
}

export function createWriteStdinTool(sessions: ExecSessionManager) {
  const tool: Parameters<ExtensionAPI["registerTool"]>[0] = {
    name: "write_stdin",
    label: "write_stdin",
    renderShell: "self",
    description: "Write/poll exec session",
    promptSnippet: "Write to exec session",
    parameters: WRITE_STDIN_PARAMETERS,
    outputSchema: EXEC_OUTPUT_SCHEMA,
    async execute(_toolCallId, params, signal, onUpdate) {
      const typed = parseWriteStdinParams(params);
      const command = sessions.getSessionCommand(typed.session_id) ?? "";
      let result: UnifiedExecResult;
      try {
        result = await sessions.write(
          typed,
          signal,
          onUpdate ? (partial) => onUpdate(execToolResult(partial, command)) : undefined,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`write_stdin failed: ${message}`);
      }
      return execToolResult(result, command);
    },
    renderCall: (args, theme) => renderStdinCall(args, theme, id => sessions.getSessionCommand(id)),
    renderResult: renderStdinResult,
  };
  return tool;
}
