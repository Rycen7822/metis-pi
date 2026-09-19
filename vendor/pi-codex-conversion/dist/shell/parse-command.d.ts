import type { ParsedShellCommand } from "./parsed-command.ts";
export type { ParsedShellCommand } from "./parsed-command.ts";
export declare function parseCommandString(command: string): ParsedShellCommand[];
export declare function parseCommandTokens(command: string[]): ParsedShellCommand[];
