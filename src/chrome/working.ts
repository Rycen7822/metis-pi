// The standalone Working line, installed as an above-editor widget through
// the host's public ctx.ui.setWidget(key, factory, {placement:"aboveEditor"}).
// 0.8.5: Codex status rhythm (openai/codex status_indicator_widget.rs is the
// layout/timing reference — no identity or brand copying):
//   • Working (3m 36s · thinking 24s · esc to interrupt) · read
// Token/cache/quota stay OUT of the Working line (metadata + footer own
// them). The native loader row is hidden ONLY after this widget installed
// successfully; any failure keeps the native row.
//
// Animation: a restrained shimmer over the message word + bullet pulse, on
// its OWN timer (default 64ms, clamped 32..1000) — separate from the 1s
// elapsed ticker. A frame only bumps a counter and requests a render; it
// never re-reads session usage, disk, or quota. NO_COLOR / ansi16 /
// animation:false render static. The timer lives only while active; settle
// and dispose stop it (idle must leave zero timers).

import { formatDuration, formatTokensCompact, type ActivityPhase } from "../ui-metrics.ts";

export interface WorkingSnapshot {
  active: boolean;
  phase: ActivityPhase;
  elapsedMs: number;
  thinkingMs: number;
  thinkingOpen: boolean;
  tools: { first: string; count: number } | undefined;
}

/** Config-gated segments. `elapsed:false` removes ONLY the duration — the
 * thought/tool segments keep updating. `tokens` defaults false in 0.8.5
 * (tokens live in the metadata/footer). */
export interface WorkingShow {
  elapsed: boolean;
  thought: boolean;
  tool: boolean;
  tokens: boolean;
}

export interface WorkingAnimation {
  enabled: boolean;
  intervalMs: number; // clamped 32..1000
}

export const WORKING_WIDGET_KEY = "pi-codex-appearance:working";
export const INTERRUPT_HINT = "esc to interrupt";

export interface WorkingFrame {
  /** Phase label inside the parens. */
  message: string;
  details: string[];
  tool: string | undefined;
}

/** Pure segment builder (testable, no colors). */
export function workingFrame(s: WorkingSnapshotWithUsage, show: WorkingShow): WorkingFrame {
  const message = s.phase === "writing" ? "Writing" : s.phase === "waiting-for-input" ? "Waiting for input" : "Working";
  const details: string[] = [];
  if (show.elapsed) details.push(formatDuration(s.elapsedMs));
  if (show.thought) {
    if (s.thinkingOpen && s.thinkingMs > 0) details.push(`thinking ${formatDuration(s.thinkingMs)}`);
    else if (!s.thinkingOpen && s.thinkingMs > 0) details.push(`thought for ${formatDuration(s.thinkingMs)}`);
  }
  if (show.tokens && s.usage && (s.usage.input > 0 || s.usage.output > 0)) {
    details.push(`↑${formatTokensCompact(s.usage.input)} ↓${formatTokensCompact(s.usage.output)}`);
  }
  details.push(INTERRUPT_HINT);
  return {
    message,
    details,
    tool: show.tool && s.tools ? (s.tools.count > 1 ? `${s.tools.first} +${s.tools.count - 1}` : s.tools.first) : undefined,
  };
}

export interface WorkingSnapshotWithUsage extends WorkingSnapshot {
  usage?: { input: number; output: number };
}

/** Shimmer phase math (pure): brightness steps 0..3, highlight window of 3
 * cells sweeping the message word. Frame counter wraps — no state growth. */
// Shimmer cycle: ENTER (window slides in from the left edge) → SWEEP (across
// the word) → EXIT (fully off the right edge) → PAUSE (word at rest). One wave
// always completes before the next begins — mixing mismatched cycle lengths
// here made the second wave start while the first was mid-word (0.8.5 bug:
// %12 inside a %16 loop cut the sweep short).
// The highlight holds each position for SHIMMER_STEP_FRAMES frames: the host
// coalesces renders, so one-position-per-frame read as stutter.
export const SHIMMER_WINDOW = 3; // highlight width in cells
export const SHIMMER_STEP_FRAMES = 2; // frames per highlight position (~128ms @64ms)
export const SHIMMER_PAUSE = 6; // rest frames after the wave exits

export function shimmerPhase(frame: number, wordLength: number): { bulletStep: number; highlightStart: number } {
  const window = SHIMMER_WINDOW;
  // highlightStart runs -window+1 … wordLength: enters at the left edge and
  // exits fully past the right edge (window covers [start, start+window)).
  const positions = wordLength + window; // entry → fully exited
  const sweep = positions * SHIMMER_STEP_FRAMES;
  const cycle = sweep + SHIMMER_PAUSE;
  const f = ((frame % cycle) + cycle) % cycle;
  const step = Math.floor(f / SHIMMER_STEP_FRAMES);
  const bulletStep = [0, 1, 2, 1][step % 4]!;
  return { bulletStep, highlightStart: step - window + 1 };
}

