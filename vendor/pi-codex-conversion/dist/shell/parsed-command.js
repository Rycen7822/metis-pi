import { joinCommandTokens, shortDisplayPath } from "./tokenize.js";
export function unknownCommand(mainCommand) {
    return { kind: "unknown", command: joinCommandTokens(mainCommand) };
}
export function listCommand(mainCommand, path) {
    return {
        kind: "list",
        command: joinCommandTokens(mainCommand),
        path: path ? shortDisplayPath(path) : undefined,
    };
}
export function pathlessListCommand(mainCommand) {
    return { kind: "list", command: joinCommandTokens(mainCommand) };
}
export function searchCommand(mainCommand, query, path) {
    return {
        kind: "search",
        command: joinCommandTokens(mainCommand),
        query,
        path: path ? shortDisplayPath(path) : undefined,
    };
}
export function readCommand(mainCommand, path) {
    return {
        kind: "read",
        command: joinCommandTokens(mainCommand),
        name: shortDisplayPath(path),
        path,
    };
}
export function readOrUnknown(mainCommand, path) {
    return path ? readCommand(mainCommand, path) : unknownCommand(mainCommand);
}
