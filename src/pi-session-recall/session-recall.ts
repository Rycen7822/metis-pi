// Maintained by metis-pi. Upstream: https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-session-recall
// Source version: 1.0.7; commit: 92964e4c7023ae88788181bb2eeea4497a97de9d
// Local changes use Metis TOML and the host ModelRuntime. See METIS.md.

/**
 * Session Recall Extension - Search and query past pi sessions
 *
 * Two tools:
 *
 * 1. session_search - Find relevant past sessions by keywords.
 *    Use when the user mentions something from a previous conversation
 *    and you need to find which session it was in.
 *
 * 2. session_query - Deep dive into a specific session.
 *    Use after session_search to get detailed information from a
 *    specific session, or when you already know the session path
 *    (e.g., from a handoff).
 *
 * Typical flow: user says "remember when we tried X?" →
 *   session_search("X") → find the right session →
 *   session_query(path, "what approach did we take for X?")
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	SessionManager,
	convertToLlm,
	getMarkdownTheme,
	sessionEntryToContextMessages,
	parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { isMetisConfigTable, readMetisConfig } from "../configuration/store.ts";
import { createRecallRequest } from "./context.ts";
import { searchFiles, searchLines } from "./search.ts";

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Resolve the query model from Metis TOML → fallback to current session model.
 */
function resolveQueryModel(ctx: ExtensionContext): Model<Api> | undefined {
	const section = readMetisConfig(getAgentDir()).config["sessionRecall"];
	const identifier = isMetisConfigTable(section) ? section["queryModel"] : undefined;
	if (typeof identifier === "string" && identifier !== "default") {
		const slash = identifier.indexOf("/");
		if (slash > 0 && slash < identifier.length - 1) {
			const found = ctx.modelRegistry.find(identifier.slice(0, slash), identifier.slice(slash + 1));
			if (found) return found;
		}
	}
	// Fallback: current session model
	return ctx.model;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const encodeProjectPath = (path: string) => path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");

/** Preserve the native default tree; a custom session store is authoritative. */
function getSessionsDir(ctx: ExtensionContext): string {
	const root = resolve(getAgentDir(), "sessions"), current = ctx.sessionManager.getSessionDir();
	const defaultDir = join(root, `--${encodeProjectPath(resolve(ctx.sessionManager.getCwd()))}--`);
	return current && current !== defaultDir ? current : root;
}

/**
 * Extract a readable project name from the encoded session directory path.
 * Session dirs are encoded as: --home-user-projects-myapp--
 * We strip the home directory prefix and convert dashes back to slashes.
 *
 * Uses the same encoding scheme as session-manager:
 *   cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
 * This handles both Unix (/) and Windows (\, C:\) paths.
 */
function projectFromPath(sessionPath: string): string {
	// Match the encoded directory name — handle both / and \ separators
	const match = sessionPath.match(/sessions[/\\](--.*?--)[/\\]/);
	if (!match || !match[1]) return "unknown project";

	// Decode: strip leading/trailing --, replace internal - with /
	let encoded = match[1].slice(2, -2); // remove -- from both ends

	// Encode homedir with the same scheme session-manager uses,
	// so it works on both Unix (/home/can) and Windows (C:\Users\Pc)
	const homeEncoded = encodeProjectPath(homedir());

	if (encoded.startsWith(homeEncoded + "-")) {
		encoded = encoded.slice(homeEncoded.length + 1);
	} else if (encoded === homeEncoded) {
		return "~";
	}

	return encoded.replace(/-/g, "/") || "~";
}

/** Extract date from session filename */
function dateFromPath(sessionPath: string): string {
	const match = sessionPath.match(/(\d{4}-\d{2}-\d{2})T/);
	return match?.[1] ?? "unknown";
}

/** Parse a JSONL line and extract the text content if it's a message */
function extractMessageText(jsonLine: string): { role: string; text: string } | null {
	try {
		const entry = JSON.parse(jsonLine);
		if (entry.type !== "message") return null;
		const msg = entry.message as { role?: unknown; content?: unknown } | undefined;
		if (typeof msg?.role !== "string") return null;
		const role = msg.role;
		const texts = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content)
			? msg.content.filter((block): block is { type: "text"; text: string } =>
				block?.type === "text" && typeof block.text === "string").map(block => block.text).join(" ")
			: "";
		if (!texts) return null;
		return { role, text: texts };
	} catch {
		return null;
	}
}

/** Get a snippet of text around a keyword match */
function snippetAround(text: string, keyword: string, radius = 100): string {
	const lower = text.toLowerCase();
	const idx = lower.indexOf(keyword.toLowerCase());
	if (idx === -1) return text.slice(0, radius * 2);
	const start = Math.max(0, idx - radius);
	const end = Math.min(text.length, idx + keyword.length + radius);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < text.length ? "..." : "";
	return prefix + text.slice(start, end) + suffix;
}