export interface WorkingComponentInput {
  getSnapshot: () => WorkingSnapshotWithUsage;
  getShow: () => WorkingShow;
  getAnimation: () => WorkingAnimation;
  /** Request a host frame from the animation timer (never in render). */
  requestRender: () => void;
  /** Color level kind for the degradation ladder. */
  colorKind: "truecolor" | "ansi256" | "ansi16" | "none";
  /** Bullet/message painters (accent/dim). */
  paint: (text: string, tone: "accent" | "dim" | "normal") => string;
  /** Injectable scheduler for tests (default: setInterval + unref). */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface WorkingComponent {
  render(width: number): string[];
  invalidate(): void;
  /** Stop the animation timer (settle/shutdown — idle leaves zero timers). */
  stopAnimation(): void;
  dispose?(): void;
}

export function createWorkingComponent(input: WorkingComponentInput): WorkingComponent {
  let frame = 0;
  let stopTimer: (() => void) | undefined;
  let timerActive = false;

  const schedule = input.schedule ?? ((fn, ms) => {
    const t = setInterval(fn, ms);
    (t as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  });

  function syncTimer(active: boolean): void {
    const anim = input.getAnimation();
    const wants = active && anim.enabled && (input.colorKind === "truecolor" || input.colorKind === "ansi256") && anim.intervalMs >= 32 && anim.intervalMs <= 1000;
    if (wants && !timerActive) {
      timerActive = true;
      stopTimer = schedule(() => {
        frame += 1;
        input.requestRender();
      }, anim.intervalMs);
    } else if (!wants && timerActive) {
      timerActive = false;
      stopTimer?.();
      stopTimer = undefined;
    }
  }

  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width < 1) return [];
      const snapshot = input.getSnapshot();
      if (!snapshot.active) {
        syncTimer(false);
        return [];
      }
      syncTimer(true);
      const f = workingFrame(snapshot, input.getShow());
      const { bulletStep, highlightStart } = shimmerPhase(frame, f.message.length);

      // Bullet: subtle intensity pulse (truecolor only; else static accent).
      const animated = input.colorKind === "truecolor" && input.getAnimation().enabled;
      const bullet = animated ? bulletPulse(bulletStep) : input.paint("•", "accent");
      // Message word with a 3-cell brightness window sweeping left→right
      // (truecolor only); static accent-adjacent text otherwise.
      const message = animated ? shimmerText(f.message, highlightStart, input.paint) : input.paint(f.message, "normal");

      // Codex rhythm: `• Working (details) · tool` — each span painted
      // exactly ONCE (no nested SGR wraps).
      const open = input.paint("(", "dim");
      const close = input.paint(")", "dim");
      const sep = input.paint(" · ", "dim");
      const detailSpans = f.details.map((d) => input.paint(d, "dim"));
      let line = `${bullet} ${message}`;
      if (detailSpans.length > 0) {
        line += ` ${open}${detailSpans.join(sep)}${close}`;
      }
      if (f.tool) line += `${sep}${input.paint(f.tool, "dim")}`;

      // Cell-width guard: hide decorations, never overflow the widget row.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (plain.length > width) {
        const budget = width - 3; // bullet + space + ellipsis
        return budget >= 1 ? [`${bullet} ${plain.slice(0, budget)}…`] : [bullet.slice(0, Math.max(1, width))];
      }
      return [line];
    },
    invalidate(): void {
      // Stateless per render — the snapshot getter owns freshness.
    },
    stopAnimation(): void {
      syncTimer(false);
    },
    dispose(): void {
      syncTimer(false);
    },
  };
}

function bulletPulse(step: number): string {
  // 3 brightness steps around the accent hue — restrained, no rainbow.
  const shades = ["\x1b[38;2;124;130;150m", "\x1b[38;2;148;226;213m", "\x1b[38;2;190;240;230m", "\x1b[38;2;148;226;213m"];
  const shade = shades[step] ?? "\x1b[38;2;148;226;213m";
  return `${shade}•\x1b[39m`;
}

function shimmerText(text: string, highlightStart: number, paint: WorkingComponentInput["paint"]): string {
  // 3-cell highlight sweeping left→right over the word, dim elsewhere.
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const inWindow = i >= highlightStart && i < highlightStart + 3;
    out += inWindow ? paint(chars[i]!, "accent") : paint(chars[i]!, "dim");
  }
  return out;
}
