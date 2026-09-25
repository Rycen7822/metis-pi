// Provenance-tracking replica of pi-tui's wrapTextWithAnsi (host 0.85.1,
// utils.js). Produces the same visual rows plus, per row, the visible-text
// spans and kinds needed to reconstruct logical text on copy.
//
// Fidelity contract: callers diff our styled rows against the host's own
// wrapTextWithAnsi output for the same input; any mismatch drops that line's
// provenance (native extraction instead) — drift degrades, never corrupts.
//
// Adapted ranges: extractAnsiCode / AnsiCodeTracker / splitIntoTokensWithAnsi
// / wrapSingleLine / breakLongWord from @earendil-works/pi-tui utils.js (MIT),
// narrowed to what provenance tracking needs.

export type SpanKind = "content" | "decoration" | "semantic";

/** One kind-homogeneous styled piece of a logical line. */
export interface ProvenanceSegment {
  styled: string;
  kind: SpanKind;
}

export interface ProvenanceSpan {
  colStart: number;
  colEnd: number;
  kind: SpanKind;
  text: string;
}

export interface ProvenanceRow {
  styled: string;
  spans: ProvenanceSpan[];
  /** Whitespace the wrapper consumed at the soft break before this row. */
  bridge: string;
  /** Row starts a host input line (hard boundary), not a soft wrap. */
  hard: boolean;
}

const CJK_BREAK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Printable ASCII runs: every char is a single-cell grapheme and never a CJK
 * breakpoint, so the Segmenter + per-grapheme width calls can be skipped
 * entirely (the common case: English prose and code). */
const ASCII_RUN = /^[\x20-\x7e]+$/;

interface ExtractedAnsi {
  code: string;
  length: number;
}

function extractAnsiCode(str: string, pos: number): ExtractedAnsi | null {
  if (pos >= str.length || str[pos] !== "\x1b") return null;
  const next = str[pos + 1];
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
    if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
    return null;
  }
  if (next === "]" || next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }
  return null;
}

export function stripAnsi(text: string): string {
  const parts: string[] = [];
  let start = 0;
  for (let pos = text.indexOf("\x1b"); pos >= 0; pos = text.indexOf("\x1b", pos)) {
    const ansi = extractAnsiCode(text, pos);
    if (!ansi) { pos++; continue; }
    parts.push(text.slice(start, pos));
    pos += ansi.length;
    start = pos;
  }
  parts.push(text.slice(start));
  return parts.join("");
}

interface Osc8Link {
  params: string;
  url: string;
  terminator: string;
}

function parseOsc8(code: string): Osc8Link | null | undefined {
  if (!code.startsWith("\x1b]8;")) return undefined;
  const terminator = code.endsWith("\x07") ? "\x07" : "\x1b\\";
  const body = code.slice(4, terminator === "\x07" ? -1 : -2);
  const sep = body.indexOf(";");
  if (sep === -1) return undefined;
  const url = body.slice(sep + 1);
  if (!url) return null;
  return { params: body.slice(0, sep), url, terminator };
}

function formatOsc8(link: Osc8Link): string {
  return `\x1b]8;${link.params};${link.url}${link.terminator}`;
}

/** SGR/OSC8 state replica (attribute flags re-emitted on continuation rows). */
class AnsiTracker {
  bold = false; dim = false; italic = false; underline = false;
  blink = false; inverse = false; hidden = false; strikethrough = false;
  fgColor: string | null = null;
  bgColor: string | null = null;
  hyperlink: Osc8Link | null = null;

