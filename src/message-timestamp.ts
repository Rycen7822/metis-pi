import { resolveThemePainter } from "./palette.ts";
import { clipLine } from "./segments.ts";

const beijingTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function formatBeijingTime(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return undefined;
  return beijingTime.format(timestamp);
}

const OWNER = Symbol.for("Rycen7822.metis-pi.user-timestamps");

/** Pi's user component receives only text. Decorate its creation path instead,
 * where live and restored messages still carry their original timestamp. */
export function installUserTimestamps(prototype: object, enabled: () => boolean): { dispose(): void } | undefined {
  if (Reflect.get(prototype, OWNER)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "addMessageToChat");
  if (typeof descriptor?.value !== "function" || !descriptor.configurable || !descriptor.writable) return undefined;
  const original = descriptor.value;
  const owner = {};
  let active = true;
  const wrapper = function (this: {
    outputPad?: number;
    chatContainer?: { children: unknown[]; addChild(component: unknown): void };
  }, ...args: unknown[]): void {
    const chat = this.chatContainer;
    const count = chat?.children.length;
    original.apply(this, args);
    if (!active || !enabled() || !chat || count === undefined || chat.children.length <= count) return;
    const message = args[0] as { role?: unknown; timestamp?: unknown } | undefined;
    if (message?.role !== "user") return;
    const label = formatBeijingTime(message.timestamp);
    if (!label) return;
    try {
      chat.addChild({
        render: (width: number): string[] => {
          const padding = Math.min(Math.max(0, Math.floor(this.outputPad ?? 1)), Math.max(0, width));
          return [resolveThemePainter(undefined)("dim", clipLine(" ".repeat(padding) + label, width))];
        },
        invalidate() {},
      });
    } catch { /* A display decoration must not prevent message delivery. */ }
  };
  try {
    Object.defineProperty(prototype, OWNER, { value: owner, configurable: true });
    Object.defineProperty(prototype, "addMessageToChat", { ...descriptor, value: wrapper });
  } catch {
    if (Reflect.get(prototype, OWNER) === owner) Reflect.deleteProperty(prototype, OWNER);
    return undefined;
  }
  return {
    dispose() {
      active = false;
      if (Object.getOwnPropertyDescriptor(prototype, "addMessageToChat")?.value === wrapper) {
        Object.defineProperty(prototype, "addMessageToChat", descriptor);
      }
      if (Reflect.get(prototype, OWNER) === owner) Reflect.deleteProperty(prototype, OWNER);
    },
  };
}
