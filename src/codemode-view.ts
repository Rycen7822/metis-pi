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
import { MouseRegion } from "@earendil-works/pi-tui";
import { shellTitle } from "./renderers.ts";
import { stackComponents } from "./copy-stack.ts";
import { detectColorLevel, foregroundAnsi, FG_DEFAULT, type ColorLevel } from "./palette.ts";

interface CodemodeTimerState {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

function timerState(context: ViewContext): CodemodeTimerState | undefined {
  if (!context.state || typeof context.state !== "object") return;
  const state = context.state as { codemodeTimer?: CodemodeTimerState };
  return (state.codemodeTimer ??= {});
}

function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60), remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

function toolTimerText(context: ViewContext, isPartial: boolean): string | undefined {
  const state = timerState(context);
  if (state?.startedAt !== undefined && isPartial && !context.isError && !state.interval && context.invalidate) {
    state.interval = setInterval(context.invalidate, 1000);
    state.interval.unref();
  }
  if (state && (!isPartial || context.isError)) {
    state.endedAt ??= Date.now();
    clearInterval(state.interval);
    state.interval = undefined;
  }
  if (!isPartial && context.durationMs !== undefined) return `Took ${formatToolDuration(context.durationMs)}`;
  if (state?.startedAt === undefined) return;
  return `${isPartial ? "Elapsed" : "Took"} ${formatToolDuration((state.endedAt ?? Date.now()) - state.startedAt)}`;
}

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

interface NestedSlot {
  state: object;
  call?: Component;
  result?: Component;
  expanded?: boolean;
}
interface ExpansionState {
  expanded: boolean;
  script?: boolean;
  output?: boolean;
  allCalls?: boolean;
  slots: Map<string, NestedSlot>;
}

/** Own only codemode clicks; output selection, links and wheel input stay native. */
function clickRegion(component: Component, context: ViewContext, toggle?: () => void): Component {
  return new MouseRegion(component, event => {
    if (event.type !== "click" || event.button !== "left") return;
    if (toggle && !event.shift && !event.alt && !event.ctrl) {
      toggle();
      context.invalidate?.();
    }
    // Never fall through to the host region that toggles the entire tool row.
    return { handled: true };
  });
}

