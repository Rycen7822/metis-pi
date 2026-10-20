import { fusionReceipt } from "./execution/action-fusion.ts";
import { asRecord, type Renderers, type ViewContext } from "./tool-names.ts";
import { stackComponents } from "./copy-stack.ts";

/** Use the mutation's immutable evidence, never the outer command's exit status. */
export function mutationViewContext(result: unknown, ctx: ViewContext): ViewContext {
  const details = asRecord(asRecord(result).details);
  const receipt = fusionReceipt(details);
  return {
    ...ctx,
    ...(details.metisWriteDiff ? { writeChanges: details.metisWriteDiff } : {}),
    ...(receipt ? { isError: receipt.mutationStatus !== "success", isPartial: false, hasResult: true } : {}),
  };
}

// Only call rendering reads the live receipt lookup. A result renderer belongs
// to the stable family, so refreshes do not defeat the adapter's identity guard.
const resultRenderers = new WeakMap<Renderers, {
  shell: Renderers; mutationResult: Renderers["renderResult"];
  shellCall: Renderers["renderCall"]; shellResult: Renderers["renderResult"];
  render: Renderers["renderResult"];
}>();
function fusionResult(mutation: Renderers, shell: Renderers): Renderers["renderResult"] {
  const previous = resultRenderers.get(mutation);
  if (previous?.shell === shell && previous.mutationResult === mutation.renderResult
      && previous.shellCall === shell.renderCall && previous.shellResult === shell.renderResult)
    return previous.render;
  const render: Renderers["renderResult"] = (result, options, theme, ctx) => {
    const value = asRecord(result), receipt = fusionReceipt(value.details);
    const mutationCtx = mutationViewContext(result, ctx);
    if (!receipt || !Array.isArray(value.content)) return mutation.renderResult(result, options, theme, mutationCtx);
    const { metisActionFusion: _receipt, ...mutationDetails } = asRecord(value.details);
    const mutationResult = {
      ...value,
      details: mutationDetails,
      isError: receipt.mutationStatus !== "success",
      content: value.content.slice(0, receipt.command.outputBlock - 1),
    };
    const running = receipt.command.status === "running";
    const failed = !["running", "succeeded"].includes(receipt.command.status);
    const shellCtx = {
      ...ctx,
      args: { command: receipt.command.command },
      isError: failed,
      isPartial: running,
      hasResult: !running,
      lastComponent: undefined,
    };
    const commandResult = { content: value.content.slice(receipt.command.outputBlock - 1), isError: failed };
    return stackComponents([
      mutation.renderResult(mutationResult, { ...options, isPartial: false }, theme, mutationCtx),
      shell.renderCall(shellCtx.args, theme, shellCtx),
      shell.renderResult(commandResult, { ...options, isPartial: running }, theme, shellCtx),
    ], "flat-rows");
  };
  resultRenderers.set(mutation, {
    shell, mutationResult: mutation.renderResult, shellCall: shell.renderCall, shellResult: shell.renderResult, render,
  });
  return render;
}

/** Reuse existing mutation and shell components for both folding and copying. */
export function fusionRenderers(mutation: Renderers, shell: Renderers, currentResult: () => unknown): Renderers {
  return {
    renderCall(args, theme, ctx) {
      return mutation.renderCall(args, theme, mutationViewContext(currentResult(), ctx));
    },
    renderResult: fusionResult(mutation, shell),
  };
}
