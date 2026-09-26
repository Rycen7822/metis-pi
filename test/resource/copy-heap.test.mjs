import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("retained text spans do not keep per-grapheme string ropes", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "-e", String.raw`
    import assert from "node:assert/strict";
    import * as Tui from "@earendil-works/pi-tui";
    import { createSelectionCopySystem } from "./src/selection-copy/index.ts";
    import { productFor } from "./src/selection-copy/model.ts";
    createSelectionCopySystem({
      prototypes: Object.fromEntries(["Text", "Markdown", "Box", "Container"].map((name) => [name, Tui[name].prototype])),
      fns: { ...Tui, renderLatex: () => null },
    }).wrapPrototypes();
    new Tui.Text("warm up ".repeat(30), 0, 0).render(80);
    const input = Array.from({ length: 1200 }, (_, index) => index + ": " + "ascii words 甲乙 ".repeat(12)).join("\n");
    const component = new Tui.Text(input, 0, 0);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const rows = component.render(80);
    const product = productFor(rows);
    assert.ok(product && product.rows.some((row) => row.spans.some((span) => span.text?.length)));
    assert.equal(rows.length, 3600);
    global.gc();
    const retained = process.memoryUsage().heapUsed - before;
    assert.ok(retained < 6 * 1024 * 1024, "copy scene retained " + retained + " bytes");
    assert.equal(component.render(80), rows);
    assert.equal(productFor(rows), product);
  `], { cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});