  process(ansiCode: string): void {
    const link = parseOsc8(ansiCode);
    if (link !== undefined) {
      this.hyperlink = link;
      return;
    }
    if (!ansiCode.endsWith("m")) return;
    const match = ansiCode.match(/\x1b\[([\d;]*)m/);
    if (!match) return;
    const params = match[1]!;
    if (params === "" || params === "0") {
      this.reset();
      return;
    }
    const parts = params.split(";");
    let i = 0;
    while (i < parts.length) {
      const code = Number.parseInt(parts[i]!, 10);
      if (code === 38 || code === 48) {
        if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
          if (code === 38) this.fgColor = colorCode; else this.bgColor = colorCode;
          i += 3;
          continue;
        }
        if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
          if (code === 38) this.fgColor = colorCode; else this.bgColor = colorCode;
          i += 5;
          continue;
        }
      }
      switch (code) {
        case 0: this.reset(); break;
        case 1: this.bold = true; break;
        case 2: this.dim = true; break;
        case 3: this.italic = true; break;
        case 4: this.underline = true; break;
        case 5: this.blink = true; break;
        case 7: this.inverse = true; break;
        case 8: this.hidden = true; break;
        case 9: this.strikethrough = true; break;
        case 21: this.bold = false; break;
        case 22: this.bold = false; this.dim = false; break;
        case 23: this.italic = false; break;
        case 24: this.underline = false; break;
        case 25: this.blink = false; break;
        case 27: this.inverse = false; break;
        case 28: this.hidden = false; break;
        case 29: this.strikethrough = false; break;
        case 39: this.fgColor = null; break;
        case 49: this.bgColor = null; break;
        default:
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.fgColor = String(code);
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.bgColor = String(code);
          break;
      }
      i++;
    }
  }

  reset(): void {
    this.bold = false; this.dim = false; this.italic = false; this.underline = false;
    this.blink = false; this.inverse = false; this.hidden = false; this.strikethrough = false;
    this.fgColor = null; this.bgColor = null;
  }

  getActiveCodes(): string {
    const codes: string[] = [];
    if (this.bold) codes.push("1");
    if (this.dim) codes.push("2");
    if (this.italic) codes.push("3");
    if (this.underline) codes.push("4");
    if (this.blink) codes.push("5");
    if (this.inverse) codes.push("7");
    if (this.hidden) codes.push("8");
    if (this.strikethrough) codes.push("9");
    if (this.fgColor) codes.push(this.fgColor);
    if (this.bgColor) codes.push(this.bgColor);
    let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
    if (this.hyperlink) result += formatOsc8(this.hyperlink);
    return result;
  }

  getLineEndReset(): string {
    let result = "";
    if (this.underline) result += "\x1b[24m";
    if (this.hyperlink) result += `\x1b]8;;${this.hyperlink.terminator}`;
    return result;
  }
}

interface TaggedGrapheme {
  text: string;
  cells: number;
  kind: SpanKind;
}

/** Word/space grouping follows the host (wrap decisions depend on it);
 * SpanKind changes flush in addition so tokens never mix kinds. */
type TokenGroup = "word" | "space";

interface Token {
  styled: string;
  graphemes: TaggedGrapheme[];
  width: number;
  whitespace: boolean;
}

