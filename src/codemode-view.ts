import {
  asRecord,
  safeText,
  type Component,
  type Highlight,
  type Palette,
  type Renderers,
  type TextFactory,
  type ViewContext,
} from "./tool-names.ts";
import { shellTitle } from "./renderers.ts";
import { stackComponents } from "./copy-stack.ts";

interface NestedView {
  name: string;
  args: unknown;
  result?: unknown;
  isError: boolean;
  isPartial: boolean;
  bytes: number;
}
interface NestedEvent {
  toolCallId: string;
  toolName: string;
  parentToolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

// UI-only references to finalized lifecycle data, never tool_result intercepts.
// Refuse oversize results instead of cutting a diff or changing its evidence.
function sizeOf(value: unknown, seen = new Set<object>(), depth = 0): number {
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  if (seen.size >= 4096 || depth >= 32) return Infinity;
  seen.add(value);
  let bytes = 32;
  for (const [key, item] of Object.entries(value)) {
    bytes += key.length * 2 + 16 + sizeOf(item, seen, depth + 1);
    if (bytes > 4 * 1024 * 1024) return Infinity;
  }
  return bytes;
}

export class CodemodeViewStore {
  readonly #parents = new Map<string, Map<string, NestedView>>();
  #bytes = 0;
  readonly #maxBytes: number;
  constructor(maxBytes = 4 * 1024 * 1024) { this.#maxBytes = maxBytes; }

  start(event: NestedEvent, ownedCodemode = false): void {
    if (!event.parentToolCallId) {
      if (!ownedCodemode) return;
      if (!this.#parents.has(event.toolCallId)) this.#parents.set(event.toolCallId, new Map());
      if (this.#parents.size > 64) {
        const oldest = this.#parents.keys().next().value!;
        for (const view of this.#parents.get(oldest)!.values()) this.#bytes -= view.bytes;
        this.#parents.delete(oldest);
      }
      return;
    }
    const calls = this.#parents.get(event.parentToolCallId);
    if (!calls || calls.size >= 256 || calls.has(event.toolCallId)) return;
    const bytes = sizeOf(event.args);
    if (this.#bytes + bytes > this.#maxBytes) return;
    calls.set(event.toolCallId, { name: event.toolName, args: event.args, isError: false, isPartial: true, bytes });
    this.#bytes += bytes;
  }

  finish(event: NestedEvent): void {
    const view = event.parentToolCallId && this.#parents.get(event.parentToolCallId)?.get(event.toolCallId);
    if (!view) return;
    const argsBytes = sizeOf(view.args), resultBytes = sizeOf(event.result);
    this.#bytes -= view.bytes;
    view.result = this.#bytes + argsBytes + resultBytes <= this.#maxBytes ? event.result : undefined;
    view.bytes = argsBytes + (view.result === undefined ? 0 : resultBytes);
    this.#bytes += view.bytes;
    view.isError = event.isError === true;
    view.isPartial = false;
  }

  get(parent: string, id: string): NestedView | undefined { return this.#parents.get(parent)?.get(id); }
  entries(parent: string): [string, NestedView][] { return [...(this.#parents.get(parent)?.entries() ?? [])]; }
  clear(): void { this.#parents.clear(); this.#bytes = 0; }
}

export type NestedRendererLookup = (name: string, result: unknown) => Renderers | undefined;

/** Folded code has no preview; nested rows share direct-call renderers and budgets. */
export function makeCodemodeRenderers(input: {
  makeText: TextFactory;
  highlight?: Highlight;
  store: CodemodeViewStore;
  shell: Renderers;
  expandHint(): string;
  resolve: NestedRendererLookup;
}): Renderers {
  const states = new WeakMap<object, Map<string, { state: object; call?: Component; result?: Component }>>();
  return {
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("codemode"));
      const code = asRecord(args).code;
      if (typeof code !== "string") return input.makeText(`${title} ${theme.fg("error", "[invalid arg]")}`);
      if (!context.expanded || !code) return input.makeText(title);
      const script = safeText(code);
      return input.makeText(`${title}\n${input.highlight?.(script, "javascript") ?? script}`);
    },
    renderResult(result, options, theme, context) {
      const value = asRecord(result), details = asRecord(value.details);
      const recorded = Array.isArray(details.calls) ? details.calls.map(asRecord) : [];
      const history = asRecord(value.nestedCalls);
      const historicalArgs = new Map((Array.isArray(history.calls) ? history.calls.map(asRecord) : []).map((call) => [call.id, call]));
      const live = input.store.entries(context.toolCallId ?? "");
      const byId = new Map(recorded.map((call) => [call.id, call]));
      const pending = new Map<string, number>();
      const calls: Readonly<Record<string, unknown>>[] = live.map(([id, view]) => {
        if (!byId.has(id)) pending.set(view.name, (pending.get(view.name) ?? 0) + 1);
        return { ...byId.get(id), id, name: view.name, status: view.isPartial ? "running" : view.isError ? "error" : "ok" };
      });
      const liveIds = new Set(live.map(([id]) => id));
      for (const call of recorded) {
        if (liveIds.has(String(call.id))) continue;
        // Pi's running preview ids all end in /?. Real lifecycle ids own state.
        const count = pending.get(String(call.name)) ?? 0;
        if (String(call.id).endsWith("/?") && count > 0) {
          pending.set(String(call.name), count - 1);
          continue;
        }
        calls.push(call);
      }
      const shown = options.expanded ? calls : calls.slice(-8);
      const parts: Component[] = [];
      if (shown.length < calls.length)
        parts.push(
          input.makeText(theme.fg("dim", `… ${calls.length - shown.length} earlier calls (${input.expandHint()})`)),
        );
      let missingResults = false;
      const owner = context.state && typeof context.state === "object" ? context.state : {};
      let slots = states.get(owner);
      if (!slots) {
        slots = new Map();
        states.set(owner, slots);
      }
      for (const call of shown) {
        if (typeof call.id !== "string" || typeof call.name !== "string") continue;
        const captured = input.store.get(context.toolCallId ?? "", call.id);
        if (call.status !== "running" && !call.name.startsWith("models.") && captured?.result === undefined)
          missingResults = true;
        const saved = historicalArgs.get(call.id);
        let args = captured?.args;
        if (args === undefined && saved?.name === call.name) args = saved.arguments;
        if (args === undefined && typeof call.args === "string") {
          try {
            args = JSON.parse(call.args);
          } catch {
            /* Display summary, never guess truncated args. */
          }
        }
        const rawResult = asRecord(captured?.result);
        // Native callbacks receive content/details only; final event isError is authoritative.
        const viewResult =
          captured?.result === undefined ? undefined : { content: rawResult.content, details: rawResult.details };
        const renderers =
          call.name !== "codemode" && !call.id.endsWith("/?") ? input.resolve(call.name, viewResult) : undefined;
        const partial = captured?.isPartial ?? call.status === "running";
        const isError = captured?.isError ?? ["error", "cancelled"].includes(String(call.status));
        if (!renderers || args === undefined) {
          if (renderers === input.shell) {
            // The builtin owner/status is known, but a truncated command isn't.
            const { bullet, title } = shellTitle({ isPartial: partial, isError }, theme);
            parts.push(
              input.makeText(`${bullet} ${theme.fg("toolTitle", title)} ${theme.fg("dim", "[command unavailable]")}`),
            );
            if (options.expanded && call.error)
              parts.push(input.makeText(theme.fg("error", safeText(String(call.error)))));
          } else parts.push(input.makeText(summary(call, theme, options.expanded === true)));
          continue;
        }
        let slot = slots.get(call.id);
        if (!slot) {
          slot = { state: {} };
          slots.set(call.id, slot);
        }
        const nestedContext: ViewContext = {
          ...context,
          args,
          toolCallId: call.id,
          state: slot.state,
          executionStarted: true,
          argsComplete: true,
          isPartial: partial,
          isError,
          hasResult: !partial,
          lastComponent: slot.call,
        };
        try {
          slot.call = renderers.renderCall(args, theme, nestedContext);
          if (viewResult !== undefined) {
            slot.result = renderers.renderResult(viewResult, { ...options, isPartial: partial }, theme, {
              ...nestedContext,
              lastComponent: slot.result,
            });
          } else if (call.error) {
            slot.result = input.shell.renderResult(
              { content: [{ type: "text", text: String(call.error) }] },
              options,
              theme,
              { ...nestedContext, lastComponent: undefined },
            );
          } else slot.result = undefined;
          parts.push(slot.call, ...(slot.result ? [slot.result] : []));
        } catch {
          parts.push(input.makeText(summary(call, theme, options.expanded === true)));
        }
      }
      if (missingResults)
        parts.push(input.makeText(theme.fg("dim", "Nested results unavailable (history or display cache limit)")));
      // Script output may be a computed summary, not a duplicate of tool output.
      // Keep it and its archive path; reuse the ordinary shell's physical-row budget.
      if (!options.isPartial && Array.isArray(value.content)) {
        const content = value.content.filter(
          (block, index) =>
            !(
              index === 0 &&
              asRecord(block).type === "text" &&
              /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(String(asRecord(block).text))
            ),
        );
        if (content.some((block) => asRecord(block).type === "text" && asRecord(block).text)) {
          parts.push(
            input.makeText(theme.fg("dim", "Script output")),
            input.shell.renderResult({ ...value, content }, options, theme, {
              ...context,
              args: {},
              lastComponent: undefined,
            }),
          );
        }
        if (typeof details.fullOutputPath === "string")
          parts.push(input.makeText(theme.fg("dim", `Full output: ${safeText(details.fullOutputPath)}`)));
      }
      return stackComponents(parts, "codemode", "child-placements");
    },
  };
}

function summary(call: Readonly<Record<string, unknown>>, theme: Palette, expanded: boolean): string {
  const failed = ["error", "cancelled"].includes(String(call.status));
  const icon = call.status === "running" ? "…" : failed ? "✗" : "✓";
  const rawArgs = typeof call.args === "string" ? safeText(call.args) : "";
  const args = !expanded && rawArgs.length > 80 ? `${rawArgs.slice(0, 77)}…` : rawArgs;
  const cost = typeof call.cost === "number" && call.cost > 0 ? ` $${call.cost.toPrecision(2)}` : "";
  const duration = typeof call.durationMs === "number" ? ` ${(call.durationMs / 1000).toFixed(2)}s` : "";
  const error = expanded && call.error ? `\n  ${theme.fg("error", safeText(String(call.error)))}` : "";
  return (
    `${theme.fg(failed ? "error" : call.status === "running" ? "dim" : "success", icon)}` +
    " " +
    `${theme.fg("toolTitle", safeText(String(call.name)))}` +
    `${args ? ` ${args}` : ""}` +
    `${duration}` +
    `${cost}` +
    `${error}`
  );
}
