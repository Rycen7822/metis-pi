/** Visit SGR commands in order, excluding extended-color arguments.
 * Colon colors occupy one field; semicolon colors consume mode + RGB/index.
 * Other ANSI/OSC sequences pass through unchanged. Callers own style policy. */
export function appendAfterSgr(text: string, suffix: (commands: readonly number[]) => string): string {
  return text.replace(/\x1b\[([0-9;:]*)m/g, (sequence: string, raw: string) => {
    const parts = raw.split(";");
    const commands: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const code = part === "" ? 0 : Number.parseInt(part, 10);
      if (!Number.isFinite(code)) continue;
      commands.push(code);
      if ((code === 38 || code === 48 || code === 58) && !part.includes(":")) {
        const mode = Number.parseInt(parts[i + 1] ?? "", 10);
        i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
      }
    }
    return sequence + suffix(commands);
  });
}
