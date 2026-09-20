// Shared skill-token parsing for the multi-skill composer.
//
// Dependency-free on purpose: src/chrome/editor.ts (the Codex composer, which
// must never import the host package) needs the exact same token definition as
// src/skill-mux.ts (the completion/expansion side). Both go through this
// module so the syntax cannot drift apart.

/** The trigger prefix of a leading skill token: `/skill:name` or `￥name`. Both
 * token regexes below are built from it so the syntax cannot drift apart. */
const SKILL_TRIGGER = "(?:\\/skill:|￥)";

/** One COMPLETE leading skill token (`/skill:name` or `￥name`) plus the
 * whitespace that ends it. The name runs to the next whitespace. */
export const SKILL_HEAD_TOKEN = new RegExp(`^${SKILL_TRIGGER}(\\S+)\\s+`);

/** The same token terminated by whitespace OR end of input — the mux expansion
 * must also accept a trailing name with no whitespace after it yet. */
export const SKILL_TOKEN_EOL = new RegExp(`^${SKILL_TRIGGER}(\\S+)(\\s+|$)`);

export interface LeadingSkillHeads {
  /** How many complete skill tokens the text opens with. */
  count: number;
  /** Their names, in order. */
  names: string[];
  /** Everything after the last one. */
  rest: string;
}

/** Split off every complete leading skill token: `/skill:a ￥b …` → 2, ["a","b"], "…". */
export function splitLeadingSkillHeads(text: string): LeadingSkillHeads {
  const names: string[] = [];
  let rest = text;
  let match = SKILL_HEAD_TOKEN.exec(rest);
  while (match !== null) {
    names.push(match[1]!);
    rest = rest.slice(match[0].length);
    match = SKILL_HEAD_TOKEN.exec(rest);
  }
  return { count: names.length, names, rest };
}

/**
 * True when the text is ONLY complete skill tokens plus whitespace — i.e. the
 * cursor sits where the NEXT token starts and nothing partial is typed yet.
 * This is the position the host's editor cannot handle on its own: it
 * auto-triggers `/` only at line start (`isAtStartOfMessage()`), the built-in
 * provider answers nothing for it, and the editor discards a completion state
 * whose query returned nothing — so the following `/` keystroke would never
 * reach any provider (see src/skill-mux.ts and the composer's input hook).
 *
 * Name-agnostic: callers that need "resolves to a real skill" add that check.
 */
export function isSkillPrefixOnly(text: string): boolean {
  const { count, rest } = splitLeadingSkillHeads(text);
  return count > 0 && /^\s*$/.test(rest);
}
