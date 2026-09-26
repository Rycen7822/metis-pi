// Input rewriting and completion policy; resolution of skill bodies is external.
import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { SKILL_TOKEN_EOL, splitLeadingSkillHeads } from "./skill-tokens.ts";

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillInput {
  /** pi.on("input") handler: transform multi-skill input, continue otherwise. */
  onInput(event: InputEvent): InputEventResult;
  /** Expand a text for tests; null means "no transform" (host handles it). */
  expand(text: string): string | null;
}

/** Does the text open with a skill trigger? Single char check, no regex. */
const opensWithSkill = (text: string): boolean => {
  const first = text.charCodeAt(0);
  return (first === 0x2f && text.startsWith("/skill:")) || first === 0xffe5;
};

export function createSkillInput(resolveBlock: (name: string) => string | null): SkillInput {
  const BLOCK_CLOSE = "</skill>";

  /**
   * Fold several expanded blocks into ONE host-parsable block.
   *
   * The host parses exactly one leading skill block per user message
   * (parseSkillBlock: anchored, non-greedy up to the first `</skill>`) and hands
   * everything after that closing tag to a plain-text user-message component.
   * Sibling blocks therefore printed every skill after the first as expanded
   * raw text in the transcript (the first one folded, the rest not). Nesting
   * each later block inside the previous one's content keeps the whole
   * expansion within that single parsed block — the transcript shows one
   * collapsible `[skill] …` entry — while the model still receives every
   * `<skill name="…">` body verbatim, in order, with balanced tags.
   */
  const nestBlocks = (parts: string[]): string => {
    let nested = parts[parts.length - 1]!;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      const part = parts[index]!;
      nested = part.endsWith(BLOCK_CLOSE)
        ? `${part.slice(0, -BLOCK_CLOSE.length)}\n\n${nested}\n${BLOCK_CLOSE}`
        : `${part}\n\n${nested}`;
    }
    return nested;
  };

  const expand = (text: string): string | null => {
    if (!opensWithSkill(text)) return null; // O(1) fast path
    const tokens: { name: string; raw: string; native: boolean }[] = [];
    let rest = text;
    let match: RegExpExecArray | null;
    while ((match = SKILL_TOKEN_EOL.exec(rest)) !== null) {
      tokens.push({ name: match[1], raw: match[0].trimEnd(), native: match[0].startsWith("/skill:") });
      rest = rest.slice(match[0].length);
    }
    if (tokens.length === 0) return null;
    // A lone `/skill:x …` keeps its native host expansion; anything else is
    // ours (the host would swallow a second token or send `￥x` literally).
    if (tokens.length === 1 && tokens[0].native) return null;
    const parts: string[] = [];
    let expanded = 0;
    for (const token of tokens) {
      const block = resolveBlock(token.name);
      // Unknown/unreadable skill stays as its ORIGINAL literal token (host
      // semantics for /skill:; plain preservation for ￥).
      parts.push(block ?? token.raw);
      if (block) expanded += 1;
    }
    // Nothing resolved: pass the text through untouched so the host applies
    // its own native semantics (and we never re-shape literal user text).
    if (expanded === 0) return null;
    const tail = rest.trim();
    const body = parts.length > 1 ? nestBlocks(parts) : parts[0]!;
    return tail ? `${body}\n\n${tail}` : body;
  };

  return {
    expand,
    onInput(event) {
      const text = expand(event.text);
      if (text === null) return { action: "continue" };
      const images = event.images;
      return images && images.length > 0 ? { action: "transform", text, images } : { action: "transform", text };
    },
  };
}

export interface SkillContext {
  /** The exact partial token text before the cursor (this is the replace prefix). */
  partial: string;
  /** Which trigger form the replacement should use. */
  trigger: "/" | "￥";
  /** Lowercase-free name needle for filtering (trigger and `skill:` stripped). */
  needle: string;
}

/**
 * Detect the multi-skill completion context in the text before the cursor:
 * one or more COMPLETE skill tokens, then a partial token that opens a new
 * skill trigger. A `/`-triggered FIRST token is deliberately NOT ours — the
 * host's built-in provider owns first-token `/` menus; we only fill the gap
 * after the first token (and own the ￥ form outright).
 */
export function matchSkillContext(beforeCursor: string): SkillContext | null {
  const { count: head, rest } = splitLeadingSkillHeads(beforeCursor);
  if (head === 0 && !rest.startsWith("￥")) return null;
  let trigger: "/" | "￥";
  let body: string;
  if (rest.startsWith("/")) {
    trigger = "/";
    body = rest.slice(1);
    if (body.includes("/")) return null; // not a fresh trigger token
  } else if (rest.startsWith("￥")) {
    trigger = "￥";
    body = rest.slice(1);
  } else {
    return null; // cursor sits after a space with no new trigger typed yet
  }
  return { partial: rest, trigger, needle: body.startsWith("skill:") ? body.slice(6) : body };
}

const MAX_COMPLETION_ITEMS = 20;

const buildCompletionItems = (ctx: SkillContext, skills: SkillSummary[]): AutocompleteItem[] => {
  const needle = ctx.needle.toLowerCase();
  const prefix = ctx.trigger === "/" ? "/skill:" : "￥";
  return skills
    .filter((skill) => needle.length === 0 || skill.name.toLowerCase().includes(needle))
    .slice(0, MAX_COMPLETION_ITEMS)
    .map((skill) => ({
      value: `${prefix}${skill.name} `,
      label: `skill:${skill.name}`,
      ...(skill.description ? { description: skill.description } : {}),
    }));
};

export type SkillListFn = () => SkillSummary[];

/**
 * Wrap the host's autocomplete provider (ui.addAutocompleteProvider): keep
 * every built-in behavior (first-token slash menus, file paths, arguments),
 * and add skill-name completions for the second-and-later skill tokens —
 * `/skill:a /…` and `￥…` — which the built-in provider abandons (it only
 * completes command names at position 0 and has no skill argument support).
 */
export function createSkillAutocompleteWrapper(listSkills: SkillListFn): (current: AutocompleteProvider) => AutocompleteProvider {
  return (current) => ({
    triggerCharacters: ["￥"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const ctx = matchSkillContext(beforeCursor);
      // Force queries (Tab): in a multi-skill context the user asked for THIS
      // menu, so answer before the built-in (which would serve file paths for
      // a "/…" partial). Regular queries stay built-in-first, zero regression.
      if (ctx && options.force) {
        const items = buildCompletionItems(ctx, listSkills());
        if (items.length > 0) return { items, prefix: ctx.partial };
      }
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (base) return base; // built-in wins everywhere it already answers
      if (!ctx) return null;
      const items = buildCompletionItems(ctx, listSkills());
      return items.length > 0 ? { items, prefix: ctx.partial } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // Same generic prefix replacement the built-in provider uses for
      // non-slash items (our prefix never matches its slash-command branch).
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      // The editor gates ALL forced queries (Tab) behind this hook. In a
      // multi-skill context a forced query means "show me the skill menu"
      // (e.g. Tab right after the second "/", which the editor's printable
      // path refuses to auto-trigger) — let it through even though nothing
      // file-like is under the cursor. Everywhere else: built-in semantics.
      const line = lines[cursorLine] ?? "";
      if (matchSkillContext(line.slice(0, cursorCol))) return true;
      return current.shouldTriggerFileCompletion
        ? current.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
        : true;
    },
  });
}
