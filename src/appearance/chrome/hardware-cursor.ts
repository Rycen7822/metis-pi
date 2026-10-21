// Pi owns fake-cursor rendering; this lease enables the hardware cursor and
// requests a steady bar for the installed editor.
interface CursorTui {
  terminal: { write(data: string): void };
  getShowHardwareCursor(): boolean;
  setShowHardwareCursor(enabled: boolean): void;
}

function isCursorTui(value: unknown): value is CursorTui {
  if (!value || typeof value !== "object") return false;
  const tui = value as Partial<CursorTui>;
  return typeof tui.getShowHardwareCursor === "function"
    && typeof tui.setShowHardwareCursor === "function"
    && typeof tui.terminal?.write === "function";
}

/** Owns the cursor shape and Pi's hardware-visibility flag for one editor. */
export function createHardwareCursor() {
  let lease: { tui: CursorTui; wasVisible: boolean } | undefined;

  const release = (): void => {
    const previous = lease;
    lease = undefined;
    if (!previous) return;
    try {
      if (!previous.wasVisible && previous.tui.getShowHardwareCursor()) {
        previous.tui.setShowHardwareCursor(false);
      }
    } catch { /* renderer may already be stopped */ }
    try { previous.tui.terminal.write("\x1b[0 q"); } catch { /* terminal may already be closed */ }
  };

  const acquire = (value: unknown): void => {
    if (!isCursorTui(value)) {
      release();
      return;
    }
    if (lease?.tui !== value) {
      release();
      try {
        lease = { tui: value, wasVisible: value.getShowHardwareCursor() };
        value.terminal.write("\x1b[6 q"); // DECSCUSR: steady vertical bar
        value.setShowHardwareCursor(true);
      } catch {
        release(); // partial acquisition must not leave a hidden cursor or bar
        return;
      }
    }
  };

  return { acquire, release };
}
