import {
  type ContextPruneConfig,
  type SummarizerStats,
  type LiveReclaim,
  type CapturedBatch,
  type ChainCompressionEntry,
  type FlushOptions,
  type DiagnosticKind,
  type ContextMetricsSnapshot,
  STATUS_WIDGET_ID,
  PROGRESS_WIDGET_ID,
} from "./types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig, persistConfig } from "./config.ts";
import { formatTokens, formatCost, formatCharProgress, formatCompactCount } from "./stats.ts";
import { Text } from "@earendil-works/pi-tui";
import { openPrunerSettings, protectedToolsDisplay } from "./settings.ts";
import { optionLabel, optionValues, parseScalar, rowDescription, scalarRow, writeScalar } from "./setting-fields.ts";
import { buildPruneTree, TreeBrowser } from "./tree-browser.ts";
import { normalizeSummaryToolCallRefs } from "./summary-refs.ts";
import type { ToolCallIndexer } from "./indexer.ts";

// ── Status widget text ──────────────────────────────────────────────────────

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
  ctx.ui.setStatus(STATUS_WIDGET_ID, `\u2502 ${text}`);
}

// ── Subcommand list (for completions & interactive picker) ──────────────────

const SUBCOMMANDS = [
  { value: "settings", label: "settings  — interactive settings overlay" },
  { value: "on",       label: "on        — enable context pruning" },
  { value: "off",      label: "off       — disable context pruning" },
  { value: "status",  label: "status    — show status, model, thinking, prune trigger, and status line" },
  { value: "model",   label: "model     — show or set the summarizer model" },
  { value: "thinking", label: "thinking  — show or set the summarizer thinking level" },
  { value: "prune-on", label: "prune-on  — show or set the trigger mode" },
  { value: "batching", label: "batching  — show or set the batching mode (turn / agent-message)" },
  { value: "stats",   label: "stats     — show cumulative summarizer token/cost stats" },
  { value: "tree",    label: "tree      — browse pruned tool calls in a foldable tree" },
  { value: "now",     label: "now       — flush pending tool calls immediately (widget progress)" },
  { value: "compact", label: "compact   — retroactively compress all eligible closed chains" },
  { value: "protected-tools", label: "protected-tools — show or edit the never-pruned tool allowlist" },
  { value: "protected-paths", label: "protected-paths — show or edit the never-pruned path globs" },
  { value: "min-batch-chars", label: "min-batch-chars — show or set the pre-flush trivial-batch threshold" },
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

// ── Help text ───────────────────────────────────────────────────────────────

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
  /pruner stats                            Show cumulative summarizer token/cost stats
  /pruner tree                             Browse pruned tool calls in a foldable tree (Ctrl-O opens selected summary)
  /pruner now                              Flush pending tool calls immediately (shows live footer progress)
  /pruner protected-tools                  Interactively edit the never-pruned tool allowlist
  /pruner protected-tools <names>          Set the allowlist (comma- or space-separated; 'none' clears)
  /pruner protected-paths                  Interactively edit the never-pruned path globs
  /pruner protected-paths <globs>          Set the globs (comma- or space-separated; 'none' clears)
  /pruner min-batch-chars                  Show the current pre-flush trivial-batch threshold
  /pruner min-batch-chars <n>              Set the threshold (non-negative integer; 0 disables)
  /pruner recovery-grace                   Show the current recovery grace window (user-turn-groups)
  /pruner recovery-grace <n>               Set the window (non-negative integer; 0 disables)
  /pruner compact                          Retroactively compress all closed chains (ignores rollingWindow; force-compresses every eligible chain)
  /pruner dedup                            Show the current pre-flush content-hash dedup state
  /pruner dedup on|off                     Enable or disable content-hash dedup
  /pruner help                             Show this help

Trivial-batch skip (minBatchChars):
  If the total raw resultText across a batch is below minBatchChars, the
  batch is skipped: no summarizer LLM call is made, no summary message is
  injected, and the prune frontier still advances so the same tool calls are
  not reconsidered next flush. Default is 1000. Set to 0 to disable.
  This runs BEFORE summarization, so it is cheaper than the post-LLM
  skipped-oversized path that also rejects summaries larger than the raw
  input. Both skip notifications are silenced by quietOversizedSkips.

Protected tools:
  Some tools' outputs must stay verbatim across turns — typically planning tools
  like todowrite / todoread that carry state the agent re-reads later. List
  those tool names in 'protectedTools' (settings) or via /pruner protected-tools.
  Protected calls bypass the summarizer/index entirely: their raw
  ToolResultMessage stays in context. Names that don't match any captured
  tool call are silently ignored.

Content-hash dedup (dedupByContentHash):
  When ON (default), each captured tool call is hashed by
  (toolName, normalize(resultText)) using SHA-1 and compared against records
  already in the indexer. If an earlier prune already covered identical
  content, the duplicate is registered as an alias of the original — no
  summarizer LLM call is made, the duplicate's ToolResultMessage gets
  stub-replaced via pruneMessages, and context_tree_query returns the
  original record when asked with the duplicate's id. Normalization is
  conservative: line endings, per-line trailing whitespace, and a final
  trim() only. Internal whitespace and capitalization are preserved.
  V1 dedupes only against records ALREADY in the indexer (from previous
  flushes); intra-flush dedup is deferred to v2 to avoid dangling aliases
  when a canonical batch is skipped as oversized / trivial.

Batching mode:
  - turn (default): each assistant turn that used tools gets its own summary block. Small, granular.
  - agent-message: all assistant turns between two consecutive user messages are merged into one summary.
    Use this when a single user request triggers many back-to-back tool rounds that belong together.

Mode guidance:
  - on-demand: maximum manual control. Best when you want to decide exactly when to trade cache stability for shorter context.
  - agent-message: recommended default. Batches a whole tool-using run, then prunes once after the final text reply so future requests become cacheable again.

Why this matters:
  Frequent edits to earlier context can reduce prompt/prefix cache hits on providers that cache identical prefixes. Batched pruning is usually cheaper and faster than pruning every turn.

Related:
  - Anthropic prompt caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching

Settings are saved under the "contextPrune" key in <agent-dir>/settings.json (where <agent-dir> is $PI_CODING_AGENT_DIR or ~/.pi/agent).`;

// ── Pruner progress widget ────────────────────────────────────────────────────

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

// ── Command registration ────────────────────────────────────────────────────

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<
    | { ok: true; reason: "flushed" | "skipped-oversized" | "skipped-trivial" | "skipped-deduped"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number; dedupedCount?: number }
    | { ok: false; reason: string; error?: string }
  >,
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[],
  getStats: () => SummarizerStats,
  getLiveReclaim: () => LiveReclaim | undefined,
  indexer: ToolCallIndexer,
  compactChains: (ctx: ExtensionCommandContext) => Promise<{ compressedEntries: ChainCompressionEntry[]; skipped: number }>,
  getDiagnosticCounts?: () => Record<DiagnosticKind, number>,
  getContextMetrics?: (ctx: ExtensionCommandContext) => ContextMetricsSnapshot,
  getRearmed?: () => boolean,
  save: (config: ContextPruneConfig) => Promise<void> = saveConfig,
  refreshOccStatus?: (ctx: ExtensionCommandContext) => void,
): void {
  // Register the /pruner command
  pi.registerCommand("pruner", {
    description: "Context-prune settings and commands",
    getArgumentCompletions(prefix: string) {
      return SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      // Parse subcommand and remaining args from the raw argument string
      const parts = args.trim().split(/\s+/);
      let subcommand = parts[0] || undefined;
      const subArgs = parts.slice(1); // e.g. ["model", "anthropic/claude-haiku-3-5"] or ["on"])

      // ── Bare /pruner → interactive picker ──
      if (!subcommand) {
        const options = SUBCOMMANDS.map((s) => s.label);
        const choice = await ctx.ui.select("pruner — choose a subcommand", options);
        if (!choice) return;
        // Extract the value (first word) from the label like "settings — interactive settings overlay"
        subcommand = choice.split(/\s+/)[0];
      }

      switch (subcommand) {
        // ── /pruner settings ── interactive overlay ──
        case "settings": {
          await openPrunerSettings(ctx, currentConfig, save, (config) => {
            refreshOccStatus?.(ctx);
            setPruneStatusWidget(ctx, config, getLiveReclaim(), getDiagnosticCounts?.());
          });
          break;
        }

        // ── /pruner on | off ──
        case "on":
        case "off": {
          const enabled = subcommand === "on";
          currentConfig.value = { ...currentConfig.value, enabled };
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          ctx.ui.notify(`Context pruning ${enabled ? "enabled" : "disabled"}.`);
          setPruneStatusWidget(ctx, currentConfig.value, getLiveReclaim(), getDiagnosticCounts?.());
          break;
        }

        // ── /pruner status ──
        case "status": {
          const cfg = currentConfig.value;
          const mode = optionLabel("pruneOn", cfg.pruneOn);
          const s = getStats();
          const statsLine = s.callCount > 0
            ? `\n  --- summarizer ---\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}`
            : "\n  (no summarizer calls yet)";
          const fmtTimeout = (ms: number) => (ms === 0 ? "disabled" : `${Math.round(ms / 1000)}s`);
          const m = getContextMetrics?.(ctx);
          const contextLine = m
            ? `\n  --- context ---\n  thinking:     ${formatTokens(m.openCycleThinkingTokens)} tokens (open segment)\n  chain share:  ${m.largestChainSharePct}%\n  frontier gap: ${formatTokens(m.frontierGapTokens)} tokens${getRearmed?.() ? "\n  rearmed:      yes" : ""}`
            : "";
          ctx.ui.notify(
            `pruner status:\n  enabled:  ${cfg.enabled}\n  model:    ${cfg.summarizerModel}\n  thinking: ${optionLabel("summarizerThinking", cfg.summarizerThinking)} (${cfg.summarizerThinking})\n  idle to:  ${fmtTimeout(cfg.summarizerIdleTimeoutMs)}\n  max to:   ${fmtTimeout(cfg.summarizerMaxTimeoutMs)}\n  trigger:  ${mode}\n  batching: ${optionLabel("batchingMode", cfg.batchingMode)} (${cfg.batchingMode})\n  dedup:    ${cfg.dedupByContentHash ? "on" : "off"}\n  status:   ${cfg.showPruneStatusLine ? "on" : "off"}${statsLine}${contextLine}`,
          );
          break;
        }

        // ── /pruner tree ── foldable tree browser ──
        case "tree": {
          const roots = buildPruneTree(ctx, indexer);
          if (roots.length === 0) {
            ctx.ui.notify("No pruned tool calls found in this session.", "info");
            break;
          }

          await ctx.ui.custom(
            (_tui, theme, _keybindings, done) => {
              const browser = new TreeBrowser(roots, theme, () => done(undefined));
              return browser;
            },
            {
              overlay: true,
              overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" },
            },
          );
          break;
        }

        // ── /pruner stats ──
        case "stats": {
          const s = getStats();
          if (s.callCount === 0 && s.chainsCompressed === 0) {
            ctx.ui.notify("pruner stats: no summarizer calls yet.");
          } else {
            const chainsLine = s.chainsCompressed > 0 ? `\n  chains:      ${s.chainsCompressed} compressed` : "";
            ctx.ui.notify(
              `pruner stats:\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}${chainsLine}`,
            );
          }
          break;
        }

        // ── /pruner model [value] ──
        case "model": {
          const modelArg = subArgs[0];
          if (!modelArg) {
            ctx.ui.notify(
              `Current summarizer model: ${currentConfig.value.summarizerModel}\nCurrent summarizer thinking: ${optionLabel("summarizerThinking", currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`,
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

        // ── /pruner thinking [value] ──
        case "thinking": {
          const thinkingArg = subArgs[0];
          const thinkingField = scalarRow("summarizerThinking");
          if (!thinkingArg) {
            ctx.ui.notify(
              `Current summarizer thinking: ${optionLabel("summarizerThinking", currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`,
            );
            return;
          }
          const parsedThinking = parseScalar(thinkingField, thinkingArg);
          if (parsedThinking === undefined) {
            ctx.ui.notify(
              `Invalid summarizer thinking level: ${thinkingArg}. Use one of: ${optionValues(thinkingField).join(", ")}.`,
              "warning",
            );
            return;
          }
          currentConfig.value = writeScalar(currentConfig.value, thinkingField, parsedThinking);
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          ctx.ui.notify(`Summarizer thinking set to: ${currentConfig.value.summarizerThinking}`);
          break;
        }

        // ── /pruner prune-on [value] ──
        case "prune-on": {
          const modeArg = subArgs[0];
          const pruneOnField = scalarRow("pruneOn");
          if (!modeArg) {
            const options = pruneOnField.options.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("pruner — choose when to trigger summarization", options);
            if (!choice) return;
            // Extract the value (first word) from "agent-message — On agent message"
            currentConfig.value = writeScalar(currentConfig.value, pruneOnField, choice.split(/\s+/)[0]);
          } else {
            currentConfig.value = writeScalar(currentConfig.value, pruneOnField, modeArg);
          }
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          setPruneStatusWidget(ctx, currentConfig.value, getLiveReclaim(), getDiagnosticCounts?.());
          break;
        }

        // ── /pruner batching [value] ──
        case "batching": {
          const batchArg = subArgs[0];
          const batchingField = scalarRow("batchingMode");
          if (!batchArg) {
            const options = batchingField.options.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("pruner — choose batching granularity", options);
            if (!choice) return;
            currentConfig.value = writeScalar(currentConfig.value, batchingField, choice.split(/\s+/)[0]);
          } else {
            const parsedBatch = parseScalar(batchingField, batchArg);
            if (parsedBatch === undefined) {
              ctx.ui.notify(
                `Invalid batching mode: ${batchArg}. Use one of: ${optionValues(batchingField).join(", ")}.`,
                "warning",
              );
              return;
            }
            currentConfig.value = writeScalar(currentConfig.value, batchingField, parsedBatch);
          }
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          ctx.ui.notify(`Batching mode set to: ${optionLabel("batchingMode", currentConfig.value.batchingMode)}`);
          break;
        }

        // ── /pruner compact ──
        // Runs regardless of chainCompression.enabled — that flag gates automatic compression;
        // the user invoking /pruner compact is explicit intent.
        case "compact": {
          try {
            const { compressedEntries, skipped } = await compactChains(ctx);
            if (compressedEntries.length === 0) {
              ctx.ui.notify(
                skipped > 0
                  ? `pruner: no chains eligible for compaction (${skipped} skipped — no per-batch summary available)`
                  : "pruner: no chains eligible for compaction",
                "info",
              );
              break;
            }
            // Coarse estimate: uses original (unstubbed) toolResult sizes which overstates
            // tool-result savings; but assistant-message savings (thinking + toolCall args + text)
            // are not counted at all, so the two errors partly cancel. Treat as a rough proxy.
            const droppedChars = compressedEntries.reduce((total, entry) => {
              const records = indexer.lookupToolCalls(entry.droppedOccurrenceKeys ?? entry.droppedToolCallIds);
              return total + records.reduce((s, r) => s + r.resultText.length, 0);
            }, 0);
            const reclaimedTokens = Math.ceil(droppedChars / 4);
            const ids = compressedEntries.map((e) => e.blockId).join(", ");
            ctx.ui.notify(
              `pruner: compacted ${compressedEntries.length} chain${compressedEntries.length === 1 ? "" : "s"} (${ids}), reclaimed ~${reclaimedTokens} tokens`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(`pruner: compact failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
          }
          break;
        }

        // ── /pruner now ──
        case "now": {
          if (!currentConfig.value.enabled) {
            ctx.ui.notify("Context pruning is disabled. Run /pruner on first.", "warning");
            return;
          }

          // Capture the pending queue first so we can pre-build the widget rows.
          const batches = capturePendingBatches(ctx);
          if (batches.length === 0) {
            ctx.ui.notify("pruner: nothing pending — no batches to summarize", "info");
            // Still invoke flushPending so its finally-emitted flush-metrics entry
            // records this attempt (outcome "empty") — the incident's exact
            // undiagnosable "nothing pending" report is precisely what this log
            // exists to make diagnosable on recurrence.
            await flushPending(ctx, { previewedBatches: batches, trigger: "manual" });
            break;
          }

          // Open the progress widget above the editor — one row per batch.
          const { updateRow, clearWidget } = startPrunerWidget(ctx, batches);

          const result = await flushPending(ctx, {
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

          // Remove the widget and restore the normal footer status.
          clearWidget();
          setPruneStatusWidget(ctx, currentConfig.value, getLiveReclaim(), getDiagnosticCounts?.());

          if (!result.ok) {
            if (result.reason === "delivery-pending") {
              ctx.ui.notify("pruner: summary queued — raw results retained until delivery", "info");
              break;
            }
            const suffix = "error" in result && result.error ? ` (${result.error})` : "";
            ctx.ui.notify(`pruner: nothing flushed — ${result.reason}${suffix}`, result.reason === "empty" ? "info" : "warning");
            break;
          }

          if (result.reason === "skipped-oversized") {
            ctx.ui.notify(
              `pruner: skipped pruning ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} — summary was ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars; frontier advanced past this range`,
              "warning"
            );
            break;
          }

          if (result.reason === "skipped-trivial") {
            ctx.ui.notify(
              `pruner: skipped ${result.toolCallCount} trivial tool call${result.toolCallCount === 1 ? "" : "s"} — only ${result.rawCharCount} raw chars below minBatchChars=${currentConfig.value.minBatchChars}; no LLM call made; frontier advanced past this range`,
              "info"
            );
            break;
          }

          if (result.reason === "skipped-deduped") {
            const n = result.dedupedCount ?? result.toolCallCount;
            ctx.ui.notify(
              `pruner: deduplicated ${n} tool call${n === 1 ? "" : "s"} (${result.rawCharCount} raw chars) against earlier prunes; no LLM call made; frontier advanced past this range`,
              "info"
            );
            break;
          }

          ctx.ui.notify(
            `pruner: pruned ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"} — summary ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars`,
            "info"
          );
          break;
        }

        // ── /pruner protected-tools [list] ──
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

        // ── /pruner min-batch-chars [value] ──
        // Bare form shows the current value. Numeric form sets it directly
        // (any non-negative integer accepted; not restricted to the preset
        // cycle exposed in the SettingsList). `0` disables the pre-flush
        // guard.
        case "min-batch-chars": {
          const arg = subArgs[0];
          const minBatchField = scalarRow("minBatchChars");
          if (!arg) {
            const cur = currentConfig.value.minBatchChars;
            const state = cur === 0 ? "disabled" : `${cur} chars`;
            ctx.ui.notify(`Current minBatchChars: ${state}.`);
            break;
          }
          const parsed = parseScalar(minBatchField, arg);
          if (parsed === undefined) {
            ctx.ui.notify(`Invalid minBatchChars: "${arg}". Expected a non-negative integer (0 disables).`, "warning");
            break;
          }
          currentConfig.value = writeScalar(currentConfig.value, minBatchField, parsed);
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          ctx.ui.notify(
            parsed === 0
              ? "minBatchChars set to 0 — pre-flush trivial-batch skipping disabled."
              : `minBatchChars set to ${parsed}.`,
          );
          break;
        }

        case "recovery-grace": {
          const arg = subArgs[0];
          const graceField = scalarRow("recoveryGraceTurns");
          if (!arg) {
            const cur = currentConfig.value.recoveryGraceTurns;
            const state = cur === 0 ? "disabled" : `${cur} user-turn-group(s)`;
            ctx.ui.notify(`Current recovery grace: ${state}.`);
            break;
          }
          const parsed = parseScalar(graceField, arg);
          if (parsed === undefined) {
            ctx.ui.notify(`Invalid recovery-grace: "${arg}". Expected a non-negative integer (0 disables).`, "warning");
            break;
          }
          currentConfig.value = writeScalar(currentConfig.value, graceField, parsed);
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          ctx.ui.notify(
            parsed === 0
              ? "recovery-grace set to 0 - context_tree_query output stubs immediately."
              : `recovery-grace set to ${parsed} user-turn-group(s).`,
          );
          break;
        }

        // ── /pruner dedup [on|off|status] ──
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
          currentConfig.value = writeScalar(currentConfig.value, dedupField, next);
          void persistConfig((m, t) => ctx.ui.notify(m, t), currentConfig.value, save);
          ctx.ui.notify(`Content-hash dedup turned ${next ? "ON" : "OFF"}.`);
          break;
        }

        // ── /pruner help ──
        case "help":
          ctx.ui.notify(HELP_TEXT);
          break;

        // ── Unknown subcommand ──
        default:
          ctx.ui.notify(
            `Unknown subcommand: "${subcommand}". Run /pruner help for usage.`,
          );
      }
    },
  });

  // Register custom renderer for context-prune-summary messages
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
