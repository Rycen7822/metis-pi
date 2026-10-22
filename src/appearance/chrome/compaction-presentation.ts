import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveThemePainter } from "../../presentation/palette.ts";

const OWNER = Symbol.for("Rycen7822.metis-pi.compaction-presentation");
type HostClass = abstract new (...args: any[]) => object;
interface Host {
  Text: HostClass;
  Markdown: HostClass;
  Spacer: HostClass;
  Container: HostClass;
  MouseRegion: HostClass;
  expandKey(): string;
}
interface Summary {
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
interface Entry extends Summary {
  id: string;
  input: number | undefined;
}
interface View {
  message?: Summary;
  expanded?: boolean;
  children?: unknown[];
}

/** Pi usage.input excludes cached input; output/totalTokens are not request input.
 * All-zero normalized usage can mean the provider omitted usage altogether. */
function requestInput(usage: unknown): number | undefined {
  const value = usage as { input?: number; cacheRead?: number; cacheWrite?: number } | undefined;
  const parts = [value?.input, value?.cacheRead, value?.cacheWrite];
  if (!parts.every((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  const total = parts.reduce((sum, n) => sum + n, 0);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

/** Only the known native count-bearing leaf, never a summary-text search. */
function countLeaf(view: View, host: Host): { setText(text: string): void } | undefined {
  if (view.children?.length !== 1) return undefined;
  const region = view.children[0];
  if (!(region instanceof host.MouseRegion)) return undefined;
  const content = (region as { child?: { children?: unknown[] } }).child;
  if (!(content instanceof host.Container)) return undefined;
  const nodes = (content as { children?: unknown[] }).children;
  if (nodes?.length !== 3 || !(nodes[0] instanceof host.Text) || !(nodes[1] instanceof host.Spacer)) return undefined;
  const leaf = nodes[2];
  if (!(leaf instanceof (view.expanded ? host.Markdown : host.Text))) return undefined;
  return typeof (leaf as { setText?: unknown }).setText === "function"
    ? leaf as { setText(text: string): void } : undefined;
}

function install(prototype: object | undefined, host: Host, paint: () => ReturnType<typeof resolveThemePainter>,
  inputFor: (message: Summary) => number | undefined): { dispose(): void } | undefined {
  if (!prototype || Object.prototype.hasOwnProperty.call(prototype, OWNER)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "updateDisplay");
  if (typeof descriptor?.value !== "function" || !descriptor.configurable || !descriptor.writable
      || !Object.isExtensible(prototype)) return undefined;
  let active = true;
  const wrapper = function (this: View, ...args: unknown[]): void {
    descriptor.value.apply(this, args);
    if (!active) return;
    try {
      const message = this.message;
      if (!message || typeof message.summary !== "string" || typeof this.expanded !== "boolean") return;
      const leaf = countLeaf(this, host);
      if (!leaf) return; // Unknown host/foreign subtree: preserve native rendering.
      const amount = Number.isSafeInteger(message.tokensBefore) && message.tokensBefore >= 0
        ? `${message.tokensBefore.toLocaleString()} tokens` : "unavailable";
      const header = `Compacted · estimated context: ${amount}`;
      const input = inputFor(message);
      const provider = input === undefined ? "" : `Summary request input (provider-reported): ${input.toLocaleString()} tokens`;
      if (this.expanded) {
        leaf.setText(`**${header}**\n\n${provider ? `${provider}\n\n` : ""}${message.summary}`);
      } else {
        const fg = paint();
        leaf.setText(fg("customMessageText", `${header} (`) + fg("dim", host.expandKey())
          + fg("customMessageText", ` to expand)${provider ? `\n${provider}` : ""}`));
      }
    } catch { /* Presentation must never prevent native summary delivery. */ }
  };
  try {
    Object.defineProperty(prototype, OWNER, { value: wrapper, configurable: true });
    Object.defineProperty(prototype, "updateDisplay", { ...descriptor, value: wrapper });
  } catch {
    if (Reflect.get(prototype, OWNER) === wrapper) Reflect.deleteProperty(prototype, OWNER);
    return undefined;
  }
  return { dispose() {
    active = false; // An outer foreign wrapper may still retain this function.
    const current = Object.getOwnPropertyDescriptor(prototype, "updateDisplay");
    if (current?.value === wrapper)
      Reflect.defineProperty(prototype, "updateDisplay", { ...current, value: descriptor.value });
    if (Object.getOwnPropertyDescriptor(prototype, OWNER)?.value === wrapper) Reflect.deleteProperty(prototype, OWNER);
  } };
}

/** Native entry renderers cover custom entries only. Lease the same small
 * prototype boundary as other transcript decorations, keeping the host's
 * Box/MouseRegion/state/Markdown, key handling and selection-copy leaves. */
export function registerCompactionPresentation(pi: Pick<ExtensionAPI, "on">, options: {
  prototype: object | undefined;
  host: Host;
  enabled: boolean;
}): void {
  let handle: ReturnType<typeof install>;
  let entries: Entry[] = [];
  let live: Entry | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  const dispose = (): void => {
    handle?.dispose(); handle = undefined;
    entries = []; live = undefined; ui = undefined;
  };
  const refresh = (ctx: ExtensionContext): void => {
    entries = [];
    live = undefined;
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "compaction") continue;
        entries.push({ id: entry.id, summary: entry.summary, tokensBefore: entry.tokensBefore,
          timestamp: Date.parse(entry.timestamp), input: requestInput(entry.usage) });
      }
    } catch { /* Missing branch metadata must not turn an estimate into usage. */ }
  };
  const inputFor = (message: Summary): number | undefined => {
    const matches = entries.filter(e => e.summary === message.summary && e.tokensBefore === message.tokensBefore);
    const exact = matches.filter(e => e.timestamp === message.timestamp);
    if (exact.length) return exact.length === 1 ? exact[0]!.input : undefined;
    // Pi 1.4 compaction_end builds the live UI message with a FRESH timestamp.
    // Only a freshly observed, unique latest branch entry authorizes this fallback.
    return live && matches.length === 1 && matches[0] === live && message.timestamp >= live.timestamp
      ? live.input : undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (!options.enabled || ctx.mode !== "tui" || !ctx.hasUI) return;
    ui = ctx.ui;
    refresh(ctx);
    handle = install(options.prototype, options.host, () => resolveThemePainter(ui?.theme), inputFor);
  });
  pi.on("session_tree", (_event, ctx) => { if (handle) refresh(ctx); });
  pi.on("session_compact", (event, ctx) => {
    if (!handle) return;
    refresh(ctx);
    const latest = entries.at(-1);
    if (latest?.id === event.compactionEntry.id) live = latest;
  });
  pi.on("session_shutdown", dispose);
}
