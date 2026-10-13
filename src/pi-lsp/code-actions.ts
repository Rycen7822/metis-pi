import type { WorkspaceEdit } from "./types.ts";

export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  edit?: WorkspaceEdit;
  command?: LspCommand;
  disabled?: { reason: string };
  data?: unknown;
}

export type CodeActionResult = CodeAction | LspCommand;

/** A bare LSP Command is informational: this tool never executes server commands. */
export function isCodeAction(action: CodeActionResult): action is CodeAction {
  return typeof action.command !== "string";
}

export function selectCodeActions(actions: CodeActionResult[], requestedKind: string) {
  return actions.filter((action): action is CodeAction => isCodeAction(action) && !action.disabled &&
    (action.kind === requestedKind || action.kind?.startsWith(`${requestedKind}.`) === true));
}
