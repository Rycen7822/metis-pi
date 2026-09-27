/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save <agent-dir>/settings.json `contextPrune` namespace (honors PI_CODING_AGENT_DIR)
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<occurrenceKey, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void;
