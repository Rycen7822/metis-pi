import { awkDataFileOperand, sedReadPath } from "./command-operands.ts";

export function isSmallFormattingCommand(tokens: string[]): boolean {
	if (tokens.length === 0) return false;
	const command = tokens[0]!;
	if (tokens.some(token => /^(?:\d+)?[<>]/.test(token))) return false;
	if (command === "sort" && tokens.some(token => token === "-o" || /^--output(?:=|$)/.test(token) || /^-[^-]*o/.test(token)))
		return false;
	if (command === "sed" && tokens.some(token => /^--in-place(?:=|$)/.test(token) || /^-[^-]*i/.test(token)))
		return false;
	if (
		command === "wc" ||
		command === "tr" ||
		command === "cut" ||
		command === "sort" ||
		command === "uniq" ||
		command === "column" ||
		command === "yes" ||
		command === "printf"
	) {
		return true;
	}
	// An arbitrary xargs child is execution, not an output formatter.
	if (command === "xargs") return false;
	if (command === "awk")
		return awkDataFileOperand(tokens.slice(1)) === undefined;
	if (command === "head") {
		if (tokens.length === 1) return true;
		if (tokens.length === 2) return tokens[1]!.startsWith("-");
		if (
			tokens.length === 3 &&
			(tokens[1] === "-n" || tokens[1] === "-c") &&
			/^[0-9]+$/.test(tokens[2]!)
		)
			return true;
		return false;
	}
	if (command === "tail") {
		if (tokens.length === 1) return true;
		if (tokens.length === 2) return tokens[1]!.startsWith("-");
		if (tokens.length === 3 && (tokens[1] === "-n" || tokens[1] === "-c")) {
			const value = tokens[2]!.startsWith("+")
				? tokens[2]!.slice(1)
				: tokens[2]!;
			return value.length > 0 && /^[0-9]+$/.test(value);
		}
		return false;
	}
	if (command === "sed") return sedReadPath(tokens.slice(1)) === undefined;
	return false;
}