const MAX_SEARCH_RESULTS = 10;
const MAX_SNIPPETS_PER_SESSION = 3;

// ── Extension ────────────────────────────────────────────────────────────────

export default function sessionRecallExtension(pi: ExtensionAPI, options: {
	registerTool?: <T extends TSchema, D = unknown>(action: string, tool: ToolDefinition<T, D>) => void;
	toolName?: string;
} = {}) {
	const registerTool = <T extends TSchema, D = unknown>(action: string, tool: ToolDefinition<T, D>) => {
		if (options.registerTool) options.registerTool(action, tool);
		else pi.registerTool(tool);
	};
	const searchName = options.toolName ? `${options.toolName} action=search` : "session_search";
	const queryName = options.toolName ? `${options.toolName} action=query` : "session_query";
	// ── session_search tool ────────────────────────────────────────────────

	registerTool("search", {
		name: "session_search",
		label: "Session Search",
		description:
			"Find past sessions by literal text search. This is essentially `rg -i -F` over session JSONL files, not semantic search. " +
			"Use one exact token or phrase. Spaces are exact spaces in an exact phrase, so only use spaces for wording you expect appeared in the session, such as an error message. " +
			"Good examples: `libc++abi`, `Cannot find module '@sinclair/typebox'`, `Blender VAT bake`. " +
			"Bad example: `build ci c lib dependency ghostty` because that searches for one exact phrase, not separate keywords. " +
			"Do not combine independent keywords into one search string. If you need multiple unrelated terms, call session_search multiple times. " +
			`Returns up to ${MAX_SEARCH_RESULTS} readable results and discloses omitted matches; refine the query if limited. ` +
			`After finding a likely session, use ${queryName} for semantic questions.`,
		renderResult: (result, options, theme) => {
			const container = new Container();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const details = result.details as { matchCount?: number; totalMatches?: number; query?: string; error?: boolean } | undefined;

			if (details?.error || !details?.matchCount) {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				return container;
			}

			const total = details.totalMatches ?? details.matchCount;
			const count = total > details.matchCount ? `Showing ${details.matchCount} of ${total} sessions` :
				`${details.matchCount} session${details.matchCount > 1 ? "s" : ""}`;
			const summary = `${count} matching "${details.query}"`;
			container.addChild(new Text(theme.fg("toolOutput", summary), 0, 0));

			if (options.expanded) {
				container.addChild(new Spacer(1));
				const body = text.replace(/^[^\n]*\n\n/, "");
				container.addChild(
					new Markdown(body, 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("toolOutput", text),
					}),
				);
			}

			return container;
		},
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				description:
					"Literal search pattern passed to fixed-string ripgrep-style search. Use one distinctive token or exact phrase, not a bag of unrelated keywords. Spaces mean exact spaces in an exact phrase.",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { query } = params;
			const sessionsDir = getSessionsDir(ctx);

			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			if (!existsSync(sessionsDir)) {
				return errorResult("No sessions directory found.");
			}

			try {
				signal?.throwIfAborted();
				const allMatches = await searchFiles(query, sessionsDir, signal);

				if (allMatches.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`No sessions found matching "${query}".\n\n` +
									"session_search is literal fixed-string search, not semantic search. Retry with one exact distinctive token or phrase, such as a filename, package name, error text, function name, issue id, or unique term.",
							},
						],
						details: { matchCount: 0, totalMatches: 0, truncated: false, query },
					};
				}

				const fileMatches = allMatches
					.sort((a, b) => b.count - a.count || b.path.localeCompare(a.path))
					.slice(0, MAX_SEARCH_RESULTS);

				const results: string[] = [];

				for (const { path: filePath, count } of fileMatches) {
					signal?.throwIfAborted();

					const project = projectFromPath(filePath);
					const date = dateFromPath(filePath);

					const matchLines = await searchLines(query, filePath, MAX_SNIPPETS_PER_SESSION, signal);
					if (matchLines.length === 0) continue;

					const snippets: string[] = [];
					for (const line of matchLines) {
						const msg = extractMessageText(line);
						if (!msg) continue;
						const snippet = snippetAround(msg.text, query);
						snippets.push(`  [${msg.role}] ${snippet}`);
					}

					if (snippets.length === 0) continue;

					results.push(
						`**${date}** · \`${project}\` · ${count} match${count > 1 ? "es" : ""}\n` +
							`Session: \`${filePath}\`\n` +
							snippets.join("\n"),
					);
				}

				const details = { matchCount: results.length, totalMatches: allMatches.length,
					truncated: allMatches.length > fileMatches.length, query };
				if (results.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`No readable matches in the first ${fileMatches.length} of ${allMatches.length} matching session files for "${query}".\n\n` +
									"session_search is literal fixed-string search, not semantic search. Retry with one exact distinctive token or phrase, such as a filename, package name, error text, function name, issue id, or unique term.",
							},
						],
						details,
					};
				}

				const count = results.length < allMatches.length ? `Showing ${results.length} of ${allMatches.length} sessions` :
					`Found ${results.length} session${results.length > 1 ? "s" : ""}`;
				const output = `${count} matching "${query}"${details.truncated ? " (limited; refine the query)" : ""}:\n\n` +
					results.join("\n\n---\n\n");

				return {
					content: [{ type: "text" as const, text: output }],
					details,
				};
			} catch (error) {
				if (signal?.aborted) return { content: [{ type: "text" as const, text: "Search was cancelled." }], details: { cancelled: true } };
				return errorResult(`Error searching sessions: ${error}`);
			}
		},
	});

	// ── session_query tool ─────────────────────────────────────────────────

	registerTool("query", {
		name: "session_query",
		label: "Session Query",
		description:
			`Query a specific session file to get detailed information. Use after ${searchName} to dig into a particular session, ` +
			"or when you already have a session path (e.g., from a handoff). Sends the conversation and tool calls, without assistant thinking or tool output, to an LLM for analysis.",
		renderResult: (result, options, theme) => {
			const container = new Container();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const match = text.match(/\*\*Query:\*\* (.+?)\n\n---\n\n([\s\S]+)/);

			if (!match) {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				return container;
			}

			const [, query, answer] = match;

			if (options.expanded) {
				container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(
					new Markdown(answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("toolOutput", text),
					}),
				);
			} else {
				const firstLine = answer
					.trim()
					.split("\n")
					.find((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("---"))
					?.trim() ?? query;
				const summary = firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
				container.addChild(new Text(theme.fg("toolOutput", summary), 0, 0));
			}

			return container;
		},
		parameters: Type.Object({
			sessionPath: Type.String({
				description:
					"Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
			}),
			question: Type.String({
				description:
					"What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { sessionPath, question } = params;

			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(
					`Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}`,
				);
			}

			if (!existsSync(sessionPath)) {
				return errorResult(`Error: Session file not found: ${sessionPath}`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Query: ${question}` }],
				details: { status: "loading", question },
			});

			// Load the session
			let sessionManager: SessionManager;
			try {
				const entries = parseSessionEntries(await readFile(sessionPath, { encoding: "utf8", signal }));
				signal?.throwIfAborted();
				sessionManager = SessionManager.inMemory(ctx.cwd, undefined, entries);
			} catch (err) {
				if (signal?.aborted) return { content: [{ type: "text" as const, text: "Query was cancelled." }], details: { cancelled: true } };
				return errorResult(`Error loading session: ${err}`);
			}

			// Recall reads the historical branch, including messages summarized by
			// compaction. The live request projection would discard that evidence.
			const branch = sessionManager.getBranch();
			const messageCount = branch.filter(entry => entry.type === "message").length;
			const messages = branch.flatMap(sessionEntryToContextMessages);

			if (messages.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "Session is empty - no messages found." },
					],
					details: { empty: true },
				};
			}

			let queryModel: Model<Api> | undefined;
			try {
				queryModel = resolveQueryModel(ctx);
			} catch (err) {
				return errorResult(`Error reading session recall configuration: ${err}`);
			}
			if (!queryModel) {
				return errorResult(
					"Error: No model available to analyze the session. " +
					"Configure sessionRecall.queryModel in metis-pi.toml or set up API keys.",
				);
			}

			try {
				const { context, maxTokens, wasWindowed } = await createRecallRequest(convertToLlm(messages), question, queryModel, signal);
				signal?.throwIfAborted();
				const response = await ctx.modelRegistry.streamSimple(queryModel, context, { signal, maxTokens }).result();
				signal?.throwIfAborted();

				if (response.stopReason === "aborted") {
					return {
						content: [
							{ type: "text" as const, text: "Query was cancelled." },
						],
						details: { cancelled: true },
					};
				}

				if (response.stopReason === "error") {
					const providerError =
						response.errorMessage?.trim() || "The provider returned an error without details.";
					return errorResult(
						`Error querying ${queryModel.provider}/${queryModel.id}: ${providerError}`,
					);
				}

				if (response.content.length === 0) {
					return errorResult(
						`Error querying ${queryModel.provider}/${queryModel.id}: LLM returned an empty response.`,
					);
				}

				const answer = response.content
					.filter(
						(c): c is { type: "text"; text: string } => c.type === "text",
					)
					.map((c) => c.text)
					.join("\n");

				const windowNote = wasWindowed ? ` · windowed` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `**Query:** ${question}\n\n---\n\n${answer}\n\n*Answered by ${queryModel.id} (${queryModel.provider})${windowNote}*`,
						},
					],
					details: {
						sessionPath,
						question,
						messageCount,
						wasWindowed,
					},
				};
			} catch (err) {
				if (signal?.aborted) return { content: [{ type: "text" as const, text: "Query was cancelled." }], details: { cancelled: true } };
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
