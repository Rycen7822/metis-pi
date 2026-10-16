import { fileURLToPath } from "node:url";
import type { Node, Parser, Tree } from "web-tree-sitter";

const allowedKinds = new Set([
	"program",
	"list",
	"pipeline",
	"command",
	"command_name",
	"word",
	"string",
	"string_content",
	"raw_string",
	"number",
	"concatenation",
]);
const allowedPunctuation = new Set(["&&", "||", ";", "|", '"', "'"]);

let parser: Parser | undefined;
let parserPromise: Promise<void> | undefined;

export function initializeBashParser(): void {
	parserPromise ??= createBashParser().then((created) => {
		parser = created;
	});
}

export function extractBashCommand(command: string[]): [shell: string, script: string] | undefined {
	if (command.length !== 3) return undefined;
	const [shell, flag, script] = command as [string, string, string];
	if (flag !== "-lc" && flag !== "-c") return undefined;
	const shellName = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	if (shellName !== "bash" && shellName !== "zsh" && shellName !== "sh") return undefined;
	return [shell, script];
}

export function tryParseShell(shellLcArg: string): Tree | undefined {
	if (!parser) initializeBashParser();
	return parser?.parse(shellLcArg) ?? undefined;
}

export function tryParseWordOnlyCommandsSequence(tree: Tree): string[][] | undefined {
	if (tree.rootNode.hasError) {
		return undefined;
	}

	const commandNodes: Node[] = [];
	const stack: Node[] = [tree.rootNode];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (node.isNamed) {
			if (!allowedKinds.has(node.type)) return undefined;
			if (node.type === "command") commandNodes.push(node);
		} else {
			if (!allowedPunctuation.has(node.type) && node.type.trim().length > 0) {
				return undefined;
			}
		}
		for (const child of node.children) {
			stack.push(child);
		}
	}

	commandNodes.sort((left, right) => left.startIndex - right.startIndex);
	const commands: string[][] = [];
	for (const node of commandNodes) {
		const parsed = parsePlainCommandFromNode(node);
		if (!parsed) return undefined;
		commands.push(parsed);
	}
	return commands;
}

export function parseShellLcPlainCommands(command: string[]): string[][] | undefined {
	const bash = extractBashCommand(command);
	if (!bash) return undefined;
	const [, script] = bash;
	const tree = tryParseShell(script);
	if (!tree) return undefined;
	return tryParseWordOnlyCommandsSequence(tree);
}

async function createBashParser(): Promise<Parser | undefined> {
	try {
		const { Language, Parser } = await import("web-tree-sitter");
		await Parser.init();
		const language = await Language.load(fileURLToPath(new URL("../../../vendor/tree-sitter-bash/tree-sitter-bash.wasm", import.meta.url)));
		const parser = new Parser();
		parser.setLanguage(language);
		return parser;
	} catch {
		return undefined;
	}
}

function parsePlainCommandFromNode(command: Node): string[] | undefined {
	if (command.type !== "command") return undefined;

	const words: string[] = [];
	for (const child of command.namedChildren) {
		switch (child.type) {
			case "command_name": {
				const wordNode = child.namedChild(0);
				if (!wordNode || wordNode.type !== "word") return undefined;
				words.push(wordNode.text);
				break;
			}
			case "word":
			case "number":
				words.push(child.text);
				break;
			case "string": {
				const parsed = parseDoubleQuotedString(child);
				if (parsed === undefined) return undefined;
				words.push(parsed);
				break;
			}
			case "raw_string": {
				const parsed = parseRawString(child);
				if (parsed === undefined) return undefined;
				words.push(parsed);
				break;
			}
			case "concatenation": {
				let concatenated = "";
				for (const part of child.namedChildren) {
					switch (part.type) {
						case "word":
						case "number":
							concatenated += part.text;
							break;
						case "string": {
							const parsed = parseDoubleQuotedString(part);
							if (parsed === undefined) return undefined;
							concatenated += parsed;
							break;
						}
						case "raw_string": {
							const parsed = parseRawString(part);
							if (parsed === undefined) return undefined;
							concatenated += parsed;
							break;
						}
						default:
							return undefined;
					}
				}
				if (concatenated.length === 0) return undefined;
				words.push(concatenated);
				break;
			}
			default:
				return undefined;
		}
	}

	return words;
}

function parseDoubleQuotedString(node: Node): string | undefined {
	if (node.type !== "string") return undefined;
	for (const part of node.namedChildren) {
		if (part.type !== "string_content") return undefined;
	}
	const raw = node.text;
	if (!raw.startsWith('"') || !raw.endsWith('"')) return undefined;
	return raw.slice(1, -1);
}

function parseRawString(node: Node): string | undefined {
	if (node.type !== "raw_string") return undefined;
	const raw = node.text;
	if (!raw.startsWith("'") || !raw.endsWith("'")) return undefined;
	return raw.slice(1, -1);
}
