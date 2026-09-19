export type ParsedShellCommand = {
    kind: "read";
    command: string;
    name: string;
    path: string;
} | {
    kind: "list";
    command: string;
    path?: string | undefined;
} | {
    kind: "search";
    command: string;
    query?: string | undefined;
    path?: string | undefined;
} | {
    kind: "unknown";
    command: string;
};
export declare function unknownCommand(mainCommand: string[]): ParsedShellCommand;
export declare function listCommand(mainCommand: string[], path: string | undefined): ParsedShellCommand;
export declare function pathlessListCommand(mainCommand: string[]): ParsedShellCommand;
export declare function searchCommand(mainCommand: string[], query: string, path: string | undefined): ParsedShellCommand;
export declare function readCommand(mainCommand: string[], path: string): ParsedShellCommand;
export declare function readOrUnknown(mainCommand: string[], path: string | undefined): ParsedShellCommand;
