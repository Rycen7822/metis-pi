import { matchesKey } from "@earendil-works/pi-tui";
import { CODEX_RESERVE_USAGE_NOTE, codexUsageLimitName } from "../../codex-usage/format.js";
import { consumeCodexRateLimitResetCredit, createCodexRateLimitResetRedeemRequestId, fetchCodexUsage, } from "../../codex-usage/client.js";
export function createUsageTab(ctx, options, requestRender) {
    let usageState = options.initialUsage;
    let usageLoading = false;
    let resetLoading = false;
    let resetLockedUntilRefresh = false;
    let resetRedeemRequestId;
    let resetMessage;
    const load = (unlockReset = false) => {
        if (usageLoading)
            return;
        usageLoading = true;
        requestRender();
        (options.onRefreshUsage ?? (() => fetchCodexUsage(ctx)))()
            .then((usage) => {
            usageState = usage;
            if (unlockReset) {
                resetLockedUntilRefresh = false;
                resetRedeemRequestId = undefined;
                resetMessage = undefined;
            }
        })
            .catch((error) => { usageState = { error: error instanceof Error ? error.message : String(error) }; })
            .finally(() => { usageLoading = false; requestRender(); });
    };
    const consumeReset = () => {
        if (resetLoading || usageLoading)
            return;
        if (resetLockedUntilRefresh) {
            resetMessage = { kind: "info", text: "Press R to refresh before using another reset." };
            requestRender();
            return;
        }
        if (!canConsumeResetCredit(usageState))
            return;
        resetLoading = true;
        resetMessage = undefined;
        resetRedeemRequestId ??= createCodexRateLimitResetRedeemRequestId();
        const redeemRequestId = resetRedeemRequestId;
        requestRender();
        (options.onConsumeResetCredit ?? ((id) => consumeCodexRateLimitResetCredit(ctx, id)))(redeemRequestId)
            .then((result) => {
            resetMessage = { kind: result.outcome === "reset" || result.outcome === "already_redeemed" ? "info" : "error", text: formatResetConsumeResult(result) };
            resetLockedUntilRefresh = true;
            resetRedeemRequestId = undefined;
            usageState = undefined;
            load();
        })
            .catch((error) => { resetMessage = { kind: "error", text: `${error instanceof Error ? error.message : String(error)} Press Ctrl+R to retry the same reset request, or R to refresh.` }; })
            .finally(() => { resetLoading = false; requestRender(); });
    };
    return {
        ensureLoaded() {
            if (!usageState)
                load();
        },
        handleInput(data) {
            if (data.toLowerCase() === "r") {
                if (!resetLoading)
                    load(true);
                return true;
            }
            if (matchesKey(data, "ctrl+r")) {
                consumeReset();
                return true;
            }
            return false;
        },
        render(theme) {
            return formatUsageLines(theme, usageState, usageLoading, resetLoading, resetLockedUntilRefresh, resetMessage);
        },
    };
}
function formatUsageLines(theme, usageState, loading, resetLoading, resetLockedUntilRefresh, resetMessage) {
    if (!usageState)
        return [theme.fg("dim", "  Loading Codex usage…")];
    if ("error" in usageState)
        return [theme.fg("error", `  ${usageState.error}`), theme.fg("dim", "  Press R to retry.")];
    const rows = usageState.limits.map((limit) => {
        const primary = usageColumns(limit.primary);
        const secondary = usageColumns(limit.secondary);
        return [codexUsageLimitName(limit), primary.bar, primary.percent, primary.reset, secondary.bar, secondary.percent, secondary.reset];
    });
    const headers = ["Limit", "5h left", "", "Reset", "Weekly left", "", "Reset"];
    const widths = columnWidths([headers, ...rows]);
    return [
        `  ${theme.bold(`Codex usage${usageState.planType ? ` · ${usageState.planType}` : ""}`)}${loading ? theme.fg("dim", "  refreshing…") : ""}`,
        ...formatResetCreditLines(theme, usageState, resetLoading, resetLockedUntilRefresh, resetMessage),
        "",
        formatUsageRow(headers.map((header) => theme.fg("dim", header)), widths),
        theme.fg("borderMuted", `  ${"─".repeat(widths.reduce((sum, width) => sum + width, 0) + (2 * (widths.length - 1)))}`),
        ...rows.map((row) => formatUsageRow(row, widths)),
        ...(usageState.limits.some((limit) => codexUsageLimitName(limit) === "Luna Reserve") ? ["", theme.fg("dim", `  ${CODEX_RESERVE_USAGE_NOTE}`)] : []),
    ];
}
function canConsumeResetCredit(usageState) {
    return Boolean(usageState && !("error" in usageState) && (usageState.resetCredits?.availableCount ?? 0) > 0);
}
function formatResetCreditLines(theme, usageState, resetLoading, resetLockedUntilRefresh, resetMessage) {
    const count = usageState.resetCredits?.availableCount;
    const hint = count && count > 0 ? theme.fg("dim", resetLockedUntilRefresh ? "  R to refresh before another reset" : "  Ctrl+R to use one") : "";
    const lines = [`  Banked resets: ${theme.bold(count === undefined ? "unknown" : String(count))}${hint}${resetLoading ? theme.fg("dim", "  resetting…") : ""}`];
    if (count && count > 0)
        lines.push(theme.fg("dim", `  Expires: ${formatResetCreditExpiries(usageState.resetCredits?.credits ?? [])}`));
    if (resetMessage)
        lines.push(resetMessage.kind === "error" ? theme.fg("error", `  ${resetMessage.text}`) : theme.fg("accent", `  ${resetMessage.text}`));
    return lines;
}
function formatResetCreditExpiries(credits) {
    const expiringCredits = credits
        .map((credit) => ({ credit, expiresAtMs: credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN }))
        .filter((item) => Number.isFinite(item.expiresAtMs) && (!item.credit.status || item.credit.status === "available"))
        .sort((left, right) => left.expiresAtMs - right.expiresAtMs);
    if (expiringCredits.length === 0)
        return "unknown";
    const shown = expiringCredits.slice(0, 3).map((item, index) => `#${index + 1} ${formatResetCreditExpiry(item.expiresAtMs)}`);
    const hiddenCount = expiringCredits.length - shown.length;
    return `${shown.join(" · ")}${hiddenCount > 0 ? ` · +${hiddenCount} more` : ""}`;
}
function formatResetCreditExpiry(expiresAtMs) {
    const minutes = Math.round((expiresAtMs - Date.now()) / 60000);
    if (minutes <= 0)
        return "expired";
    if (minutes < 90)
        return `in ~${minutes}m`;
    if (minutes < 60 * 48)
        return `in ~${Math.round(minutes / 60)}h`;
    return `in ~${Math.round(minutes / 1440)}d`;
}
function formatResetConsumeResult(result) {
    if (result.outcome === "reset")
        return "Codex rate limits reset.";
    if (result.outcome === "already_redeemed")
        return "Reset already applied; refreshed usage.";
    if (result.outcome === "nothing_to_reset")
        return "No active Codex limit to reset.";
    if (result.outcome === "no_credit")
        return "No banked resets available.";
    return "Reset response was not recognized; refreshed usage.";
}
function columnWidths(rows) {
    const columnCount = Math.max(...rows.map((row) => row.length));
    return Array.from({ length: columnCount }, (_, index) => Math.max(...rows.map((row) => stripAnsi(row[index] ?? "").length)));
}
function stripAnsi(value) { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function padCell(value, width) { return value + " ".repeat(Math.max(0, width - stripAnsi(value).length)); }
function formatUsageRow(row, widths) { return `  ${row.map((cell, index) => padCell(cell, widths[index] ?? 0)).join("  ")}`; }
function usageColumns(window) {
    if (!window)
        return { bar: "", percent: "", reset: "" };
    const percent = window.usedPercent === undefined ? undefined : 100 - Math.max(0, Math.min(100, window.usedPercent));
    return { bar: usageBar(percent), percent: percent === undefined ? "?%" : `${Math.round(percent)}%`, reset: formatResetShort(window.resetsAt) };
}
function usageBar(percent) {
    if (percent === undefined)
        return "░░░░░░░░░░";
    const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
    return "█".repeat(filled) + "░".repeat(10 - filled);
}
function formatResetShort(timestampSeconds) {
    if (!timestampSeconds)
        return "reset ?";
    const minutes = Math.max(0, Math.round((timestampSeconds * 1000 - Date.now()) / 60000));
    if (minutes < 90)
        return `~${minutes}m`;
    if (minutes < 60 * 48)
        return `~${Math.round(minutes / 60)}h`;
    return `~${Math.round(minutes / 1440)}d`;
}
