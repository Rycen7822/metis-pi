import { chainMembers } from "./types.ts";
import {
  type ContextPruneConfig,
  type SummarizerStats,
  type LiveReclaim,
  type CapturedBatch,
  type ChainCompressionEntry,
  type FlushOptions,
  type FlushResult,
  type DiagnosticKind,
  type ContextMetricsSnapshot,
  type DeferredReason,
  DEFERRED_REASON_LABELS,
  STATUS_WIDGET_ID,
  PROGRESS_WIDGET_ID,
} from "./types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig, persistConfig } from "./config.ts";
import { formatTokens, formatCharProgress, formatCompactCount } from "./stats.ts";
import { Text } from "@earendil-works/pi-tui";
import { openPrunerSettings, protectedToolsDisplay } from "./settings.ts";
import {
  optionLabel, optionValues, parseScalar, rowDescription, scalarRow,
  type ScalarValue, writeScalar,
} from "./setting-fields.ts";
import { normalizeSummaryToolCallRefs } from "./summary-refs.ts";

export function pruneStatusText(
  config: ContextPruneConfig,
  reclaim?: LiveReclaim,
  diagnostics?: Record<DiagnosticKind, number>,
): string {
  if (!config.enabled) return "prune: OFF";
  const diag = diagnostics
    ? [
        diagnostics["unresolved-range"] ? `u${diagnostics["unresolved-range"]}` : "",
        diagnostics["range-id-mismatch"] ? `m${diagnostics["range-id-mismatch"]}` : "",
        diagnostics["orphan-sweep"] ? `o${diagnostics["orphan-sweep"]}` : "",
        diagnostics["backfill-empty"] ? `b${diagnostics["backfill-empty"]}` : "",
      ].filter(Boolean)
    : [];
  const suffix = diag.length > 0 ? ` \u00b7 diag ${diag.join("/")}` : "";
  if (!reclaim || reclaim.beforeChars <= 0) return `prune: ON${suffix}`;
  const beforeTok = Math.round(reclaim.beforeChars / 4);
  const afterTok = Math.round(reclaim.afterChars / 4);
  const reduction = Math.max(0, Math.round((1 - afterTok / beforeTok) * 100));
  return `prune: ON \u00b7 ${formatCompactCount(beforeTok)}->${formatCompactCount(afterTok)} (-${reduction}%)${suffix}`;
}

export function setPruneStatusWidget(
  ctx: { ui: { setStatus: (id: string, text?: string) => void } },
  config: ContextPruneConfig,
  value?: LiveReclaim | string,
  diagnostics?: Record<DiagnosticKind, number>,
  usageTokens = 0,
): void {
  if (!config.showPruneStatusLine) {
    ctx.ui.setStatus(STATUS_WIDGET_ID, undefined);
    return;
  }
  const text = typeof value === "string" ? value : pruneStatusText(config, value, diagnostics);
  // Leading-only separator: the footer joins extension status segments with a
  // single space, so a trailing divider collides with the next segment's leading
  // one and renders doubled. One leading bar yields single dividers between
  // sections, load-order independent.
  ctx.ui.setStatus(STATUS_WIDGET_ID, `\u2502 ${text} \u00b7 usage: ${usageTokens} tokens`);
}

const SUBCOMMANDS = [
  { value: "settings", label: "settings  — interactive settings overlay" },
  { value: "on",       label: "on        — enable context pruning" },
  { value: "off",      label: "off       — disable context pruning" },
  { value: "status",  label: "status    — show status, model, thinking, prune trigger, and status line" },
  { value: "model",   label: "model     — show or set the summarizer model" },
  { value: "thinking", label: "thinking  — show or set the summarizer thinking level" },
  { value: "prune-on", label: "prune-on  — show or set the trigger mode" },
  { value: "batching", label: "batching  — show or set the batching mode (turn / agent-message)" },
  { value: "stats",   label: "stats     — show cumulative summarizer token stats" },
  { value: "now",     label: "now       — flush pending tool calls immediately (widget progress)" },
  { value: "compact", label: "compact   — retroactively compress all eligible closed chains" },
  { value: "protected-tools", label: "protected-tools — show or edit the never-pruned tool allowlist" },
  { value: "protected-paths", label: "protected-paths — show or edit the never-pruned path globs" },
  { value: "min-batch-chars", label: "min-batch-chars — show or set the pre-flush trivial-batch threshold" },
  { value: "compaction-summary-limit", label: "compaction-summary-limit — show or set the native compaction summary token ceiling" },
  { value: "recovery-grace", label: "recovery-grace - show or set how long context_tree_query output stays verbatim (user-turn-groups)" },
  { value: "dedup",   label: "dedup     — toggle pre-flush content-hash dedup (on/off/status)" },
  { value: "help",    label: "help      — show this help" },
] as const;

