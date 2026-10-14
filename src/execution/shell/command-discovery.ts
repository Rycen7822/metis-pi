import {
	firstNonFlagOperand,
	parseFdQueryAndPath,
	parseFindQueryAndPath,
	skipFlagValues,
	trimAtConnector,
} from "./command-operands.ts";
import {
	listCommand,
	type ParsedShellCommand,
	searchCommand,
	unknownCommand,
} from "./parsed-command.ts";
import { joinCommandTokens } from "./tokenize.ts";

export function summarizeDiscoveryCommand(
	head: string,
	tail: string[],
	mainCommand: string[],
): ParsedShellCommand | undefined {
	if (head === "ls" || head === "eza" || head === "exa") {
		const flagsWithValues =
			head === "ls"
				? [
						"-I",
						"-w",
						"--block-size",
						"--format",
						"--time-style",
						"--color",
						"--quoting-style",
					]
				: [
						"-I",
						"--ignore-glob",
						"--color",
						"--sort",
						"--time-style",
						"--time",
					];
		return listCommand(mainCommand, firstNonFlagOperand(tail, flagsWithValues));
	}
	if (head === "tree") {
		return listCommand(
			mainCommand,
			firstNonFlagOperand(tail, [
				"-L",
				"-P",
				"-I",
				"--charset",
				"--filelimit",
				"--sort",
			]),
		);
	}
	if (head === "du") {
		return listCommand(
			mainCommand,
			firstNonFlagOperand(tail, [
				"-d",
				"--max-depth",
				"-B",
				"--block-size",
				"--exclude",
				"--time-style",
			]),
		);
	}
	// Output redirection is not a pure search, even when the executable is.
	if (["rg", "rga", "ripgrep-all", "fd", "ast-grep"].includes(head) && tail.some(token => /^(?:\d*|&)>/.test(token)))
		return unknownCommand(mainCommand);
	if (head === "ast-grep") {
		const mode = tail[0];
		const explicitMode = mode === "run" || mode === "scan";
		const args = explicitMode ? tail.slice(1) : tail;
		const patternIndex = args.findIndex(token => token === "-p" || token === "--pattern");
		const inlinePattern = args.find(token => token.startsWith("--pattern="));
		const defaultRun = mode?.startsWith("-") && (patternIndex >= 0 || inlinePattern !== undefined);
		if ((!explicitMode && !defaultRun) || args.some(token =>
			/^--(?:rewrite|update-all|interactive)(?:=|$)/.test(token) || /^-[^-]*[rUi]/.test(token)))
			return unknownCommand(mainCommand);
		const query = patternIndex >= 0 ? args[patternIndex + 1] : inlinePattern?.slice(10);
		const path = firstNonFlagOperand(args, ["-p", "--pattern", "-l", "--lang", "--selector", "--strictness",
			"-c", "--config", "--rule", "--inline-rules", "--filter", "--threads", "--color"]);
		return searchCommand(mainCommand, query, path);
	}
	if (head === "rg" || head === "rga" || head === "ripgrep-all") {
		const args = trimAtConnector(tail);
		const hasFilesFlag = args.includes("--files");
		const candidates = skipFlagValues(args, [
			"-g",
			"--glob",
			"--iglob",
			"-t",
			"--type",
			"--type-add",
			"--type-not",
			"-m",
			"--max-count",
			"-A",
			"-B",
			"-C",
			"--context",
			"--max-depth",
		]);
		const nonFlags = candidates.filter((token) => !token.startsWith("-"));
		if (hasFilesFlag) return listCommand(mainCommand, nonFlags[0]);
		return searchCommand(mainCommand, nonFlags[0]!, nonFlags[1]);
	}
	if (head === "git") {
		const [subcommand, ...subtail] = tail;
		if (subcommand === "grep") return parseGrepLike(mainCommand, subtail);
		if (subcommand === "ls-files") {
			return listCommand(
				mainCommand,
				firstNonFlagOperand(subtail, [
					"--exclude",
					"--exclude-from",
					"--pathspec-from-file",
				]),
			);
		}
		return unknownCommand(mainCommand);
	}
	if (head === "fd") {
		if (tail.some(token => /^--exec(?:-batch)?(?:=|$)/.test(token) || /^-[^-]*[xX]/.test(token)))
			return unknownCommand(mainCommand);
		const [query, path] = parseFdQueryAndPath(tail);
		return { kind: "find", command: joinCommandTokens(mainCommand), query, path };
	}
	if (head === "find") {
		if (tail.some(token => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(token)))
			return unknownCommand(mainCommand);
		const [query, path] = parseFindQueryAndPath(tail);
		return query
			? { kind: "search", command: joinCommandTokens(mainCommand), query, path }
			: { kind: "list", command: joinCommandTokens(mainCommand), path };
	}
	if (head === "grep" || head === "egrep" || head === "fgrep")
		return parseGrepLike(mainCommand, tail);
	if (head === "ag" || head === "ack" || head === "pt") {
		const args = trimAtConnector(tail);
		const candidates = skipFlagValues(args, [
			"-G",
			"-g",
			"--file-search-regex",
			"--ignore-dir",
			"--ignore-file",
			"--path-to-ignore",
		]);
		const nonFlags = candidates.filter((token) => !token.startsWith("-"));
		return searchCommand(mainCommand, nonFlags[0]!, nonFlags[1]);
	}
	return undefined;
}

function parseGrepLike(
	mainCommand: string[],
	args: string[],
): ParsedShellCommand {
	const trimmed = trimAtConnector(args);
	const operands: string[] = [];
	let pattern: string | undefined;
	let afterDoubleDash = false;
	for (let index = 0; index < trimmed.length; index++) {
		const arg = trimmed[index]!;
		if (afterDoubleDash) {
			operands.push(arg);
			continue;
		}
		if (arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (arg === "-e" || arg === "--regexp") {
			if (!pattern) pattern = trimmed[index + 1]!;
			index += 1;
			continue;
		}
		if (arg === "-f" || arg === "--file") {
			if (!pattern) pattern = trimmed[index + 1]!;
			index += 1;
			continue;
		}
		if (
			arg === "-m" ||
			arg === "--max-count" ||
			arg === "-C" ||
			arg === "--context" ||
			arg === "-A" ||
			arg === "--after-context" ||
			arg === "-B" ||
			arg === "--before-context"
		) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		operands.push(arg);
	}
	const hasPattern = pattern !== undefined;
	const query = pattern ?? operands[0]!;
	const pathIndex = hasPattern ? 0 : 1;
	return searchCommand(mainCommand, query, operands[pathIndex]);
}
