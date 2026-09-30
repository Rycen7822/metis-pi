import { fusionReceipt } from "./execution/action-fusion.ts";
import { asRecord, type Component, type Renderers, type ViewContext } from "./tool-names.ts";
import { productFor, publishRows, registerProduct, type CopyRow } from "./selection-copy/model.ts";

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

function stack(components: Component[]): Component {
  return { render(width) {
    const lines: string[] = [], rows: CopyRow[] = [];
    for (const component of components) {
      const rendered = component.render(width);
      lines.push(...rendered);
      rows.push(...(productFor(rendered)?.rows ?? rendered.map(() => ({ spans: [{ colStart: 0, colEnd: width, kind: "unknown" as const }], breakBefore: "hard" as const }))));
    }
    registerProduct(lines, { componentId: "action-fusion", width, rows });
    publishRows(this, lines);
    return lines;
  } };
}

/** Reuse existing mutation and shell components for both folding and copying. */
export function fusionRenderers(mutation: Renderers, shell: Renderers, currentResult: () => unknown): Renderers {
  return {
    renderCall(args, theme, ctx) {
      return mutation.renderCall(args, theme, mutationViewContext(currentResult(), ctx));
    },
    renderResult(result, options, theme, ctx) {
      const value = asRecord(result), receipt = fusionReceipt(value.details);
      const mutationCtx = mutationViewContext(result, ctx);
      if (!receipt || !Array.isArray(value.content)) return mutation.renderResult(result, options, theme, mutationCtx);
      const { metisActionFusion: _receipt, ...mutationDetails } = asRecord(value.details);
      const mutationResult = { ...value, details: mutationDetails, isError: receipt.mutationStatus !== "success", content: value.content.slice(0, receipt.command.outputBlock - 1) };
      const running = receipt.command.status === "running";
      const failed = !["running", "succeeded"].includes(receipt.command.status);
      const shellCtx = { ...ctx, args: { command: receipt.command.command }, isError: failed, isPartial: running, hasResult: !running, lastComponent: undefined };
      const commandResult = { content: value.content.slice(receipt.command.outputBlock - 1), isError: failed };
      return stack([
        mutation.renderResult(mutationResult, { ...options, isPartial: false }, theme, mutationCtx),
        shell.renderCall(shellCtx.args, theme, shellCtx),
        shell.renderResult(commandResult, { ...options, isPartial: running }, theme, shellCtx),
      ]);
    },
  };
}