function tokenize(
  segments: ProvenanceSegment[],
  visibleWidth: (s: string) => number,
): Token[] {
  const tokens: Token[] = [];
  let graphemes: TaggedGrapheme[] = [];
  let styled = "";
  let group: TokenGroup | null = null;
  let kind: SpanKind | null = null;
  let pendingAnsi = "";
  const flush = () => {
    if (graphemes.length === 0) return;
    tokens.push({
      styled,
      graphemes,
      width: graphemes.reduce((sum, g) => sum + g.cells, 0),
      whitespace: styled.trim() === "",
    });
    graphemes = [];
    styled = "";
    group = null;
    kind = null;
  };
  for (const segment of segments) {
    let i = 0;
    while (i < segment.styled.length) {
      const ansi = extractAnsiCode(segment.styled, i);
      if (ansi) {
        pendingAnsi += ansi.code;
        i += ansi.length;
        continue;
      }
      let end = i;
      while (end < segment.styled.length && !extractAnsiCode(segment.styled, end)) end++;
      const run = segment.styled.slice(i, end);
      if (ASCII_RUN.test(run)) {
        for (let k = 0; k < run.length; k++) {
          const ch = run[k]!;
          const nextGroup: TokenGroup = ch === " " ? "space" : "word";
          if (graphemes.length > 0 && (group !== nextGroup || kind !== segment.kind)) flush();
          if (pendingAnsi) {
            styled += pendingAnsi;
            pendingAnsi = "";
          }
          group = nextGroup;
          kind = segment.kind;
          styled += ch;
          graphemes.push({ text: ch, cells: 1, kind: segment.kind });
        }
        i = end;
        continue;
      }
      for (const { segment: grapheme } of GRAPHEMES.segment(run)) {
        const isSpace = grapheme === " ";
        if (!isSpace && CJK_BREAK.test(grapheme)) {
          flush();
          tokens.push({
            styled: pendingAnsi + grapheme,
            graphemes: [{ text: grapheme, cells: visibleWidth(grapheme), kind: segment.kind }],
            width: visibleWidth(grapheme),
            whitespace: false,
          });
          pendingAnsi = "";
          continue;
        }
        const nextGroup: TokenGroup = isSpace ? "space" : "word";
        if (graphemes.length > 0 && (group !== nextGroup || kind !== segment.kind)) flush();
        if (pendingAnsi) {
          styled += pendingAnsi;
          pendingAnsi = "";
        }
        group = nextGroup;
        kind = segment.kind;
        styled += grapheme;
        graphemes.push({ text: grapheme, cells: visibleWidth(grapheme), kind: segment.kind });
      }
      i = end;
    }
    // Segment boundary: never let a token span two segments.
    flush();
  }
  if (pendingAnsi) {
    if (graphemes.length > 0) {
      styled += pendingAnsi;
    } else if (tokens.length > 0) {
      tokens[tokens.length - 1]!.styled += pendingAnsi;
    } else {
      tokens.push({ styled: pendingAnsi, graphemes: [], width: 0, whitespace: false });
    }
  }
  flush();
  return tokens;
}

/** Only graphemes retained on this row contribute text/cells. Whitespace
 * consumed at a soft break lives in the next row's bridge, not its spans. */
function spansFromGraphemes(graphemes: TaggedGrapheme[]): ProvenanceSpan[] {
  const spans: ProvenanceSpan[] = [];
  let col = 0;
  let index = 0;
  while (index < graphemes.length) {
    const kind = graphemes[index]!.kind;
    const colStart = col;
    const text: string[] = [];
    while (index < graphemes.length && graphemes[index]!.kind === kind) {
      const g = graphemes[index]!;
      col += g.cells;
      text.push(g.text);
      index++;
    }
    // Join once: a retained += rope costs far more than the span's characters.
    spans.push({ colStart, colEnd: col, kind, text: text.join("") });
  }
  return spans;
}

function styledFor(graphemes: TaggedGrapheme[]): string {
  return graphemes.map((g) => g.text).join("");
}

/** Drop up to `plainChars` trailing visible chars; returns kept graphemes and
 * the plain text actually dropped. */
function dropTrailingPlain(graphemes: TaggedGrapheme[], plainChars: number): { kept: TaggedGrapheme[]; dropped: string } {
  let remaining = plainChars;
  let end = graphemes.length;
  while (remaining > 0 && end > 0) {
    const g = graphemes[end - 1]!;
    if (g.text.length > remaining) break;
    remaining -= g.text.length;
    end--;
  }
  return { kept: graphemes.slice(0, end), dropped: graphemes.slice(end).map((g) => g.text).join("") };
}

interface RawRow {
  styled: string;
  graphemes: TaggedGrapheme[];
  bridge: string;
}

