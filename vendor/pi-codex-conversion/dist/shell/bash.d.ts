import type { Tree } from "web-tree-sitter";
export declare function initializeBashParser(): void;
export declare function extractBashCommand(command: string[]): [shell: string, script: string] | undefined;
export declare function tryParseShell(shellLcArg: string): Tree | undefined;
export declare function tryParseWordOnlyCommandsSequence(tree: Tree, src: string): string[][] | undefined;
export declare function parseShellLcPlainCommands(command: string[]): string[][] | undefined;
