import { shortDisplayPath } from "./tokenize.js";
export function trimAtConnector(tokens) {
    const index = tokens.findIndex((token) => token === "|" || token === "&&" || token === "||" || token === ";");
    return index === -1 ? [...tokens] : tokens.slice(0, index);
}
export function skipFlagValues(args, flagsWithValues) {
    const out = [];
    let skipNext = false;
    for (let index = 0; index < args.length; index++) {
        const token = args[index];
        if (skipNext) {
            skipNext = false;
            continue;
        }
        if (token === "--") {
            out.push(...args.slice(index + 1));
            break;
        }
        if (token.startsWith("--") && token.includes("="))
            continue;
        if (flagsWithValues.includes(token)) {
            if (index + 1 < args.length)
                skipNext = true;
            continue;
        }
        out.push(token);
    }
    return out;
}
function positionalOperands(args, flagsWithValues) {
    const out = [];
    let afterDoubleDash = false;
    let skipNext = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (skipNext) {
            skipNext = false;
            continue;
        }
        if (afterDoubleDash) {
            out.push(arg);
            continue;
        }
        if (arg === "--") {
            afterDoubleDash = true;
            continue;
        }
        if (arg.startsWith("--") && arg.includes("="))
            continue;
        if (flagsWithValues.includes(arg)) {
            if (index + 1 < args.length)
                skipNext = true;
            continue;
        }
        if (arg.startsWith("-"))
            continue;
        out.push(arg);
    }
    return out;
}
export function firstNonFlagOperand(args, flagsWithValues) {
    return positionalOperands(args, flagsWithValues)[0];
}
export function singleNonFlagOperand(args, flagsWithValues) {
    const operands = positionalOperands(args, flagsWithValues);
    return operands.length === 1 ? operands[0] : undefined;
}
export function awkDataFileOperand(args) {
    if (args.length === 0)
        return undefined;
    const trimmed = trimAtConnector(args);
    const hasScriptFile = trimmed.some((arg) => arg === "-f" || arg === "--file");
    const candidates = skipFlagValues(trimmed, [
        "-F",
        "-v",
        "-f",
        "--field-separator",
        "--assign",
        "--file",
    ]);
    const nonFlags = candidates.filter((arg) => !arg.startsWith("-"));
    if (hasScriptFile)
        return nonFlags[0];
    return nonFlags.length >= 2 ? nonFlags[1] : undefined;
}
export function pythonWalksFiles(args) {
    const trimmed = trimAtConnector(args);
    for (let index = 0; index < trimmed.length; index++) {
        if (trimmed[index] !== "-c")
            continue;
        const script = trimmed[index + 1];
        if (!script)
            continue;
        return (script.includes("os.walk") ||
            script.includes("os.listdir") ||
            script.includes("os.scandir") ||
            script.includes("glob.glob") ||
            script.includes("glob.iglob") ||
            script.includes("pathlib.Path") ||
            script.includes(".rglob("));
    }
    return false;
}
export function isPythonCommand(command) {
    return (command === "python" ||
        command === "python2" ||
        command === "python3" ||
        command.startsWith("python2.") ||
        command.startsWith("python3."));
}
export function cdTarget(args) {
    if (args.length === 0)
        return undefined;
    let target;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--")
            return args[index + 1];
        if (arg === "-L" || arg === "-P")
            continue;
        if (arg.startsWith("-"))
            continue;
        target = arg;
    }
    return target;
}
function isPathish(value) {
    return (value === "." ||
        value === ".." ||
        value.startsWith("./") ||
        value.startsWith("../") ||
        value.includes("/") ||
        value.includes("\\"));
}
export function parseFdQueryAndPath(args) {
    const trimmed = trimAtConnector(args);
    const candidates = skipFlagValues(trimmed, [
        "-t",
        "--type",
        "-e",
        "--extension",
        "-E",
        "--exclude",
        "--search-path",
    ]);
    const nonFlags = candidates.filter((token) => !token.startsWith("-"));
    if (nonFlags.length === 1) {
        return isPathish(nonFlags[0])
            ? [undefined, shortDisplayPath(nonFlags[0])]
            : [nonFlags[0], undefined];
    }
    if (nonFlags.length >= 2)
        return [nonFlags[0], shortDisplayPath(nonFlags[1])];
    return [undefined, undefined];
}
export function parseFindQueryAndPath(args) {
    const trimmed = trimAtConnector(args);
    let path;
    for (const arg of trimmed) {
        if (!arg.startsWith("-") && arg !== "!" && arg !== "(" && arg !== ")") {
            path = shortDisplayPath(arg);
            break;
        }
    }
    let query;
    for (let index = 0; index < trimmed.length; index++) {
        const arg = trimmed[index];
        if (arg === "-name" ||
            arg === "-iname" ||
            arg === "-path" ||
            arg === "-regex") {
            query = trimmed[index + 1];
            break;
        }
    }
    return [query, path];
}
export function readPathFromHeadTail(args, tool) {
    if (args.length === 1 && !args[0].startsWith("-"))
        return args[0];
    if (tool === "head") {
        const hasValidN = args[0] === "-n"
            ? /^[0-9]+$/.test(args[1] ?? "")
            : (args[0]?.startsWith("-n") ?? false) &&
                /^[0-9]+$/.test(args[0].slice(2));
        if (hasValidN) {
            const candidates = [];
            for (let index = 0; index < args.length; index++) {
                if (index === 0 &&
                    args[index] === "-n" &&
                    /^[0-9]+$/.test(args[index + 1] ?? "")) {
                    index += 1;
                    continue;
                }
                candidates.push(args[index]);
            }
            return candidates.find((candidate) => !candidate.startsWith("-"));
        }
        return undefined;
    }
    const hasValidN = args[0] === "-n"
        ? /^\+?[0-9]+$/.test(args[1] ?? "")
        : (args[0]?.startsWith("-n") ?? false) &&
            /^\+?[0-9]+$/.test(args[0].slice(2));
    if (hasValidN) {
        const candidates = [];
        for (let index = 0; index < args.length; index++) {
            if (index === 0 &&
                args[index] === "-n" &&
                /^\+?[0-9]+$/.test(args[index + 1] ?? "")) {
                index += 1;
                continue;
            }
            candidates.push(args[index]);
        }
        return candidates.find((candidate) => !candidate.startsWith("-"));
    }
    return undefined;
}
function isValidSedRange(value) {
    if (!value || !value.endsWith("p"))
        return false;
    const core = value.slice(0, -1);
    const parts = core.split(",");
    return (parts.length >= 1 &&
        parts.length <= 2 &&
        parts.every((part) => part.length > 0 && /^[0-9]+$/.test(part)));
}
export function sedReadPath(args) {
    const trimmed = trimAtConnector(args);
    if (!trimmed.includes("-n"))
        return undefined;
    let hasRangeScript = false;
    for (let index = 0; index < trimmed.length; index++) {
        const token = trimmed[index];
        if ((token === "-e" || token === "--expression") &&
            isValidSedRange(trimmed[index + 1])) {
            hasRangeScript = true;
        }
        if (!token.startsWith("-") && isValidSedRange(token)) {
            hasRangeScript = true;
        }
    }
    if (!hasRangeScript)
        return undefined;
    const candidates = skipFlagValues(trimmed, [
        "-e",
        "-f",
        "--expression",
        "--file",
    ]);
    const nonFlags = candidates.filter((token) => !token.startsWith("-"));
    if (nonFlags.length === 0)
        return undefined;
    if (isValidSedRange(nonFlags[0]))
        return nonFlags[1];
    return nonFlags[0];
}