function parseModelAndThinkingArg(
  value: string,
): { model: string; thinking?: ContextPruneConfig["summarizerThinking"]; error?: string } {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex === -1) {
    return { model: value };
  }

  const model = value.slice(0, separatorIndex);
  const suffix = value.slice(separatorIndex + 1);
  const thinkingField = scalarRow("summarizerThinking");
  const thinking = parseScalar(thinkingField, suffix);
  if (!model || thinking === undefined) {
    return {
      model: value,
      error: `Invalid model thinking suffix: ${suffix}. Use one of: ${optionValues(thinkingField).join(", ")}.`,
    };
  }
  return { model, thinking: thinking as ContextPruneConfig["summarizerThinking"] };
}

const HELP_TEXT = `pruner — automatically summarizes tool-call outputs to keep context lean.

Usage:
  /pruner settings                         Interactive settings overlay
  /pruner on                               Enable context pruning
  /pruner off                              Disable context pruning
  /pruner status                           Show status, model, prune trigger, batching mode, and stats
  /pruner model                            Show the current summarizer model
  /pruner model <id>                       Set summarizer model (e.g. anthropic/claude-haiku-3-5)
  /pruner model <id>:<thinking>            Set summarizer model and thinking together (e.g. openai/gpt-5-mini:low)
  /pruner thinking                         Show the current summarizer thinking level
  /pruner thinking <level>                 Set summarizer thinking: default, off, minimal, low, medium, high, xhigh
  /pruner prune-on                         Show or interactively pick the trigger
  /pruner prune-on on-demand               Only summarize when /pruner now runs
  /pruner prune-on agent-message           Summarize after the agent's final text reply (default; safest for cache stability)
  /pruner batching                         Show or interactively pick the batching granularity
  /pruner batching turn                    One summary per assistant turn (default)
  /pruner batching agent-message           One summary per user→final-agent-message span (merges all turns in a span)
  /pruner stats                            Show cumulative summarizer token stats
  /pruner now                              Flush pending tool calls immediately (shows live footer progress)
  /pruner protected-tools                  Interactively edit the never-pruned tool allowlist
  /pruner protected-tools <names>          Set the allowlist (comma- or space-separated; 'none' clears)
  /pruner protected-paths                  Interactively edit the never-pruned path globs
  /pruner protected-paths <globs>          Set the globs (comma- or space-separated; 'none' clears)
  /pruner min-batch-chars                  Show the current pre-flush trivial-batch threshold
  /pruner min-batch-chars <n>              Set the threshold (non-negative integer; 0 disables)
  /pruner compaction-summary-limit [n]    Show/set native summary token ceiling (0 keeps Pi's limit)
  /pruner recovery-grace                   Show the current recovery grace window (user-turn-groups)
  /pruner recovery-grace <n>               Set the window (non-negative integer; 0 disables)
  /pruner compact                          Retroactively compress all closed chains (ignores rollingWindow; force-compresses every eligible chain)
  /pruner dedup                            Show the current pre-flush content-hash dedup state
  /pruner dedup on|off                     Enable or disable content-hash dedup
  /pruner help                             Show this help

Paid summary admission:
  Default pressure: 70% of the window, 300k tokens, or native capacity minus
  16384 growth headroom, whichever comes first. Final-reply mode obeys this
  gate too; manual now bypasses pressure, not net-benefit/output budgets.
  Remaining semantic batches below minBatchChars (default 5000) make no
  model call. Set 0 to disable ONLY this character guard. Mechanical work
  is measured separately and needs no paid summary.
  Paid replacements must save max(2048, ceil(40% of replaced proxy tokens)).
  The complete summary, including recovery refs/wrapping, is limited to
  min(6144, source - retained stubs - required gain) local o200k proxy tokens.
  Budget rejection retains raw evidence and pending work; the frontier
  never jumps its gap. Quiet non-error notices with quietOversizedSkips.
  These proxy budgets are not provider billing/output tokens.

Protected tools:
  Some tools' outputs must stay verbatim across turns — typically planning tools
  like todowrite / todoread that carry state the agent re-reads later. List
  those tool names in 'protectedTools' (settings) or via /pruner protected-tools.
  Protected calls bypass the summarizer/index entirely: their raw
  ToolResultMessage stays in context. Names that don't match any captured
  tool call are silently ignored.

Content-hash dedup (dedupByContentHash):
  When ON (default), exact (toolName, resultText) SHA-256 identities are
  compared with previously covered records. Allocate the duplicate's own
  recovery ref and verify its actual stub shrinks the local proxy before
  authorizing hiding. No model call is needed; recall preserves each
  occurrence's arguments, status and timestamp. Whitespace is not normalized.
  Intra-flush dedup is not used; archiving alone never authorizes pruning.

Batching mode:
  - turn (default): each assistant turn that used tools gets its own summary block. Small, granular.
  - agent-message: all assistant turns between two consecutive user messages are merged into one summary.
    Use this when a single user request triggers many back-to-back tool rounds that belong together.

Mode guidance:
  - on-demand: maximum manual control. Best when you want to decide exactly when to trade cache stability for shorter context.
${
  "  - agent-message: recommended default. Batches a whole tool-using run, then " +
  "prunes once after the final text reply so future requests become cacheable " +
  "again."
}

Why this matters:
${
  "  Frequent edits to earlier context can reduce prompt/prefix cache hits on " +
  "providers that cache identical prefixes. Batched pruning is usually cheaper and " +
  "faster than pruning every turn."
}

Related:
  - Anthropic prompt caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching

${
  "Settings are saved in [contextPrune] of global <agent-dir>/metis-pi.toml " +
  "(PI_CODING_AGENT_DIR or ~/.pi/agent). /metis-config init imports legacy " +
  "settings and installs metis-pi-config.md. Advanced gain/output/pressure " +
  "constants are configurable in [contextPrune.summaryBudget]."
}`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

