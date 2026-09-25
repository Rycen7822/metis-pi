import childProcess, { type ChildProcessByStdio } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

const TIMEOUT_MS = 5_000;
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  [Console]::Out.Write('R')
  [Console]::Out.Flush()
  while ($null -ne ($line = [Console]::ReadLine())) {
    $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    if ($text.Length -eq 0) {
      [System.Windows.Forms.Clipboard]::Clear()
    } else {
      [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
    }
    [Console]::Out.Write('K')
    [Console]::Out.Flush()
  }
} catch {
  exit 1
}
`;

/** One warm Windows clipboard process, owned by a local WSL copy session. */
export function createWindowsClipboard() {
  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = childProcess.spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
      Buffer.from(SCRIPT, "utf16le").toString("base64"),
    ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  } catch {
    return { ready: Promise.resolve(false), copy: async () => false, dispose() {} };
  }

  let stopped = false;
  const pending: { ack: number; resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }[] = [];
  // Readiness and writes share the same FIFO/deadline. Single-byte replies need
  // no line framing, partial response buffer or separate startup state machine.
  function waitFor(ack: "R" | "K"): Promise<boolean> {
    return new Promise((resolve) => {
      pending.push({ ack: ack.charCodeAt(0), resolve, timer: setTimeout(stop, TIMEOUT_MS) });
    });
  }
  const ready = waitFor("R");
  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const request of pending) clearTimeout(request.timer);
    child.stdin.destroy();
    child.stdout.destroy();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* Still wait for confirmed closure below. */ }
    }
  }
  const failures: [EventEmitter, string][] = [[child, "error"], [child, "exit"], [child.stdin, "error"], [child.stdout, "error"], [child.stdout, "end"]];
  for (const [emitter, event] of failures) emitter.on(event, stop);
  const closed = new Promise<void>((resolve) => child.once("close", () => {
    stop();
    for (const [emitter, event] of failures) emitter.removeListener(event, stop);
    child.stdout.removeListener("data", onData);
    // A kill request is not proof of termination: only close permits the host
    // fallback to write without a late worker write overwriting its result.
    for (const request of pending.splice(0)) request.resolve(false);
    resolve();
  }));

  function onData(chunk: Buffer): void {
    for (const byte of chunk) {
      if (stopped) return;
      if (byte !== pending[0]?.ack) { stop(); return; }
      const request = pending.shift()!;
      clearTimeout(request.timer);
      request.resolve(true);
    }
  }
  child.stdout.on("data", onData);

  return {
    ready,
    async copy(text: string) {
      if (!(await ready) || stopped) {
        await closed;
        return false;
      }
      const copied = waitFor("K");
      try {
        child.stdin.write(`${Buffer.from(text, "utf8").toString("base64")}\n`, (error) => { if (error) stop(); });
      } catch { stop(); }
      return copied;
    },
    dispose: stop,
  };
}
