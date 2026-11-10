import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readHistoryEntries } from "../../session-history.ts";
import { patchHostPrototype, type HostPatch } from "../../presentation/host-patch.ts";

interface Summary { summary: string; tokensBefore: number; timestamp: number }
interface Header { title: string; subtitle?: string }
interface Entry extends Summary { id: string; input: number | undefined }

/** Pi input excludes cached input. All-zero normalized usage may mean it was omitted. */
function requestInput(usage: unknown): number | undefined {
  const value = usage as { input?: number; cacheRead?: number; cacheWrite?: number } | undefined;
  const parts = [value?.input, value?.cacheRead, value?.cacheWrite];
  if (!parts.every((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  const total = parts.reduce((sum, n) => sum + n, 0);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

function install(component: unknown, inputFor: (message: Summary) => number | undefined): HostPatch {
  return patchHostPrototype(component, "getDisplayHeader", original => {
    if (typeof original !== "function") return undefined;
    const previous = original as (message: Summary) => Header;
    return function (this: unknown, message: Summary): Header {
      const header = previous.call(this, message);
      try {
        if (typeof message?.summary !== "string") return header;
        const amount = Number.isSafeInteger(message.tokensBefore) && message.tokensBefore >= 0
          ? `${message.tokensBefore.toLocaleString()} tokens` : "unavailable";
        const input = inputFor(message);
        return { ...header, title: `Compacted · estimated context: ${amount}`,
          ...(input === undefined ? {} : { subtitle: `Summary request input (provider-reported): ${input.toLocaleString()} tokens` }) };
      } catch { return header; } // Optional presentation cannot prevent native delivery.
    };
  });
}

/** Decorate explicit presentation data; Pi retains the complete rendering lifecycle. */
export function registerCompactionPresentation(pi: Pick<ExtensionAPI, "on">, options: {
  component: unknown;
  enabled: boolean;
}): void {
  let handle: HostPatch | undefined;
  let entries: Entry[] = [];
  let live: Entry | undefined;
  const dispose = (): void => {
    handle?.release(); handle = undefined;
    entries = []; live = undefined;
  };
  const refresh = (ctx: ExtensionContext): void => {
    entries = [];
    live = undefined;
    try {
      for (const entry of readHistoryEntries(ctx.sessionManager, "branch", reference => reference.type === "compaction")) {
        if (entry.type !== "compaction") continue;
        entries.push({ id: entry.id, summary: entry.summary, tokensBefore: entry.tokensBefore,
          timestamp: Date.parse(entry.timestamp), input: requestInput(entry.usage) });
      }
    } catch { /* Missing metadata never turns an estimate into reported usage. */ }
  };
  const inputFor = (message: Summary): number | undefined => {
    const matches = entries.filter(e => e.summary === message.summary && e.tokensBefore === message.tokensBefore);
    const exact = matches.filter(e => e.timestamp === message.timestamp);
    if (exact.length) return exact.length === 1 ? exact[0]?.input : undefined;
    // The native live card has a fresh timestamp. Only a unique freshly observed
    // latest entry authorizes the fallback; restored/ambiguous cards stay unknown.
    return live && matches.length === 1 && matches[0] === live && message.timestamp >= live.timestamp
      ? live.input : undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (!options.enabled || ctx.mode !== "tui" || !ctx.hasUI) return;
    const installed = install(options.component, inputFor);
    if (installed.state === "missing") return;
    handle = installed;
    refresh(ctx);
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
