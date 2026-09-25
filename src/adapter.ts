import { asRecord, TOOL_NAMES, type Component, type Palette, type Renderers, type ToolName, type ViewContext } from "./tool-names.ts";
import { decorationRow, productFor, publishRows, publishedRowsOf, registerProduct } from "./selection-copy/model.ts";
import { fileURLToPath } from "node:url";

export const OWNED_CONVERSION_ENTRY = fileURLToPath(new URL("../vendor/pi-codex-conversion/dist/index.js", import.meta.url));

// Display-only adapter for the classic Pi 0.85.x ToolExecutionComponent.
// No tool registration, execution replacement, context middleware or TUI root patch.
const SLOT = Symbol.for("Rycen7822.metis-pi.tool-view.v2");
const SELECTORS = ["getCallRenderer", "getResultRenderer", "getRenderShell"] as const;
const METHODS = [...SELECTORS, "render"] as const;
type Method = typeof METHODS[number];
type UiMethod = (this: unknown, ...args: any[]) => any;
const EXPECTED = {
  getCallRenderer: "returnthis.toolDefinition?.renderCall;",
  getResultRenderer: "returnthis.toolDefinition?.renderResult;",
  getRenderShell: 'returnthis.toolDefinition?.renderShell??"default";',
};
export interface AdapterOptions {
  getTools(): readonly unknown[];
  enabled(): boolean;
  renderers: Record<ToolName, Renderers>;
  /** Only the conversion layer shipped by this package, never another plugin. */
  ownedApplyPatch?: {
    sourcePath: string;
    renderCall: (...args: Parameters<Renderers["renderCall"]>) => ReturnType<Renderers["renderCall"]> | undefined;
  };
  /** Paint only command text; the owned tool retains grouping and execution state. */
  highlightOwnedCommand?: (lines: readonly string[]) => string[];
  renderOwnedCommand?: (command: string, state: "running" | "done", expanded: boolean, theme: Palette, context: ViewContext) => Component;
}
export interface AdapterHandle {
  readonly installed: boolean;
  readonly reason: string;
  dispose(): void;
}
function skipped(reason: string): AdapterHandle { return { installed: false, reason, dispose() {} }; }
function methodBody(fn: Function): string {
  const text = Function.prototype.toString.call(fn);
  return text.slice(text.indexOf("{") + 1, text.lastIndexOf("}"))
    .replace(/\s+/g, "").replace(/'/g, '"').replace(/;?$/, ";");
}

export function installAdapter(prototype: object, options: AdapterOptions): AdapterHandle {
  if (Object.prototype.hasOwnProperty.call(prototype, SLOT)) return skipped("Another copy is already installed");
  const originals = new Map<Method, PropertyDescriptor>();
  for (const key of METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
      return skipped(`Unrecognized or read-only Pi UI method: ${key}`);
    }
    if (key !== "render" && methodBody(descriptor.value) !== EXPECTED[key]) {
      return skipped(`Unrecognized or already modified Pi UI selector: ${key}`);
    }
    if (key === "render") {
      // These are the stock image-aware/self-shell branch and its mouse-height update.
      const body = methodBody(descriptor.value);
      if (!["this.selfRenderContainer.render(", "this.selfRenderHeight=", "this.imageComponents"].every((s) => body.includes(s))) {
        return skipped("Unrecognized or already modified Pi tool-row render method");
      }
    }
    originals.set(key, descriptor);
  }
  if (!Object.isExtensible(prototype) || typeof asRecord(prototype).updateDisplay !== "function") {
    return skipped("Pi UI prototype is sealed or its display updater is unavailable");
  }
  const wrappers = new Map<Method, UiMethod>();
  const displayed = new WeakMap<object, boolean>();
  const knownRows = new WeakSet<object>();
  const rows = new Set<WeakRef<object>>();
  let active = true;
  const ownsMethods = () => METHODS.every((key) => Object.getOwnPropertyDescriptor(prototype, key)?.value === wrappers.get(key));

  function replacement(row: unknown): Renderers | undefined {
    if (!active || !ownsMethods() || !options.enabled()) return;
    const current = asRecord(row);
    const name = current.toolName;
    if (typeof name !== "string") return;
    const definition = asRecord(current.toolDefinition);
    if (Object.keys(definition).length === 0) return;
    // Respect FFF/LSP/etc. even when they override the SAME builtin name.
    // Unknown origin is not interpreted as permission to take over a renderer.
    const info = asRecord(options.getTools().find((tool) => asRecord(tool).name === name));
    const source = asRecord(info.sourceInfo);
    if (name === "exec_command" && options.highlightOwnedCommand && typeof source.source === "string" && source.path === OWNED_CONVERSION_ENTRY) {
      const call = definition.renderCall;
      const result = definition.renderResult;
      if (typeof call !== "function" || typeof result !== "function") return;
      return {
        renderCall: (args, theme, context) => call(args, {
          fg: (role: string, text: string) => theme.fg(role, text),
          bold: (text: string) => theme.bold(text),
          highlightCommandLines: options.highlightOwnedCommand,
          renderCommandCall: options.renderOwnedCommand
            ? (command: string, state: "running" | "done", expanded: boolean) => options.renderOwnedCommand!(command, state, expanded, theme, context)
            : undefined,
        }, context),
        renderResult: (value, options, theme, context) => result(value, options, theme, context),
      };
    }
    const patch = options.ownedApplyPatch;
    if (name === "apply_patch" && patch && typeof source.source === "string" && source.path === patch.sourcePath) {
      const call = definition.renderCall;
      const result = definition.renderResult;
      if (typeof call !== "function" || typeof result !== "function") return;
      return {
        renderCall: (args, theme, context) => patch.renderCall(args, theme, context) ?? call(args, theme, context),
        // Preserve the conversion layer's success/error/partial-failure protocol.
        renderResult: (value, options, theme, context) => result(value, options, theme, context),
      };
    }
    if (!TOOL_NAMES.includes(name as ToolName)) return;
    if (source.source !== "builtin" || source.path !== `<builtin:${name}>`) return;
    // An EXACT builtin self-shell (edit renders its own rows) takes the same
    // renderer as every other text tool; third-party self-shells back off above.
    return options.renderers[name as ToolName];
  }
  function select(row: unknown): Renderers | undefined {
    try { return replacement(row); } catch { return undefined; }
  }
  function remember(row: object): void {
    if (knownRows.has(row)) return;
    knownRows.add(row);
    rows.add(new WeakRef(row));
    // Do not retain transcript rows strongly. Sweep dead weak refs occasionally.
    if (rows.size % 256 === 0) for (const ref of rows) if (!ref.deref()) rows.delete(ref);
  }
  for (const key of SELECTORS) {
    const original = originals.get(key)!.value as UiMethod;
    wrappers.set(key, function (this: unknown): unknown {
      const renderers = select(this);
      if (renderers) {
        if (key === "getCallRenderer") return renderers.renderCall;
        if (key === "getResultRenderer") return renderers.renderResult;
        // Only the command call is decorated; preserve the vendor's result shell.
        if (asRecord(this).toolName === "exec_command") return original.call(this);
        // IMPORTANT: leave the constructor's child tree in its STOCK default-shell
        // form. Activate self-shell only at first render, then populate it below.
        // This makes disabling/unloading revert without splicing children, moving
        // mouse regions, or rewriting Pi's image handling.
        if (typeof this === "object" && this !== null && displayed.get(this)) return "self";
      }
      return original.call(this);
    });
  }
  const originalRender = originals.get("render")!.value as UiMethod;
  wrappers.set("render", function (this: unknown, width: number): unknown {
    if (typeof this === "object" && this !== null) {
      const next = select(this) !== undefined;
      const previous = displayed.get(this) ?? false;
      if (next !== previous) {
        displayed.set(this, next);
        remember(this);
        const refresh = asRecord(this).updateDisplay;
        if (typeof refresh === "function") {
          try { refresh.call(this); } catch {
            // Fall back to the existing default view on a presentation failure.
            displayed.set(this, false);
          }
        }
      }
    }
    const lines = originalRender.call(this, width);
    // The host's self-shell path bypasses Container.render. Publish its actual
    // rows so a parent copy-alignment pass need not render the tool a second time.
    if (typeof this === "object" && this !== null && Array.isArray(lines)) {
      try {
        publishRows(this, lines);
        const row = asRecord(this);
        if (displayed.get(this) && typeof row.getRenderShell === "function" && row.getRenderShell() === "self") {
          const content = publishedRowsOf(row.selfRenderContainer);
          const product = content && productFor(content);
          // The native self-shell composes a blank prefix, its text subtree,
          // then image rows. Bind only the verified text region; never re-render
          // it or pretend that unknown/image rows have text provenance.
          if (content?.length && product?.width === width && row.selfRenderHeight === content.length
              && lines[0] === "" && content.every((line, index) => lines[index + 1] === line)) {
            registerProduct(lines, {
              componentId: "tool-self-shell", width, rows: [decorationRow(width)],
              children: [undefined, ...content.map((_, rowIndex) => ({ product, rowIndex, colShift: 0 }))],
            });
          }
        }
      } catch { /* Copy metadata must not break rendering. */ }
    }
    return lines;
  });
  const owner = {};
  function restoreOwned(): void {
    for (const key of METHODS) {
      try {
        if (Object.getOwnPropertyDescriptor(prototype, key)?.value === wrappers.get(key)) {
          Object.defineProperty(prototype, key, originals.get(key)!);
        }
      } catch { /* A frozen prototype keeps an inert wrapper rather than throwing. */ }
    }
    try {
      if (Object.getOwnPropertyDescriptor(prototype, SLOT)?.value === owner) Reflect.deleteProperty(prototype, SLOT);
    } catch { /* Do not overwrite another extension or a frozen marker. */ }
  }
  try {
    Object.defineProperty(prototype, SLOT, { value: owner, configurable: true });
    for (const key of METHODS) Object.defineProperty(prototype, key, { ...originals.get(key)!, value: wrappers.get(key) });
  } catch {
    active = false;
    restoreOwned();
    return skipped("Pi tool-row UI cannot be decorated");
  }
  return {
    installed: true,
    reason: "Codex-style compact tool transcript enabled; third-party renderers preserved",
    dispose() {
      active = false;
      restoreOwned();
      // Our deferred self-shell activation kept each original default child tree.
      // Refill it now; do not require a tool event to repair previously drawn rows.
      for (const ref of rows) {
        const row = ref.deref();
        if (!row) continue;
        displayed.set(row, false);
        try {
          const refresh = asRecord(row).updateDisplay;
          if (typeof refresh === "function") refresh.call(row);
          const request = asRecord(asRecord(row).ui).requestRender;
          if (typeof request === "function") request.call(asRecord(row).ui);
        } catch { /* Best-effort repaint; no data-path or shutdown errors. */ }
      }
      rows.clear();
    },
  };
}
