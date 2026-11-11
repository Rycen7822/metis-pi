import type { Terminal } from "@earendil-works/pi-tui";

/** A bounded render surface: input and repaint only, never real terminal modes or output. */
export class EmbeddedTerminal implements Terminal {
  columns = 1;
  rows = 1;
  private onInput?: (data: string) => void;
  private onResize?: () => void;
  private painting = false;

  constructor(readonly kittyProtocolActive: boolean, private readonly repaint: () => void) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void { this.onInput = undefined; this.onResize = undefined; }
  async drainInput(): Promise<void> {}
  write(_data: string): void { if (!this.painting) this.repaint(); }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: Parameters<Terminal["setProgramStatus"]>[0]): void {}

  input(data: string): void { this.onInput?.(data); }

  resize(columns: number, rows: number): void {
    if (this.columns === columns && this.rows === rows) return;
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }

  frame(render: () => string[]): string[] {
    this.painting = true;
    try { return render(); } finally { this.painting = false; }
  }
}
