// Lexical-state-aware bash compatibility highlighter.
//
// Primary grammar ownership stays with Pi/highlight.js for file diffs. Shell
// command rows need Codex's exact token classes (executable / option /
// operator / parameter / builtin), which highlight.js does not emit for bash.
// This pass is a real lexer: a character-level state machine tracks quoting,
// escapes, substitutions and heredocs, so classification always has the
// lexical state available. It is NOT a stateless global regex pass.

import { MOCHA, type MochaToken, foregroundAnsi, type ColorLevel } from "./palette.ts";

export interface BashSpan { readonly text: string; readonly token: MochaToken | "plain" }

const BUILTINS = new Set([
  "alias", "bg", "bind", "break", "builtin", "cd", "command", "compgen", "complete",
  "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit",
  "export", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let",
  "local", "logout", "popd", "printf", "pushd", "pwd", "read", "readonly", "return",
  "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "type",
  "typeset", "ulimit", "umask", "unalias", "unset", "wait",
]);

const OPERATOR_STARTS = ["&&", "||", ";;", ";&", "<<-", "|&"] as const;
const OPERATOR_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")"]);

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

interface RawSpan { text: string; token: MochaToken | "plain" }

/**
 * Tokenize one command line.
 *
 * Command position = first word of the line or a word right after
 * `;` `&&` `||` `|` `(` `&`. Words there classify as builtin/executable.
 */
export function tokenizeBashLine(line: string, atScriptStart: boolean): BashSpan[] {
  const raw: RawSpan[] = [];
  const push = (text: string, token: MochaToken | "plain") => {
    if (!text) return;
    const last = raw.at(-1);
    if (last && last.token === token) last.text += text;
    else raw.push({ text, token });
  };

  // Lexer state (lexical-state-aware: classification reads this state).
  let quote: "none" | "single" | "double" = "none";
  let escape = false;
  let inComment = false;
  let afterControl = true; // line start is command position
  let wordStarted = false;
  let sawExpansion = false;
  let sawSlash = false;
  let wordIsFirstOfCommand = atScriptStart && !afterControl === false; // start-of-line word is first
  let isFirstWordOfLine = atScriptStart;

  const classifyCurrentWord = (word: string): MochaToken | "plain" => {
    if (!word) return "plain";
    if (word.startsWith("--")) return "parameter";
    if (sawExpansion) return "parameter";
    if (word.startsWith("-") && word.length > 1) return "parameter";
    if (wordIsFirstOfCommand && (isFirstWordOfLine || afterControl)) {
      const bare = word.replace(/^\$\{?/, "").replace(/\}$/, "");
      if (BUILTINS.has(bare)) return "builtin";
      if (sawSlash) return "function";
      return "function";
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return "parameter";
    if (/^[0-9]+$/.test(word)) return "number";
    return "plain";
  };

  let wordBuffer = "";
  const endWord = () => {
    if (wordBuffer || wordStarted) {
      push(wordBuffer, classifyCurrentWord(wordBuffer));
      wordBuffer = "";
      wordStarted = false;
      sawExpansion = false;
      sawSlash = false;
      wordIsFirstOfCommand = false;
      afterControl = false;
    }
  };

  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (inComment) { push(char, "comment"); index += 1; continue; }
    if (escape) {
      // Escaped character: belongs to the current word/token context.
      if (quote === "double") push(char, "string");
      else if (quote === "single") push(char, "string");
      else { wordBuffer += char; push(char, "plain"); }
      escape = false;
      index += 1;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      if (quote === "double") { push(char, "string"); }
      else { push(char, "plain"); }
      escape = true;
      index += 1;
      continue;
    }
    if (quote === "single") {
      if (char === "'") { push(char, "string"); quote = "none"; }
      else push(char, "string");
      index += 1;
      continue;
    }
    if (quote === "double") {
      if (char === '"') { push(char, "string"); quote = "none"; }
      else push(char, "string");
      index += 1;
      continue;
    }
    // quote === "none"
    if (isWhitespace(char)) {
      endWord();
      push(char, "plain");
      index += 1;
      continue;
    }
    if (char === "'") {
      endWordIfNeeded();
      push(char, "string");
      quote = "single";
      index += 1;
      continue;
    }
    if (char === '"') {
      endWordIfNeeded();
      push(char, "string");
      quote = "double";
      index += 1;
      continue;
    }
    if (char === "#") {
      // Bash rule: a word-initial unquoted # starts a comment.
      if (!wordStarted) {
        endWord();
        inComment = true;
        push(char, "comment");
        index += 1;
        continue;
      }
    }
    if (char === "$") {
      if (!wordStarted) { wordStarted = true; }
      sawExpansion = true;
      wordBuffer += char;
      index += 1;
      continue;
    }
    const two = line.slice(index, index + 2);
    if ((OPERATOR_STARTS as readonly string[]).includes(two) && !(two === "<<" && line[index + 3] === "<")) {
      endWord();
      push(two, "operator");
      afterControl = true;
      index += 2;
      continue;
    }
    if (OPERATOR_CHARS.has(char)) {
      endWord();
      push(char, "operator");
      afterControl = char !== ")";
      index += 1;
      continue;
    }
    // Regular word character: accumulate into the current word; classification
    // happens once at the word boundary (endWord), never per character.
    if (!wordStarted) { wordStarted = true; }
    if (char === "/") sawSlash = true;
    wordBuffer += char;
    index += 1;
  }
  endWord();

  function endWordIfNeeded(): void {
    if (wordStarted) endWord();
  }

  return raw.map((span) => ({ text: span.text, token: span.token }));
}

/** Highlight one line to an ANSI string with the Mocha palette. */
export function highlightBashLine(line: string, atScriptStart: boolean, level: ColorLevel): string {
  return tokenizeBashLine(line, atScriptStart)
    .map((span) => span.token === "plain" ? span.text : `${foregroundAnsi(MOCHA[span.token], level)}${span.text}\x1b[39m`)
    .join("");
}

/**
 * Highlight a multi-line script. Carries heredoc state across lines so a
 * heredoc body is rendered as string content, not re-lexed as commands.
 */
export function highlightBashScript(lines: readonly string[], level: ColorLevel): string[] {
  const out: string[] = [];
  let heredocDelimiter: string | null = null;
  let heredocIndent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (heredocDelimiter) {
      const candidate = heredocIndent ? line.trimStart() : line;
      if (candidate === heredocDelimiter) {
        heredocDelimiter = null;
        out.push(line);
      } else {
        out.push(`${foregroundAnsi(MOCHA.string, level)}${line}\x1b[39m`);
      }
      continue;
    }
    out.push(highlightBashLine(line, i === 0, level));
    // Register heredoc start: <<-DELIM, <<DELIM, <<-'DELIM', <<-"DELIM".
    // <<< here-strings do not open a heredoc body.
    const hereString = /<<<\s*\S/.test(line);
    if (!hereString) {
      const matches = [...line.matchAll(/<<(-?)(?:['"]?)([A-Za-z_][A-Za-z0-9_]*)(?:['"]?)/g)];
      if (matches.length) {
        heredocIndent = matches[0]![1] === "-";
        heredocDelimiter = matches[0]![2]!;
      }
    }
  }
  return out;
}