function* styledParts(styled: string): Generator<{ ansi?: string; grapheme?: string }> {
  let i = 0;
  while (i < styled.length) {
    const ansi = extractAnsiCode(styled, i);
    if (ansi) {
      yield { ansi: ansi.code };
      i += ansi.length;
      continue;
    }
    let end = i;
    while (end < styled.length && !extractAnsiCode(styled, end)) end++;
    const run = styled.slice(i, end);
    if (ASCII_RUN.test(run)) {
      for (let k = 0; k < run.length; k++) yield { grapheme: run[k]! };
    } else {
      for (const { segment } of GRAPHEMES.segment(run)) {
        yield { grapheme: segment };
      }
    }
    i = end;
  }
}

/** Wrap one physical sub-line. Mirrors wrapSingleLine + breakLongWord,
 * including the tracker update order (a token's ANSI state lands after the
 * wrap decision, exactly like updateTrackerFromText at loop end). Bridges are
 * attached to the row AFTER the break: trimmed trailing whitespace plus any
 * whitespace token the wrapper dropped there. */
function wrapSubLine(
  tokens: Token[],
  width: number,
  visibleWidth: (s: string) => number,
): RawRow[] {
  if (tokens.length === 0) return [{ styled: "", graphemes: [], bridge: "" }];
  const totalWidth = tokens.reduce((sum, t) => sum + t.width, 0);
  if (totalWidth <= width) {
    const graphemes = tokens.flatMap((t) => t.graphemes);
    return [{ styled: styledFor(graphemes), graphemes, bridge: "" }];
  }
  const rows: RawRow[] = [];
  const tracker = new AnsiTracker();
  let graphemes: TaggedGrapheme[] = [];
  let styled = "";
  let widthSoFar = 0;
  let bridgeAccum = "";

  // Host restarts the line with the active codes materialized immediately.
  const emitRow = (styledSuffix: string): void => {
    rows.push({ styled: styled + styledSuffix, graphemes, bridge: bridgeAccum });
    bridgeAccum = "";
    styled = tracker.getActiveCodes();
    graphemes = [];
    widthSoFar = 0;
  };

  for (const token of tokens) {
    if (token.width > width && !token.whitespace) {
      if (styled) {
        // Host flushes the accumulated line WITHOUT trimEnd in this branch.
        emitRow(tracker.getLineEndReset());
      }
      // breakLongWord: per-grapheme fragments with resets between rows. The
      // token's styled parts interleave ANSI and graphemes; grapheme parts zip
      // 1:1 with token.graphemes (same visible text, same segmentation order),
      // which carries the provenance tags through.
      let fragment: TaggedGrapheme[] = [];
      let fragmentStyled = tracker.getActiveCodes();
      let fragmentWidth = 0;
      let graphemeIndex = 0;
      for (const part of styledParts(token.styled)) {
        if (part.ansi !== undefined) {
          fragmentStyled += part.ansi;
          tracker.process(part.ansi);
          continue;
        }
        const tagged = token.graphemes[graphemeIndex];
        graphemeIndex += 1;
        if (!tagged) break; // segmentation mismatch — differential check drops this line
        const cells = visibleWidth(part.grapheme!);
        if (fragmentWidth + cells > width) {
          rows.push({ styled: fragmentStyled + tracker.getLineEndReset(), graphemes: fragment, bridge: bridgeAccum });
          bridgeAccum = "";
          fragmentStyled = tracker.getActiveCodes();
          fragment = [];
          fragmentWidth = 0;
        }
        fragmentStyled += part.grapheme!;
        fragment.push({ ...tagged, cells });
        fragmentWidth += cells;
      }
      graphemes = fragment;
      styled = fragmentStyled;
      widthSoFar = fragmentWidth;
      continue;
    }
    if (widthSoFar + token.width > width && widthSoFar > 0) {
      const trimmed = styled.trimEnd();
      const removed = styled.length - trimmed.length;
      const suffixPlain = stripAnsi(styled.slice(styled.length - removed));
      const trimmedBridge = removed > 0 && suffixPlain.trim() === "" ? suffixPlain : "";
      const { kept } = dropTrailingPlain(graphemes, suffixPlain.length);
      emitRow(tracker.getLineEndReset());
      // The row just emitted gets the trimmed styled; the trimmed whitespace
      // (plus a dropped whitespace token below) bridges to the NEXT row.
      const emitted = rows[rows.length - 1]!;
      emitted.styled = trimmed + tracker.getLineEndReset();
      emitted.graphemes = kept;
      bridgeAccum += trimmedBridge;
      if (token.whitespace) {
        bridgeAccum += token.graphemes.map((g) => g.text).join("");
        continue;
      }
      styled += token.styled;
      graphemes = [...token.graphemes];
      widthSoFar = token.width;
      for (const code of ansiCodesOf(token.styled)) tracker.process(code);
      continue;
    }
    styled += token.styled;
    graphemes = graphemes.concat(token.graphemes);
    widthSoFar += token.width;
    for (const code of ansiCodesOf(token.styled)) tracker.process(code);
  }
  // Host pushes the final line only when non-empty (ANSI-only counts).
  if (styled) rows.push({ styled, graphemes, bridge: bridgeAccum });
  return rows;
}

