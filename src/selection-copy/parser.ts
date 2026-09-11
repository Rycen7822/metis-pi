// Markdown lexer configured EXACTLY like pi-tui's markdown.js (host 0.85.1):
// marked 18.0.5 + strict strikethrough tokenizer + the two latex extensions.
// Narrow adaptation from @earendil-works/pi-tui dist/components/markdown.js
// (MIT): StrictStrikethroughTokenizer, tokenizeInlineLatex, tokenizeBlockLatex
// and trimPartialClosingFences are reproduced so the copy provenance adapter
// sees the same token stream the host renderer lexes. The adapter's output is
// diffed against the host's real render rows, so any host drift here degrades
// provenance instead of corrupting copies.

import { Marked, Tokenizer } from "marked";

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

function tokenizeBlockLatex(source: string): LatexBlockToken | undefined {
  const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
  if (dollarMatch?.[1]) {
    return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
  }
  const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
  if (bracketMatch?.[1]) {
    return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
  }
  const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingBracket) {
    return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
  }
  const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
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
      const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\]")].filter((index) => index >= 0);
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
  parser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] as never });
  return {
    lexer(text: string): MarkdownToken[] {
      const tokens = parser.lexer(text) as unknown as MarkdownToken[];
      trimPartialClosingFences(tokens);
      return tokens;
    },
  };
}