/** Folded code has no preview; nested rows share direct-call renderers and budgets. */
export function makeCodemodeRenderers(input: {
  makeText: TextFactory;
  highlight?: Highlight;
  colorLevel?: ColorLevel;
  store: CodemodeViewStore;
  shell: Renderers;
  expandHint(): string;
  resolve: NestedRendererLookup;
}): Renderers {
  const states = new WeakMap<object, ExpansionState>();
  const expansion = (context: ViewContext, expanded = context.expanded === true): ExpansionState => {
    const owner = context.state && typeof context.state === "object" ? context.state : context;
    let view = states.get(owner);
    if (!view) {
      view = { expanded, slots: new Map() };
      states.set(owner, view);
    } else if (view.expanded !== expanded) {
      // The host/global shortcut is authoritative; clicks never change its flag.
      view.expanded = expanded;
      view.script = view.output = view.allCalls = undefined;
      for (const slot of view.slots.values()) slot.expanded = undefined;
    }
    return view;
  };
  const labelColor = foregroundAnsi("#d97706", input.colorLevel ?? detectColorLevel());
  const label = (text: string) => labelColor ? `${labelColor}${text}${FG_DEFAULT}` : text;
  return {
    renderCall(args, theme, context) {
      const timer = timerState(context);
      if (timer && context.executionStarted && timer.startedAt === undefined) timer.startedAt = Date.now();
      const title = label(theme.bold("codemode"));
      const code = asRecord(args).code;
      if (typeof code !== "string") return clickRegion(input.makeText(`${title} ${theme.fg("error", "[invalid arg]")}`), context);
      const view = expansion(context), expanded = view.script ?? view.expanded;
      const script = expanded && code ? safeText(code) : "";
      const component = input.makeText(script ? `${title}\n${input.highlight?.(script, "javascript") ?? script}` : title);
      return clickRegion(component, context, () => { view.script = !expanded; });
    },
    renderResult(result, options, theme, context) {
      const view = expansion(context, options.expanded === true);
      const timerText = toolTimerText(context, options.isPartial === true);
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
      const allCalls = view.allCalls ?? view.expanded;
      // Keep explicitly opened older calls visible while new calls stream in.
      const shown = allCalls ? calls : calls.filter((call, index) => index >= calls.length - 8
        || typeof call.id === "string" && view.slots.get(call.id)?.expanded === true);
      const parts: Component[] = [];
      if (shown.length < calls.length || allCalls && calls.length > 8) {
        const notice = allCalls ? "Show fewer calls" : `… ${calls.length - shown.length} earlier calls (${input.expandHint()})`;
        parts.push(clickRegion(input.makeText(theme.fg("dim", notice)), context, () => { view.allCalls = !allCalls; }));
      }
      let missingResults = false;
      for (const call of shown) {
        if (typeof call.id !== "string" || typeof call.name !== "string") continue;
        // Preview /? ids are not identities and must never share click state.
        const preview = call.id.endsWith("/?");
        let slot = preview ? undefined : view.slots.get(call.id);
        if (!slot) {
          slot = { state: {} };
          if (!preview) view.slots.set(call.id, slot);
        }
        const expanded = slot.expanded ?? view.expanded;
        const nestedOptions = { ...options, expanded };
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
        const renderers = call.name !== "codemode" && !preview ? input.resolve(call.name, viewResult) : undefined;
        const partial = captured?.isPartial ?? call.status === "running";
        const isError = captured?.isError ?? ["error", "cancelled"].includes(String(call.status));
        let callComponent: Component, resultComponent: Component | undefined;
        if (!renderers || args === undefined) {
          if (renderers === input.shell) {
            // The builtin owner/status is known, but a truncated command isn't.
            const { bullet, title } = shellTitle({ isPartial: partial, isError }, theme);
            callComponent = input.makeText(`${bullet} ${theme.fg("toolTitle", title)} ${theme.fg("dim", "[command unavailable]")}`);
            if (expanded && call.error)
              resultComponent = input.makeText(theme.fg("error", safeText(String(call.error))));
          } else callComponent = input.makeText(summary(call, theme, expanded));
        } else {
          const nestedContext: ViewContext = {
            ...context,
            args,
            toolCallId: call.id,
            state: slot.state,
            expanded,
            executionStarted: true,
            durationMs: typeof call.durationMs === "number" ? call.durationMs : undefined,
            argsComplete: true,
            isPartial: partial,
            isError,
            hasResult: !partial,
            lastComponent: slot.call,
          };
          try {
            slot.call = renderers.renderCall(args, theme, nestedContext);
            if (viewResult !== undefined) {
              slot.result = renderers.renderResult(viewResult, { ...nestedOptions, isPartial: partial }, theme, {
                ...nestedContext,
                lastComponent: slot.result,
              });
            } else if (call.error) {
              slot.result = input.shell.renderResult(
                { content: [{ type: "text", text: String(call.error) }] },
                nestedOptions,
                theme,
                { ...nestedContext, lastComponent: undefined },
              );
            } else slot.result = undefined;
            callComponent = slot.call;
            resultComponent = slot.result;
          } catch {
            callComponent = input.makeText(summary(call, theme, expanded));
          }
        }
        const toggle = preview ? undefined : () => { slot.expanded = !expanded; };
        parts.push(clickRegion(callComponent, context, toggle));
        if (resultComponent) parts.push(clickRegion(resultComponent, context, toggle));
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
          const expanded = view.output ?? view.expanded;
          const toggle = () => { view.output = !expanded; };
          parts.push(
            clickRegion(input.makeText(theme.fg("dim", "Script output")), context, toggle),
            clickRegion(input.shell.renderResult({ ...value, content }, { ...options, expanded }, theme, {
              ...context,
              expanded,
              args: {},
              lastComponent: undefined,
            }), context, toggle),
          );
        }
        if (typeof details.fullOutputPath === "string")
          parts.push(input.makeText(theme.fg("dim", `Full output: ${safeText(details.fullOutputPath)}`)));
      }
      if (timerText) parts.push(input.makeText(label(timerText)));
      return clickRegion(stackComponents(parts, "child-placements"), context);
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