function ansiCodesOf(styled: string): string[] {
  const codes: string[] = [];
  let i = 0;
  while (i < styled.length) {
    const ansi = extractAnsiCode(styled, i);
    if (ansi) {
      codes.push(ansi.code);
      i += ansi.length;
      continue;
    }
    i++;
  }
  return codes;
}

/** Split segments on host newline forms into physical sub-lines. Separators
 * become hard row boundaries and belong to no span. */
function splitSubLines(segments: ProvenanceSegment[]): ProvenanceSegment[][] {
  const lines: ProvenanceSegment[][] = [];
  let current: ProvenanceSegment[] = [];
  for (const segment of segments) {
    const pieces = segment.styled.split(/\r\n|\r|\n/);
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]!;
      if (index > 0) {
        lines.push(current);
        current = [];
      }
      if (piece) {
        current.push({ styled: piece, kind: segment.kind });
      }
    }
  }
  lines.push(current);
  return lines;
}

/** Provenance-aware equivalent of wrapTextWithAnsi for ONE logical line that
 * may contain newlines (hard boundaries). `segments` partition the line into
 * kind-homogeneous styled pieces. */
export function wrapWithProvenance(
  segments: ProvenanceSegment[],
  width: number,
  visibleWidth: (s: string) => number,
): ProvenanceRow[] {
  const subLines = splitSubLines(segments);
  const tracker = new AnsiTracker();
  const rows: ProvenanceRow[] = [];
  for (let lineIndex = 0; lineIndex < subLines.length; lineIndex++) {
    const segmentsOfLine = subLines[lineIndex]!;
    const prefix = lineIndex > 0 ? tracker.getActiveCodes() : "";
    const prefixed: ProvenanceSegment[] = segmentsOfLine.length > 0
      ? [{ styled: prefix + segmentsOfLine[0]!.styled, kind: segmentsOfLine[0]!.kind },
         ...segmentsOfLine.slice(1)]
      : segmentsOfLine;
    const rawRows = wrapSubLine(tokenize(prefixed, visibleWidth), width, visibleWidth);
    for (const ansi of segmentsOfLine) {
      for (const code of ansiCodesOf(ansi.styled)) tracker.process(code);
    }
    if (rawRows.length === 0) {
      rows.push({ styled: "", spans: [], bridge: "", hard: true });
      continue;
    }
    for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex++) {
      const raw = rawRows[rowIndex]!;
      rows.push({
        styled: raw.styled,
        spans: spansFromGraphemes(raw.graphemes),
        bridge: raw.bridge,
        hard: rowIndex === 0,
      });
    }
  }
  return rows.length > 0 ? rows : [{ styled: "", spans: [], bridge: "", hard: true }];
}