type RowStatus = "pending" | "running" | "done" | "skipped";

interface WidgetRow {
  label: string;
  toolCallCount: number;
  rawChars: number;
  status: RowStatus;
  receivedChars: number;
}

/**
 * Registers a multi-row progress widget above the editor for /pruner now.
 * Returns helpers to update row state and clear the widget when done.
 * Each row shows a spinner, label, tool-call count, and live summary char count.
 */
function startPrunerWidget(
  ctx: ExtensionCommandContext,
  batches: CapturedBatch[],
): {
  updateRow: (index: number, status: RowStatus, chars?: number) => void;
  clearWidget: () => void;
} {
  const total = batches.length;
  const rows: WidgetRow[] = batches.map((b, i) => ({
    label: `Batch ${i + 1}/${total}`,
    toolCallCount: b.toolCalls.length,
    rawChars: b.toolCalls.reduce((sum, tc) => sum + tc.resultText.length, 0),
    status: "pending",
    receivedChars: 0,
  }));

  // Capture tui reference from the factory so updateRow can call requestRender.
  let requestRender: (() => void) | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;

  const hasRunningRows = () => rows.some((row) => row.status === "running");

  const stopAnimationLoop = () => {
    if (!animationTimer) return;
    clearInterval(animationTimer);
    animationTimer = undefined;
  };

  // The widget only re-renders when Pi is asked to draw again. Drive a tiny
  // timer while any row is running so the spinner advances even before the
  // summarizer streams its first text chunk.
  const ensureAnimationLoop = () => {
    if (animationTimer || !requestRender || !hasRunningRows()) return;
    animationTimer = setInterval(() => {
      if (!hasRunningRows()) {
        stopAnimationLoop();
        return;
      }
      requestRender?.();
    }, SPINNER_INTERVAL_MS);
    animationTimer.unref?.();
  };

  const syncAnimationLoop = () => {
    if (hasRunningRows()) {
      ensureAnimationLoop();
    } else {
      stopAnimationLoop();
    }
    requestRender?.();
  };

  ctx.ui.setWidget(
    PROGRESS_WIDGET_ID,
    (tui, _theme) => {
      requestRender = () => tui.requestRender();
      syncAnimationLoop();
      return {
        invalidate() {},
        render(_width: number): string[] {
          return rows.map((row) => {
            const count = `${row.toolCallCount} tool call${row.toolCallCount === 1 ? "" : "s"}`;
            if (row.status === "running") {
              const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
              const chars =
                row.receivedChars > 0
                  ? ` · ${formatCharProgress(row.receivedChars, row.rawChars)}`
                  : "";
              return `${frame} ${row.label} · ${count}${chars}`;
            } else if (row.status === "done") {
              return `✓ ${row.label} · ${count} · ${formatCharProgress(row.receivedChars, row.rawChars)}`;
            } else if (row.status === "skipped") {
              return `⚠ ${row.label} · ${count} · skipped`;
            } else {
              return `○ ${row.label} · ${count} · pending`;
            }
          });
        },
      };
    },
    { placement: "aboveEditor" },
  );

  return {
    updateRow(index: number, status: RowStatus, chars?: number) {
      if (index >= 0 && index < rows.length) {
        rows[index].status = status;
        if (chars !== undefined) rows[index].receivedChars = chars;
        syncAnimationLoop();
      }
    },
    clearWidget() {
      stopAnimationLoop();
      requestRender = undefined;
      ctx.ui.setWidget(PROGRESS_WIDGET_ID, undefined);
    },
  };
}

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<FlushResult>,
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[],
  getStats: () => SummarizerStats,
  getLiveReclaim: () => LiveReclaim | undefined,
  compactChains: (ctx: ExtensionCommandContext) => Promise<{ compressedEntries: ChainCompressionEntry[]; skipped: number; reclaimedTokens?: number }>,
  getDiagnosticCounts?: () => Record<DiagnosticKind, number>,
  getContextMetrics?: (ctx: ExtensionCommandContext) => ContextMetricsSnapshot,
  getRearmed?: () => boolean,
  save: (config: ContextPruneConfig) => Promise<void> = saveConfig,
  refreshOccStatus?: (ctx: ExtensionCommandContext) => void,
  getUsageTokens: () => number = () => 0,
): void {
  pi.registerCommand("pruner", {
    description: "Context-prune settings and commands",
    getArgumentCompletions(prefix: string) {
      return SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const parts = args.trim().split(/\s+/);
      let subcommand = parts[0] || undefined;
      const subArgs = parts.slice(1);

      if (!subcommand) {
        const options = SUBCOMMANDS.map((s) => s.label);
        const choice = await ctx.ui.select("pruner — choose a subcommand", options);
        if (!choice) return;
        subcommand = choice.split(/\s+/)[0];
      }

      // Commands and the overlay share scalar parsing/path writes, but not input policy.
      const setScalar = (id: string, value: ScalarValue) => {
        currentConfig.value = writeScalar(currentConfig.value, scalarRow(id), value);
        void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
      };

      switch (subcommand) {
        case "settings": {
          await openPrunerSettings(ctx, currentConfig, save, (config) => {
            refreshOccStatus?.(ctx);
            setPruneStatusWidget(ctx, config, getLiveReclaim(), getDiagnosticCounts?.(), getUsageTokens());
          });
          break;
        }

        case "on":
        case "off": {
          const enabled = subcommand === "on";
          setScalar("enabled", enabled);
          ctx.ui.notify(`Context pruning ${enabled ? "enabled" : "disabled"}.`);
          setPruneStatusWidget(ctx, currentConfig.value, getLiveReclaim(), getDiagnosticCounts?.(), getUsageTokens());
          break;
        }

        case "status": {
          const cfg = currentConfig.value;
          const mode = optionLabel("pruneOn", cfg.pruneOn);
          const s = getStats();
          const statsLine =
            s.callCount > 0
              ? "\n  --- summarizer ---\n  completed usage records: " +
                `${s.callCount}` +
                "\n  input:       " +
                `${formatTokens(s.totalInputTokens)}` +
                " tokens\n  output:      " +
                `${formatTokens(s.totalOutputTokens)}` +
                " tokens"
              : "\n  (no completed summarizer usage yet)";
          const fmtTimeout = (ms: number) => (ms === 0 ? "disabled" : ms < 1000 ? `${ms}ms` : `${ms / 1000}s`);
          const m = getContextMetrics?.(ctx);
          const contextLine = m
            ? "\n  --- context ---\n  thinking:     " +
              `${formatTokens(m.openCycleThinkingTokens)}` +
              " tokens (open segment)\n  chain share:  " +
              `${m.largestChainSharePct}` +
              "%\n  frontier gap: " +
              `${formatTokens(m.frontierGapTokens)}` +
              " tokens" +
              `${getRearmed?.() ? "\n  rearmed:      yes" : ""}`
            : "";
          ctx.ui.notify(
            "pruner status:\n  enabled:  " +
              `${cfg.enabled}` +
              "\n  model:    " +
              `${cfg.summarizerModel}` +
              "\n  thinking: " +
              `${optionLabel("summarizerThinking", cfg.summarizerThinking)}` +
              " (" +
              `${cfg.summarizerThinking}` +
              ")\n  native summary limit: " +
              `${cfg.compactionSummaryMaxTokens || "Pi default"}` +
              "\n  idle to:  " +
              `${fmtTimeout(cfg.summarizerIdleTimeoutMs)}` +
              "\n  max to:   " +
              `${fmtTimeout(cfg.summarizerMaxTimeoutMs)}` +
              "\n  trigger:  " +
              `${mode}` +
              "\n  batching: " +
              `${optionLabel("batchingMode", cfg.batchingMode)}` +
              " (" +
              `${cfg.batchingMode}` +
              ")\n  dedup:    " +
              `${cfg.dedupByContentHash ? "on" : "off"}` +
              "\n  status:   " +
              `${cfg.showPruneStatusLine ? "on" : "off"}` +
              `${statsLine}` +
              `${contextLine}`,
          );
          break;
        }

        case "stats": {
          const s = getStats();
          if (s.callCount === 0 && s.chainsCompressed === 0) {
            ctx.ui.notify("pruner stats: no completed summarizer usage yet.");
          } else {
            const chainsLine = s.chainsCompressed > 0 ? `\n  chains:      ${s.chainsCompressed} compressed` : "";
            ctx.ui.notify(
              "pruner stats:\n  completed usage records: " +
                `${s.callCount}` +
                "\n  input:       " +
                `${formatTokens(s.totalInputTokens)}` +
                " tokens\n  output:      " +
                `${formatTokens(s.totalOutputTokens)}` +
                " tokens" +
                `${chainsLine}`,
            );
          }
          break;
        }

        case "model": {
          const modelArg = subArgs[0];
          if (!modelArg) {
            ctx.ui.notify(
              "Current summarizer model: " +
                `${currentConfig.value.summarizerModel}` +
                "\nCurrent summarizer thinking: " +
                `${optionLabel("summarizerThinking", currentConfig.value.summarizerThinking)}` +
                " (" +
                `${currentConfig.value.summarizerThinking}` +
                ")",
            );
          } else {
            const parsed = parseModelAndThinkingArg(modelArg);
            if (parsed.error) {
              ctx.ui.notify(parsed.error, "warning");
              return;
            }
            currentConfig.value = {
              ...currentConfig.value,
              summarizerModel: parsed.model,
              summarizerThinking: parsed.thinking ?? currentConfig.value.summarizerThinking,
            };
            void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
            const thinkingText = parsed.thinking ? ` with thinking ${parsed.thinking}` : "";
            ctx.ui.notify(`Summarizer model set to: ${parsed.model}${thinkingText}`);
          }
          break;
        }

        case "thinking":
        case "prune-on":
        case "batching": {
          const thinking = subcommand === "thinking";
          const trigger = subcommand === "prune-on";
          const row = scalarRow(thinking ? "summarizerThinking" : trigger ? "pruneOn" : "batchingMode");
          let raw = subArgs[0];
          if (!raw) {
            if (thinking) {
              ctx.ui.notify(
                "Current summarizer thinking: " +
                  `${optionLabel(row.id, currentConfig.value.summarizerThinking)}` +
                  " (" +
                  `${currentConfig.value.summarizerThinking}` +
                  ")",
              );
              return;
            }
            const choice = await ctx.ui.select(
              trigger ? "pruner — choose when to trigger summarization" : "pruner — choose batching granularity",
              row.options.map((m) => `${m.value} — ${m.label}`),
            );
            if (!choice) return;
            // Interactive selections historically write the first word directly,
            // even for strict batching. Explicit arguments use the row parser.
            raw = choice.split(/\s+/)[0];
          } else if (parseScalar(row, raw) === undefined) {
            const label = thinking ? "summarizer thinking level" : "batching mode";
            ctx.ui.notify(`Invalid ${label}: ${raw}. Use one of: ${optionValues(row).join(", ")}.`, "warning");
            return;
          }
          setScalar(row.id, raw);
          if (trigger) setPruneStatusWidget(ctx, currentConfig.value, getLiveReclaim(), getDiagnosticCounts?.(), getUsageTokens());
          else ctx.ui.notify(thinking
            ? `Summarizer thinking set to: ${currentConfig.value.summarizerThinking}`
            : `Batching mode set to: ${optionLabel(row.id, currentConfig.value.batchingMode)}`);
          break;
        }

        // Runs regardless of chainCompression.enabled — that flag gates automatic compression;
        // the user invoking /pruner compact is explicit intent.
        case "compact": {
          try {
            const { compressedEntries, skipped, reclaimedTokens } = await compactChains(ctx);
            if (compressedEntries.length === 0) {
              ctx.ui.notify(
                skipped > 0
                  ? `pruner: no chains eligible for compaction (${skipped} skipped — no per-batch summary available)`
                  : "pruner: no chains eligible for compaction",
                "info",
              );
              break;
            }
            const reclaim = reclaimedTokens === undefined ? "incremental token estimate unavailable"
              : `reclaimed ~${reclaimedTokens} tokens (local incremental estimate)`;
            const ids = compressedEntries.map((e) => e.blockId).join(", ");
            ctx.ui.notify(
              `pruner: compacted ${compressedEntries.length} chain${compressedEntries.length === 1 ? "" : "s"} (${ids}), ${reclaim}`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(`pruner: compact failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
          }
          break;
        }

        case "now": {
          if (!currentConfig.value.enabled) {
            ctx.ui.notify("Context pruning is disabled. Run /pruner on first.", "warning");
            return;
          }

          // Capture the pending queue first so we can pre-build the widget rows.
          let batches: CapturedBatch[];
          try {
            batches = capturePendingBatches(ctx);
          } catch (error) {
            ctx.ui.notify(
              `pruner: could not inspect pending batches: ${error instanceof Error ? error.message : String(error)}; raw results retained`,
              "warning",
            );
            break;
          }
          if (batches.length === 0) {
            ctx.ui.notify("pruner: nothing pending — no batches to summarize", "info");
            // Still invoke flushPending so its finally-emitted flush-metrics entry
            // records this attempt (outcome "empty") — the incident's exact
            // undiagnosable "nothing pending" report is precisely what this log
            // exists to make diagnosable on recurrence.
            await flushPending(ctx, { previewedBatches: batches, trigger: "manual" });
            break;
          }

          const { updateRow, clearWidget } = startPrunerWidget(ctx, batches);

          const result = await flushPending(ctx, {
            trigger: "manual",
            previewedBatches: batches,
            onProgress: (index, _total, _batch, stage) => {
              if (stage === "start") {
                updateRow(index, "running", 0);
              } else if (stage === "done") {
                updateRow(index, "done");
              } else {
                updateRow(index, "skipped");
              }
            },
            onBatchTextProgress: (index, _total, _batch, receivedChars) => {
              updateRow(index, "running", receivedChars);
            },
          });

          clearWidget();
          setPruneStatusWidget(ctx, currentConfig.value, getLiveReclaim(), getDiagnosticCounts?.(), getUsageTokens());

          if (!result.ok) {
            if (result.reason === "delivery-pending") {
              ctx.ui.notify("pruner: summary queued — raw results retained until delivery", "info");
              break;
            }
            if (result.reason === "deferred-budget" || result.reason === "deferred") {
              const reasons = Object.entries(result.deferredReasons ?? { budget: 1 })
                .map(([reason, count]) => `${count} batch(es): ${DEFERRED_REASON_LABELS[reason as DeferredReason]}`)
                .join("; ");
              ctx.ui.notify(
                `pruner: raw evidence retained pending — ${reasons}; frontier unchanged across the gap`,
                "info",
              );
              break;
            }
            const suffix = "error" in result && result.error ? ` (${result.error})` : "";
            const progress = result.batchCount
              ? `${result.batchCount} batches completed; remaining retained`
              : "nothing flushed";
            ctx.ui.notify(
              `pruner: ${progress} — ${result.reason}${suffix}`,
              result.reason === "empty" ? "info" : "warning",
            );
            break;
          }

          if (result.reason === "partial") {
            ctx.ui.notify(
              `pruner: ${result.batchCount}/${batches.length} batches completed; remaining retained${result.error ? ` (${result.error})` : ""}`,
              "warning",
            );
            break;
          }

          if (result.reason === "skipped-oversized") {
            ctx.ui.notify(
              "pruner: skipped pruning " +
                `${result.toolCallCount}` +
                " tool call" +
                `${result.toolCallCount === 1 ? "" : "s"}` +
                " — summary was " +
                `${result.summaryCharCount}` +
                " chars vs " +
                `${result.rawCharCount}` +
                " raw chars; frontier advanced past this range",
              "warning",
            );
            break;
          }

          if (result.reason === "skipped-trivial") {
            ctx.ui.notify(
              "pruner: skipped " +
                `${result.toolCallCount}` +
                " trivial tool call" +
                `${result.toolCallCount === 1 ? "" : "s"}` +
                " — " +
                `${result.rawCharCount}` +
                " total raw chars retained; summary candidates below minBatchChars=" +
                `${currentConfig.value.minBatchChars}` +
                "; no LLM call made; frontier advanced past this range",
              "info",
            );
            break;
          }

          if (result.reason === "skipped-deduped") {
            const n = result.dedupedCount ?? result.toolCallCount;
            ctx.ui.notify(
              "pruner: deduplicated " +
                `${n}` +
                " tool call" +
                `${n === 1 ? "" : "s"}` +
                " (" +
                `${result.dedupedRawCharCount ?? result.rawCharCount}` +
                " raw chars) against earlier prunes; no LLM call made; frontier advanced past " +
                "this range",
              "info",
            );
            break;
          }

          ctx.ui.notify(
            "pruner: pruned " +
              `${result.toolCallCount}` +
              " tool call" +
              `${result.toolCallCount === 1 ? "" : "s"}` +
              " from " +
              `${result.batchCount}` +
              " batch" +
              `${result.batchCount === 1 ? "" : "es"}` +
              " — summary " +
              `${result.summaryCharCount}` +
              " chars vs " +
              `${result.rawCharCount}` +
              " raw chars",
            "info",
          );
          break;
        }

        // Bare form opens ctx.ui.input() so the user can edit the list
        // interactively (pre-filled with the current value).  Argument form
        // accepts a comma- and/or whitespace-separated list, or the sentinels
        // `none` / `clear` to empty the list.
        case "protected-tools":
        case "protected-paths": {
          const tools = subcommand === "protected-tools";
          const field = tools ? "protectedTools" : "protectedPaths";
          const label = tools ? "tools" : "paths";
          let raw = subArgs.join(" ").trim();
          if (!raw) {
            const entered = await ctx.ui.input(
              `Protected ${label} (comma-separated ${tools ? "tool names" : "globs"}; empty or 'none' to clear)`,
              currentConfig.value[field].join(", "),
            );
            if (entered === undefined) return; // user cancelled
            raw = entered.trim();
          }
          const nextList = raw === "" || /^(none|clear)$/i.test(raw)
            ? [] : raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
          currentConfig.value = { ...currentConfig.value, [field]: nextList };
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          ctx.ui.notify(`Protected ${label}: ${protectedToolsDisplay(nextList)}`);
          break;
        }

        // Native limits deliberately do not use the overlay's parseInt parser.
        case "compaction-summary-limit": {
          const arg = subArgs[0];
          if (arg === undefined) {
            ctx.ui.notify(`Native summary token limit: ${currentConfig.value.compactionSummaryMaxTokens || "Pi default"}.`);
            break;
          }
          const value = /^\d+$/.test(arg) ? Number(arg) : NaN;
          if (subArgs.length !== 1 || !Number.isSafeInteger(value)) {
            ctx.ui.notify(`Invalid summary limit: "${subArgs.join(" ")}". Expected a non-negative safe integer (0 keeps Pi's limit).`, "warning");
            break;
          }
          setScalar("compactionSummaryMaxTokens", value);
          ctx.ui.notify(`Native summary token limit: ${value || "Pi default"}.`);
          break;
        }

        // Integer scalars accept any non-negative parseInt prefix (not just
        // overlay presets), ignore extra arguments, and disable the guard at 0.
        case "min-batch-chars":
        case "recovery-grace": {
          const batch = subcommand === "min-batch-chars";
          const id = batch ? "minBatchChars" : "recoveryGraceTurns";
          const arg = subArgs[0];
          if (!arg) {
            const cur = currentConfig.value[id];
            const state = cur === 0 ? "disabled" : `${cur} ${batch ? "chars" : "user-turn-group(s)"}`;
            ctx.ui.notify(`Current ${batch ? "minBatchChars" : "recovery grace"}: ${state}.`);
            break;
          }
          const value = parseScalar(scalarRow(id), arg);
          if (value === undefined) {
            ctx.ui.notify(
              `Invalid ${batch ? "minBatchChars" : "recovery-grace"}: "${arg}". Expected a non-negative integer (0 disables).`,
              "warning",
            );
            break;
          }
          setScalar(id, value);
          ctx.ui.notify(
            batch
              ? value === 0
                ? "minBatchChars set to 0 — pre-flush trivial-batch skipping disabled."
                : `minBatchChars set to ${value}.`
              : value === 0
                ? "recovery-grace set to 0 - context_tree_query output stubs immediately."
                : `recovery-grace set to ${value} user-turn-group(s).`,
          );
          break;
        }

        // Bare form shows current state; `on`/`off` flip and persist;
        // `status` is an explicit synonym for bare.
        case "dedup": {
          const arg = (subArgs[0] ?? "").toLowerCase();
          const dedupField = scalarRow("dedupByContentHash");
          if (!arg || arg === "status") {
            const state = currentConfig.value.dedupByContentHash ? "ON" : "OFF";
            ctx.ui.notify(`Content-hash dedup is ${state}. ${rowDescription(dedupField, currentConfig.value)}`);
            break;
          }
          if (arg !== "on" && arg !== "off" && arg !== "true" && arg !== "false") {
            ctx.ui.notify(`Invalid dedup value: "${arg}". Expected on, off, status, true, or false.`, "warning");
            break;
          }
          const next = arg === "on" || arg === "true";
          setScalar(dedupField.id, next);
          ctx.ui.notify(`Content-hash dedup turned ${next ? "ON" : "OFF"}.`);
          break;
        }

        case "help":
          ctx.ui.notify(HELP_TEXT);
          break;

        default:
          ctx.ui.notify(
            `Unknown subcommand: "${subcommand}". Run /pruner help for usage.`,
          );
      }
    },
  });

  pi.registerMessageRenderer("context-prune-summary", (message, { expanded }, theme) => {
    const details = message.details as {
      toolCallRefs?: { shortId: string; toolCallId: string }[];
      toolCallIds?: string[];
      turnIndex: number;
      toolNames: string[];
    };
    const turnIndex = details?.turnIndex ?? "?";
    const toolCount = normalizeSummaryToolCallRefs(details).length;
    const header = theme.fg("accent", `[pruner] Turn ${turnIndex} summary (${toolCount} tool${toolCount === 1 ? "" : "s"})`);
    if (expanded) {
      return new Text(header + "\n" + message.content, 0, 0);
    }
    return new Text(header, 0, 0);
  });
}
