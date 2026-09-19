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

/** Shimmer phase math (pure). Frame counter wraps — no state growth. */
// Shimmer cycle: ENTER (comet head slides in from the left edge) → SWEEP →
// EXIT (trail fully off the right edge) → PAUSE (word at rest). One wave
// always completes before the next begins (0.8.5 bug: %12 inside a %16 loop
// cut the sweep short).
// The head moves CONTINUOUSLY (a fraction of a cell per frame): the wave
// crosses at a leisurely pace while the 32ms frame rate drives smooth
// sub-cell intensity flow — high frame rate ≠ fast sweep.
const SHIMMER_TRAIL = 5; // comet trail length in cells behind the head
const SHIMMER_CELLS_PER_FRAME = 0.25; // sweep speed (4 frames per cell @32ms)
const SHIMMER_PAUSE_FRAMES = 16; // rest frames after the wave exits
const BULLET_STEP_FRAMES = 2; // bullet brightness holds ~2 frames

/** Head→trail gradient ramp (truecolor; blue accent, 8 levels). */
const SHIMMER_RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [205, 228, 255],
  [178, 210, 254],
  [152, 192, 252],
  [137, 180, 250],
  [112, 156, 240],
  [88, 127, 217],
  [67, 99, 183],
  [50, 74, 142],
];

export interface ShimmerPhase {
  bulletStep: number;
  /** Continuous comet head position in cells (-1 … wordLength + trail). */
  head: number;
}

export function shimmerPhase(frame: number, wordLength: number): ShimmerPhase {
  const travel = wordLength + SHIMMER_TRAIL + 1; // head: -1 → fully exited
  const sweep = Math.ceil(travel / SHIMMER_CELLS_PER_FRAME);
  const cycle = sweep + SHIMMER_PAUSE_FRAMES;
  const f = ((frame % cycle) + cycle) % cycle;
  const bulletStep = [0, 1, 2, 1][Math.floor(f / BULLET_STEP_FRAMES) % 4]!;
  const head = Math.min(f * SHIMMER_CELLS_PER_FRAME, travel) - 1;
  return { bulletStep, head };
}

/** Gradient color for a cell `dist` cells behind the head (0 = at the head).
 * Returns undefined when the cell is outside the comet. */
export function shimmerCellColor(dist: number): readonly [number, number, number] | undefined {
  if (dist < 0 || dist >= SHIMMER_TRAIL) return undefined;
  const t = dist / SHIMMER_TRAIL;
  const pos = t * (SHIMMER_RAMP.length - 1);
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = SHIMMER_RAMP[i]!;
  const b = SHIMMER_RAMP[Math.min(i + 1, SHIMMER_RAMP.length - 1)]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
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
      const { bulletStep, head } = shimmerPhase(frame, f.message.length);

      // Bullet: subtle intensity pulse (truecolor only; else static accent).
      const animated = input.colorKind === "truecolor" && input.getAnimation().enabled;
      const bullet = animated ? bulletPulse(bulletStep) : input.paint("•", "accent");
      // Message word with a 3-cell brightness window sweeping left→right
      // (truecolor only); static accent-adjacent text otherwise.
      const message = animated ? shimmerText(f.message, head, input.paint) : input.paint(f.message, "normal");

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
  const shades = ["\x1b[38;2;124;130;150m", "\x1b[38;2;137;180;250m", "\x1b[38;2;180;190;254m", "\x1b[38;2;137;180;250m"];
  const shade = shades[step] ?? "\x1b[38;2;137;180;250m";
  return `${shade}•\x1b[39m`;
}

function shimmerText(text: string, head: number, paint: WorkingComponentInput["paint"]): string {
  // Continuous comet: a cell's color depends on its distance BEHIND the head
  // (0 = at the head, brightest; fading along the trail into the theme dim).
  // The head advances a fraction of a cell per frame, so every frame shifts
  // each trail cell's intensity smoothly — motion reads as fluid, not fast.
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const shade = shimmerCellColor(head - i);
    out += shade
      ? `\x1b[38;2;${shade[0]};${shade[1]};${shade[2]}m${chars[i]}\x1b[39m`
      : paint(chars[i]!, "dim");
  }
  return out;
}
