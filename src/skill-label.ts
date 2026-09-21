// Multi-skill labels for the host's folded `[skill] …` entries.
//
// Why: the host parses exactly ONE skill block per user message — parseSkillBlock
// is an anchored single-block regex (`dist/core/agent-session.js`) — and renders
// `[skill] <name> (hint)`. Our skill-mux keeps every invoked skill verbatim by
// nesting the later blocks inside the first block's content (0.18.3), so the
// extra names exist in the component's data but never reach the label.
//
// The entry is a host component (SkillInvocationMessageComponent), so this is
// the same prototype patch skill-fold uses — and it works for the same reason:
// the extension loader aliases `@earendil-works/pi-coding-agent` onto the host's
// own module instance (verified live), so the patched class IS the one the
// session instantiates. We wrap the host's own updateDisplay and rewrite what it
// rendered instead of re-implementing the branch, so theming, the keybinding
// hint and the markdown body all stay the host's.
//
// The surgery is deliberately conservative: only the plain block name is swapped
// for the joined list, and the search starts after the `[skill]` token so a
// skill literally named "skill" cannot hit the token itself. Labels are found by a
// bounded search over `children`/`child` links that stops at the first level holding
// text nodes — Pi 0.86 renders them as `Box → MouseRegion → Container → Text/Markdown`,
// 0.85 renders them as direct children. Anything unexpected — no token in the label,
// name not found, a node without a readable and writable text, an extra wrapper level —
// leaves the host's rendering untouched.

import { patchHostPrototype, type SkillPatchResult } from "./skill-tokens.ts";

const NESTED_SKILL = /<skill\s+name="([^"]+)"/g;
const LABEL_TOKEN = "[skill]";

/** The slice of the host component this patch relies on. */
export interface SkillLabelComponent {
  skillBlock?: { name?: unknown; content?: unknown };
  children?: unknown[];
}

/** A pi-tui Text/Markdown child: the patch needs both halves of the text API. */
interface LabelChild {
  text?: unknown;
  setText?: (text: string) => void;
}

/**
 * How far below the entry the rendered labels may live. 0.85 renders them as direct
 * children; 0.86 wraps them in `MouseRegion` → `Container`. One spare level covers a
 * further host wrapper without letting the patch wander into unrelated text.
 */
const MAX_LABEL_DEPTH = 3;

/** Children of a pi-tui node: containers expose `children`, `MouseRegion` exposes `child`. */
function childNodes(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") return [];
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) return children;
  const child = (node as { child?: unknown }).child;
  return child === undefined ? [] : [child];
}

function isLabelChild(value: unknown): value is LabelChild {
  const label = value as LabelChild | undefined;
  return typeof label?.text === "string" && typeof label.setText === "function";
}

/**
 * Collect the label nodes the host built for this entry, breadth-first and bounded.
 * Only `children`/`child` links are followed, only nodes without a text API are
 * descended into, and the search stops at the first level that yields a label node.
 * A renamed field or an extra wrapper therefore yields nothing and leaves the host's
 * rendering untouched, instead of rewriting arbitrary text elsewhere in the tree.
 */
function collectLabelChildren(root: unknown): LabelChild[] {
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    const labels: LabelChild[] = [];
    for (const child of childNodes(node)) {
      if (isLabelChild(child)) labels.push(child);
      else if (depth < MAX_LABEL_DEPTH) queue.push({ node: child, depth: depth + 1 });
    }
    if (labels.length > 0) return labels;
  }
  return [];
}

/** The block's own name plus every nested skill name, in invocation order. */
export function skillNames(block: SkillLabelComponent["skillBlock"]): string[] {
  const names: string[] = [];
  const own = typeof block?.name === "string" ? block.name.trim() : "";
  if (own) names.push(own);
  const content = typeof block?.content === "string" ? block.content : "";
  for (const match of content.matchAll(NESTED_SKILL)) {
    const name = match[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Replace the first rendered occurrence of `name` with the joined list.
 * `[skill]` marks a collapsed/expanded label, so the search starts after that
 * token; the expanded header (`**name**\n\n…`) has no token and the name there
 * is always the first occurrence. Returns `text` unchanged when there is nothing
 * to join or nothing to replace.
 */
export function joinSkillLabel(text: string, name: string, names: readonly string[]): string {
  if (!name || names.length < 2) return text;
  const token = text.indexOf(LABEL_TOKEN);
  const at = text.indexOf(name, token < 0 ? 0 : token + LABEL_TOKEN.length);
  if (at < 0) return text;
  return text.slice(0, at) + names.join(" + ") + text.slice(at + name.length);
}

/**
 * Patch a component class (not an instance) so every label it renders lists all
 * skill names. Returns `missing` for anything without a prototype (or without
 * `updateDisplay`), so a host refactor degrades to "one name" instead of
 * throwing.
 */
export function installSkillLabelNames(component: unknown): SkillPatchResult {
  return patchHostPrototype(component, "updateDisplay", (original) => {
    if (typeof original !== "function") return undefined;
    const previous = original as (this: SkillLabelComponent) => void;
    return function updateDisplay(this: SkillLabelComponent): void {
      previous.call(this);
      const name = typeof this.skillBlock?.name === "string" ? this.skillBlock.name : "";
      const names = skillNames(this.skillBlock);
      if (names.length < 2) return;
      // Rewrite what the host just built: the collapsed line, and (when expanded)
      // the `**name**` header of the markdown body. Both expose text/setText, but
      // on 0.86 they sit behind MouseRegion → Container rather than directly.
      for (const label of collectLabelChildren(this)) {
        const rewritten = joinSkillLabel(String(label.text), name, names);
        if (rewritten !== label.text) label.setText?.(rewritten);
      }
    };
  });
}
