// Fallback lexer aligned with Pi 1.4.0: marked 18.0.11 +
// marked-cjk-friendly 0.1.2 emStrong, strict strikethrough and latex extensions.
// Narrow adaptation of pi-tui src/components/markdown.ts (MIT). Keep native
// tokens authoritative; fallback rows are checked against the actual render so
// drift degrades provenance instead of corrupting copies.

import { Marked, Tokenizer } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
  override del(src: string, maskedSrc: string, prevChar?: string): ReturnType<Tokenizer["del"]> {
    void maskedSrc;
    void prevChar;
    const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
    if (!match) return undefined;
    const text = match[2]!;
    return {
      type: "del",
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  }
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
  let index = source.indexOf(closing, start);
  while (index >= 0 && isEscaped(source, index)) {
    index = source.indexOf(closing, index + closing.length);
  }
  return index;
}

function looksLikePendingDollarMath(source: string): boolean {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

interface LatexToken {
  type: "latex";
  raw: string;
  text: string;
  pending?: boolean;
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
  let opening = "";
  let closing = "";
  if (source.startsWith("$$")) {
    opening = "$$";
    closing = "$$";
  } else if (source.startsWith("\\(")) {
    opening = "\\(";
    closing = "\\)";
  } else if (source.startsWith("\\[")) {
    opening = "\\[";
    closing = "\\]";
  } else if (source.startsWith("$") && !/^\$\s/.test(source)) {
    opening = "$";
    closing = "$";
  } else {
    return undefined;
  }
  const closingIndex = findClosingDelimiter(source, closing, opening.length);
  if (closingIndex >= 0
      && opening === "$"
      && (/\s$/.test(source.slice(opening.length, closingIndex))
          || /^\d/.test(source.slice(closingIndex + 1))
          || (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex))
              && /^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1)))
          || source.slice(opening.length, closingIndex).includes("`"))) {
    return undefined;
  }
  if (closingIndex < 0) {
    const pendingSource = source.slice(opening.length);
    if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
      return { type: "latex", raw: source, text: pendingSource, pending: true };
    }
    return undefined;
  }
  const text = source.slice(opening.length, closingIndex);
  if (!text || text.includes("\n")) {
    return undefined;
  }
  const raw = source.slice(0, closingIndex + closing.length);
  return { type: "latex", raw, text };
}

interface LatexBlockToken {
  type: "latexBlock";
  raw: string;
  text: string;
  pending?: boolean;
}

const TABLE_DELIMITER_ROW_REGEX = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

// A GFM table starts with a header row followed by a delimiter row such as "|---|---|" or "| --- |".
// The header needs a "|" only when the delimiter has none: a pipe-free delimiter without a pipe in the
// header is a thematic break, not a table.
function containsTableStart(source: string): boolean {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length - 1; index++) {
    const delimiterRow = lines[index + 1];
    if ((delimiterRow.includes("|") || lines[index].includes("|")) && TABLE_DELIMITER_ROW_REGEX.test(delimiterRow)) {
      return true;
    }
  }
  return false;
}

function tokenizeBlockLatex(source: string): LatexBlockToken | undefined {
  // Display math never spans a table. Without this check, an unclosed "$$" or "\[" pairs with a later
  // opener or stays pending, swallowing the table. See https://github.com/earendil-works/pi/issues/11159.
  const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
  if (dollarMatch?.[1] && !containsTableStart(dollarMatch[1])) {
    return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
  }

  const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
  if (bracketMatch?.[1] && !containsTableStart(bracketMatch[1])) {
    return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
  }

  const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingBracket?.[1] && !containsTableStart(pendingBracket[1])) {
    return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
  }
  const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1]) && !containsTableStart(pendingDollar[1])) {
    return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
  }
  return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS = [
  {
    name: "latexBlock",
    level: "block" as const,
    start(source: string): number | undefined {
      const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
      return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
    },
    tokenizer: tokenizeBlockLatex,
  },
  {
    name: "latex",
    level: "inline" as const,
    start(source: string): number | undefined {
      const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter((index) => index >= 0);
      return indices.length > 0 ? Math.min(...indices) : undefined;
    },
    tokenizer: tokenizeInlineLatex,
  },
];

export interface MarkdownToken {
  type: string;
  raw?: string;
  text?: string;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  depth?: number;
  ordered?: boolean;
  start?: number;
  loose?: boolean;
  task?: boolean;
  checked?: boolean;
  lang?: string;
  href?: string;
  pending?: boolean;
  [key: string]: unknown;
}

/** Trim a streamed partial closing fence so code blocks do not shrink when
 * the final fence character arrives (host behavior, pi issue #5825). */
function trimPartialClosingFences(tokens: MarkdownToken[]): void {
  const token = tokens[tokens.length - 1];
  if (token?.type === "list") {
    trimPartialClosingFences(token.items?.[token.items.length - 1]?.tokens ?? []);
    return;
  }
  if (token?.type === "blockquote") {
    trimPartialClosingFences(token.tokens ?? []);
    return;
  }
  if (token?.type !== "code") {
    return;
  }
  const marker = /^(`{3,}|~{3,})/.exec(token.raw ?? "")?.[1];
  const lastLine = (token.raw ?? "").split("\n").pop();
  if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
    return;
  }
  token.text = (token.text ?? "").slice(0, -lastLine.length).replace(/\n$/, "");
}

export interface CopyLexer {
  lexer(text: string): MarkdownToken[];
}

export function createCopyLexer(): CopyLexer {
  const parser = new Marked();
  parser.setOptions({ tokenizer: new StrictStrikethroughTokenizer() as never });
  parser.use({
    tokenizer: { emStrong: markedCjkFriendly().tokenizer?.emStrong },
    extensions: [...LATEX_MARKDOWN_EXTENSIONS] as never,
  });
  return {
    lexer(text: string): MarkdownToken[] {
      const tokens = parser.lexer(text) as unknown as MarkdownToken[];
      trimPartialClosingFences(tokens);
      return tokens;
    },
  };
}
