import { createWindowsClipboard } from "./windows-clipboard.ts";

type Copy = (text: string) => Promise<boolean | string>;
type ClipboardTui = Record<PropertyKey, unknown> & { copySelection?: Copy };
const OWNER = Symbol.for("Rycen7822.metis-pi.selection-clipboard");

export function needsWindowsClipboard(platform: string, env: NodeJS.ProcessEnv): boolean {
  return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
    && !env.WT_SESSION && !env.SSH_TTY && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.MOSH_CONNECTION;
}

/** Keep the host's copy/flash/error path; only replace its slow WSL transport.
 * The live facade hides the receiver's own descriptors. A leased getter lets
 * us identify that receiver even when the facade switches to another TUI. */
export function createSelectionClipboard(createWriter = createWindowsClipboard) {
  let current: { prototype: object; tui: ClipboardTui; dispose(): void } | undefined;
  return {
    install(tui: unknown): void {
      if (!needsWindowsClipboard(process.platform, process.env) || !tui || typeof tui !== "object") return;
      const prototype = Object.getPrototypeOf(tui) as ClipboardTui | null;
      if (!prototype) return;
      if (current?.prototype === prototype && prototype[OWNER] === current) {
        current.tui = tui as ClipboardTui;
        return;
      }
      current?.dispose();
      const previous = prototype[OWNER] as { dispose?: () => void } | undefined;
      previous?.dispose?.();
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "copyTextToClipboard");
      if (!descriptor || typeof descriptor.value !== "function") return;
      const native = descriptor.value as (this: ClipboardTui, text: string) => Promise<boolean>;
      const identity = Symbol("metis-pi clipboard receiver");
      const identify = function (this: ClipboardTui) { return this; };
      let writer: ReturnType<typeof createWriter> | undefined;
      const lease = {
        prototype,
        tui: tui as ClipboardTui,
        dispose() {
          if (current === lease) current = undefined;
          if (Object.getOwnPropertyDescriptor(prototype, "copyTextToClipboard")?.value === wrapped) {
            Object.defineProperty(prototype, "copyTextToClipboard", descriptor);
          }
          if (Object.getOwnPropertyDescriptor(prototype, identity)?.get === identify) Reflect.deleteProperty(prototype, identity);
          if (prototype[OWNER] === lease) Reflect.deleteProperty(prototype, OWNER);
          writer?.dispose();
        },
      };
      const wrapped = function (this: ClipboardTui, text: string): Promise<boolean> {
        if (current !== lease || lease.tui[identity] !== this) return native.call(this, text);
        const callback = Object.getOwnPropertyDescriptor(this, "copySelection");
        if (!callback?.writable || typeof callback.value !== "function") return native.call(this, text);
        const original = callback.value as Copy;
        const accelerated: Copy = async (value) => {
          if (await writer!.copy(value)) return true;
          // Teardown cancels requests; never launch a fallback after shutdown.
          return current === lease ? original.call(this, value) : false;
        };
        this.copySelection = accelerated;
        try {
          // The native async method invokes the callback before its first await.
          // Restore immediately, not when the pending clipboard write finishes.
          return native.call(this, text);
        } finally {
          if (this.copySelection === accelerated) Object.defineProperty(this, "copySelection", callback);
        }
      };
      try {
        Object.defineProperty(prototype, identity, { configurable: true, get: identify });
        const receiver = lease.tui[identity] as ClipboardTui | undefined;
        const callback = receiver && Object.getOwnPropertyDescriptor(receiver, "copySelection");
        if (!callback?.writable || typeof callback.value !== "function") { lease.dispose(); return; }
        Object.defineProperty(prototype, "copyTextToClipboard", { ...descriptor, value: wrapped });
        Object.defineProperty(prototype, OWNER, { configurable: true, value: lease });
        writer = createWriter();
        current = lease;
      } catch {
        lease.dispose();
      }
    },
    dispose(): void { current?.dispose(); },
  };
}
