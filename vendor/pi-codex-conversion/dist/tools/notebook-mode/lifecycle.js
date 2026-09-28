import { randomUUID } from "node:crypto";
import { globMatcher } from "./glob.js";
import { promoteProjectStateBindings, projectStateBindingSelection, syncProjectStateBindings, } from "./project-state.js";
import { boundedReleaseDetails, formatNameList, formatRelease, formatStatus, NOTEBOOK_DETAILS_BUDGET, remainingDetailsBudget, takeDetailValues, withinNameBudget, } from "./lifecycle-result.js";
import { notebookDisposeSource, notebookReleaseSource, notebookStatusSource, parseNotebookRuntimeResult, } from "./lifecycle-runtime.js";
import { listProfiles, loadProfile, saveProfile } from "./profile-lifecycle.js";
import { diagnosticsNotebook, resetNotebook } from "./recovery.js";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STATUS_TIMEOUT_MS = 8_000;
/** All notebook lifecycle actions over the session owner's narrow operation view. */
export async function runNotebookControl(host, request, context, signal) {
    if (request.action === "list")
        return listProfiles(host, request.query);
    if (request.action === "diagnostics")
        return diagnosticsNotebook(host, context, signal);
    if (request.action === "reset")
        return resetNotebook(host, context, signal);
    if (request.action === "restart" && host.runtimeHealth().state !== "ready")
        return restart(host, context, signal);
    await host.prepare(context, signal);
    switch (request.action) {
        case "status": return status(host, request.query, signal);
        case "checkpoint":
            await host.checkpoint();
            return { message: "Notebook checkpoint complete", details: host.metadata().checkpoint };
        case "save": return saveProfile(host, request.name, context, signal);
        case "load": return loadProfile(host, request.name, context, signal);
        case "pin": return pin(host, request.names, true);
        case "unpin": return pin(host, request.names, false);
        case "release": return release(host, request.names, context, signal);
        case "prune": return prune(host, request.query, context, signal);
        case "restart": return restart(host, context, signal);
    }
}
export async function disposeNotebookBindings(host, signal) {
    const kernel = host.kernel();
    if (!kernel || host.activeCellId())
        return undefined;
    const names = await userBindingNames(host, kernel, signal);
    if (names.length === 0)
        return { released: [], disposed: [], failures: [] };
    const marker = lifecycleMarker();
    return parseNotebookRuntimeResult(await kernel.execute(notebookDisposeSource(names, marker), { signal }), marker);
}
async function status(host, query, signal) {
    const kernel = host.kernel();
    const activeCell = host.activeCellId();
    const statusSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)])
        : AbortSignal.timeout(STATUS_TIMEOUT_MS);
    const allNames = activeCell ? [] : await userBindingNames(host, kernel, statusSignal);
    const matches = query === undefined ? [] : allNames.filter(globMatcher(query));
    const selected = withinNameBudget(matches);
    const retained = host.retainedBindings();
    const retainedByName = new Map(retained.map((binding) => [binding.name, binding]));
    let runtime;
    if (!activeCell) {
        const marker = lifecycleMarker();
        runtime = parseNotebookRuntimeResult(await kernel.execute(notebookStatusSource(selected, marker), { signal: statusSignal }), marker);
    }
    const metadata = host.metadata();
    const inspectedMatches = (runtime?.bindings ?? []).map((binding) => {
        const retainedBinding = retainedByName.get(binding.name);
        return {
            ...binding,
            ...(retainedBinding ? {
                bytes: retainedBinding.bytes,
                updatedAt: retainedBinding.updatedAt,
                pinned: retainedBinding.pinned,
                ...(retainedBinding.description === undefined ? {} : { description: retainedBinding.description }),
                ...(retainedBinding.usage === undefined ? {} : { usage: retainedBinding.usage }),
            } : {}),
        };
    });
    const pinned = retained.filter((binding) => binding.pinned);
    const unpinned = retained
        .filter(({ pinned }) => !pinned)
        .sort((left, right) => right.bytes - left.bytes);
    const largestUnpinned = unpinned.slice(0, 8);
    const baseDetails = {
        state: activeCell ? "running" : "idle",
        ...(activeCell ? { activeCell } : {}),
        userBindings: activeCell ? undefined : allNames.length,
        userCells: metadata.userCells,
        ...(metadata.startedAt ? { startedAt: new Date(metadata.startedAt).toISOString() } : {}),
        memory: runtime?.memory ?? metadata.memory,
        checkpoint: metadata.checkpoint,
        retainedBindings: retained.length,
        retainedBytes: retained.reduce((total, binding) => total + binding.bytes, 0),
        pinnedBindings: pinned.length,
        pinned: [],
        omittedPinned: pinned.length,
        largestUnpinned: [],
        omittedLargestUnpinned: unpinned.length,
        ...(query === undefined ? {} : {
            query,
            matches: [],
            omittedMatches: matches.length,
        }),
    };
    const detailBudget = remainingDetailsBudget(baseDetails);
    const reportedMatches = takeDetailValues(inspectedMatches, detailBudget);
    const reportedPinned = takeDetailValues(pinned, detailBudget);
    const reportedLargestUnpinned = takeDetailValues(largestUnpinned, detailBudget);
    const details = {
        ...baseDetails,
        pinned: reportedPinned,
        omittedPinned: pinned.length - reportedPinned.length,
        largestUnpinned: reportedLargestUnpinned,
        omittedLargestUnpinned: unpinned.length - reportedLargestUnpinned.length,
        ...(query === undefined ? {} : {
            matches: reportedMatches,
            omittedMatches: Math.max(0, matches.length - reportedMatches.length),
        }),
    };
    return { message: formatStatus(details), details };
}
async function pin(host, names, pinned) {
    const activeCell = host.activeCellId();
    if (activeCell)
        throw new Error(`Cannot change notebook pins while exec cell "${activeCell}" is running`);
    let rollbackPromotion;
    if (pinned) {
        const kernel = host.kernel();
        const available = new Set(await userBindingNames(host, kernel));
        const invalid = names.filter((name) => !IDENTIFIER.test(name) || !available.has(name));
        if (invalid.length > 0)
            throw new Error(`Notebook bindings not found or not pinnable: ${invalid.join(", ")}`);
        rollbackPromotion = await promoteBindings(kernel, names);
    }
    try {
        await host.checkpoint(undefined, { names, pinned });
    }
    catch (error) {
        await rollbackPromotion?.().catch(() => undefined);
        throw error;
    }
    const retained = host.retainedBindings();
    const reportedNames = withinNameBudget(names);
    const selected = retained.filter((binding) => reportedNames.includes(binding.name));
    const bindings = takeDetailValues(selected, { remaining: NOTEBOOK_DETAILS_BUDGET });
    return {
        message: `${pinned ? "Pinned" : "Unpinned"} durable notebook bindings: ${formatNameList(names)}`,
        details: { pinned, bindings, bindingCount: names.length, omittedBindings: names.length - bindings.length },
    };
}
async function release(host, names, context, signal, preservedNames = []) {
    const activeCell = host.activeCellId();
    if (activeCell)
        throw new Error(`Cannot release notebook state while exec cell "${activeCell}" is running; terminate or restart it first`);
    const kernel = host.kernel();
    const available = new Set(await userBindingNames(host, kernel));
    const invalid = names.filter((name) => !IDENTIFIER.test(name) || !available.has(name));
    if (invalid.length > 0)
        throw new Error(`Notebook bindings not found or not releasable: ${invalid.join(", ")}`);
    const pinned = new Set(host.retainedBindings().filter((binding) => binding.pinned).map(({ name }) => name));
    const protectedNames = names.filter((name) => pinned.has(name));
    if (protectedNames.length > 0)
        throw new Error(`Pinned notebook bindings cannot be released: ${formatNameList(protectedNames)}; unpin them first`);
    const statusMarker = lifecycleMarker();
    const releaseStatus = parseNotebookRuntimeResult(await kernel.execute(notebookStatusSource(names, statusMarker), { signal }), statusMarker);
    const restartRequired = releaseStatus.bindings.some(({ globalProperty }) => !globalProperty);
    let result;
    if (restartRequired) {
        host.markChanged();
        await host.checkpoint(new Set(names));
        const disposal = await disposeNotebookBindings(host, signal);
        const extension = context.extensionContext;
        if (!extension)
            throw new Error("Notebook release requires an extension session context");
        await host.restart(extension, signal);
        result = {
            released: [...names],
            disposed: disposal?.disposed ?? [],
            failures: disposal?.failures ?? [],
        };
    }
    else {
        const marker = lifecycleMarker();
        result = parseNotebookRuntimeResult(await kernel.execute(notebookReleaseSource(names, marker), { signal }), marker);
        if (result.released.length > 0) {
            host.markChanged();
            await host.checkpoint(new Set(result.released));
        }
    }
    const remaining = new Set(await userBindingNames(host, host.kernel()));
    for (const name of [...result.released]) {
        if (!remaining.has(name))
            continue;
        result.released.splice(result.released.indexOf(name), 1);
        result.failures.push({ name, reason: "concurrent project state retained this binding" });
    }
    const details = boundedReleaseDetails(result, preservedNames, restartRequired, host.metadata().checkpoint);
    return { message: formatRelease(result, restartRequired), details };
}
async function prune(host, query, context, signal) {
    const kernel = host.kernel();
    const matches = (await userBindingNames(host, kernel)).filter(globMatcher(query));
    const pinned = new Set(host.retainedBindings().filter((binding) => binding.pinned).map(({ name }) => name));
    const protectedNames = matches.filter((name) => pinned.has(name));
    const names = matches.filter((name) => !pinned.has(name));
    if (names.length === 0) {
        const details = boundedReleaseDetails({ released: [], disposed: [], failures: [] }, protectedNames, false, host.metadata().checkpoint);
        return {
            message: `No unpinned notebook bindings matched ${JSON.stringify(query)}${protectedNames.length > 0 ? `; protected: ${formatNameList(protectedNames)}` : ""}`,
            details: { ...details, query },
        };
    }
    const released = await release(host, names, context, signal, protectedNames);
    return {
        message: `${released.message}${protectedNames.length > 0 ? `\nPinned matches preserved: ${formatNameList(protectedNames)}` : ""}`,
        details: { ...released.details, query },
    };
}
async function restart(host, context, signal) {
    const activeCell = await host.stopActive();
    let checkpointNotice;
    if (!activeCell && host.runtimeHealth().state === "ready") {
        try {
            await host.checkpoint();
        }
        catch (error) {
            if (host.runtimeHealth().state !== "invalidated")
                throw error;
            checkpointNotice = `Checkpoint skipped after runtime invalidation: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    const disposal = await disposeNotebookBindings(host, signal).catch((error) => ({
        released: [],
        disposed: [],
        failures: [{ name: "notebook", reason: error instanceof Error ? error.message : String(error) }],
    }));
    const extension = context.extensionContext;
    if (!extension)
        throw new Error("Notebook restart requires an extension session context");
    const restoreNotice = await host.restart(extension, signal);
    const details = {
        ...(activeCell ? { terminatedCell: activeCell } : {}),
        disposed: disposal?.disposed ?? [],
        disposalFailures: disposal?.failures ?? [],
        ...(restoreNotice ? { restoreNotice } : {}),
    };
    return {
        message: [
            `Notebook kernel restarted from the last completed checkpoint${activeCell ? `; terminated ${activeCell}` : ""}`,
            disposal && disposal.failures.length > 0 ? `${disposal.failures.length} resource cleanup failure${disposal.failures.length === 1 ? "" : "s"}; restart continued` : undefined,
            checkpointNotice,
            restoreNotice,
        ].filter(Boolean).join(". "),
        details,
    };
}
async function userBindingNames(host, kernel, signal) {
    const baseline = host.baselineNames();
    return [...new Set(await kernel.complete("", 0, signal))]
        .filter((name) => IDENTIFIER.test(name) && !baseline.has(name))
        .sort();
}
/** Promote pinned bindings into project state, returning the rollback that restores
 * the previous selection (the caller runs it when the pinned checkpoint fails). */
async function promoteBindings(kernel, names) {
    const previous = await projectStateBindingSelection(kernel);
    try {
        await promoteProjectStateBindings(kernel, names);
    }
    catch (error) {
        await syncProjectStateBindings(kernel, previous).catch(() => undefined);
        throw error;
    }
    return () => syncProjectStateBindings(kernel, previous);
}
function lifecycleMarker() {
    return `__PI_NOTEBOOK_LIFECYCLE_${randomUUID()}__`;
}
