// Read the conversion layer's pre-execution snapshot; never rebuild a diff from
// files that the tool has already changed. Painting is shared with edit/write.
import { fileURLToPath } from "node:url";
import { getApplyPatchRenderSnapshot } from "../vendor/pi-codex-conversion/dist/tools/apply-patch/render-state.js";
import { formatPatchTarget } from "../vendor/pi-codex-conversion/dist/tools/apply-patch/rendering.js";
import type { AdapterOptions } from "./adapter.ts";
import type { DiffRow } from "./diff.ts";
import { productFor, publishRows, registerProduct, type CopyRow } from "./selection-copy/model.ts";
import { safeText, type Component, type DiffFactory, type TextFactory } from "./tool-names.ts";

export function createOwnedApplyPatchView(makeText: TextFactory, makeDiff: DiffFactory, expandHint: () => string): NonNullable<AdapterOptions["ownedApplyPatch"]> {
  return {
    sourcePath: fileURLToPath(new URL("../vendor/pi-codex-conversion/dist/index.js", import.meta.url)),
    renderCall(_args, theme, context) {
      // Keep the conversion layer's configured compact/summary presentation.
      if (!context.expanded) return;
      const snapshot = context.toolCallId ? getApplyPatchRenderSnapshot(context.toolCallId) : undefined;
      // Streaming, replay without a snapshot, and failures keep the native
      // diagnostic renderer. In particular, never present failed edits as done.
      if (!snapshot || snapshot.status !== "pending" || context.isError || !snapshot.files.length) return;
      const files = snapshot.files;
      const added = files.reduce((sum, file) => sum + file.added, 0);
      const removed = files.reduce((sum, file) => sum + file.removed, 0);
      const counts = (a: number, r: number) => `(${theme.fg("toolDiffAdded", `+${a}`)} ${theme.fg("toolDiffRemoved", `-${r}`)})`;
      const target = (file: typeof files[number]) => safeText(formatPatchTarget(file.path, file.movePath, context.cwd ?? process.cwd()));
      const title = files.length === 1 ? `${files[0]!.verb} ${target(files[0]!)}` : `Edited ${files.length} files`;
      const components: Component[] = [makeText(`${theme.fg("dim", "•")} ${theme.bold(title)} ${counts(added, removed)}`)];
      for (const file of files) {
        if (files.length > 1) components.push(makeText(`  └ ${target(file)} ${counts(file.added, file.removed)}`));
        const rows: DiffRow[] = file.lines.map((line) => ({
          kind: line.marker === "+" ? "add" : line.marker === "-" ? "remove" : "context",
          lineNumber: line.lineNumber,
          content: safeText(line.text),
        }));
        if (rows.length) components.push(makeDiff({ rows, filePath: file.movePath ?? file.path, theme, context,
          options: { expanded: context.expanded === true }, expandHint: expandHint() }));
      }
      return {
        render(width) {
          const lines: string[] = [];
          const copyRows: CopyRow[] = [];
          for (const component of components) {
            const childLines = component.render(width);
            const product = productFor(childLines);
            lines.push(...childLines);
            copyRows.push(...(product?.rows ?? childLines.map(() => ({
              spans: [{ colStart: 0, colEnd: width, kind: "unknown" as const }], breakBefore: "hard" as const,
            }))));
          }
          registerProduct(lines, { componentId: "apply-patch", width, rows: copyRows });
          publishRows(this, lines);
          return lines;
        },
      };
    },
  };
}
