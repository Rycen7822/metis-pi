import { asRecord, TOOL_NAMES, type Component, type Palette, type Renderers, type ToolName, type ViewContext } from "./tool-names.ts";
import { decorationRow, productFor, publishRows, publishedRowsOf, registerProduct } from "./selection-copy/model.ts";
import { fileURLToPath } from "node:url";
import { fusionRenderers } from "./fusion-view.ts";
import type { NestedRendererLookup } from "./codemode-view.ts";

export const OWNED_EXECUTION_ENTRY = fileURLToPath(new URL("../extensions/execution.ts", import.meta.url));
export const OWNED_FUSION_ENTRY = fileURLToPath(new URL("../extensions/action-fusion.ts", import.meta.url));

// Display-only adapter for Pi’s native ToolExecutionComponent.
// No tool registration, execution replacement, context middleware or TUI root patch.
const SLOT = Symbol.for("Rycen7822.metis-pi.tool-view.v2");
const SELECTORS = ["getCallRenderer", "getResultRenderer", "getRenderShell"] as const;
const METHODS = [...SELECTORS, "render"] as const;
type UiMethod = (this: unknown, ...args: any[]) => any;
type Hook = { target: object; original: PropertyDescriptor; patched: PropertyDescriptor };
// Session replacement renders history before the next display lease is bound.
// Retain only a weak native lookup context, never an extension ctx or session.
const CONTEXTS_KEY = Symbol.for("metis-pi.native-renderer-contexts.v1");
const shared = globalThis as unknown as Record<symbol, unknown>;
const LOOKUP_CONTEXTS = (shared[CONTEXTS_KEY] ??= new WeakMap<object, WeakRef<object>>()) as WeakMap<object, WeakRef<object>>;
type RegisteredRenderers = { name: string; call: unknown; result: unknown; shell: unknown };
export interface AdapterOptions {
  getTools(): readonly unknown[];
  enabled(): boolean;
  renderers: Record<ToolName, Renderers>;
  makeCodemode?: (resolve: NestedRendererLookup) => Renderers;
  /** Native InteractiveMode lookup: prove resolved renderers still belong to the registered tool. */
  definitionPrototype?: object;
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
function supportsSelector(key: typeof SELECTORS[number], select: UiMethod): boolean {
  const field = ({ getCallRenderer: "renderCall", getResultRenderer: "renderResult", getRenderShell: "renderShell" } as const)[key];
  const definition = { renderCall() {}, renderResult() {}, renderShell: "self" };
  const definitions: (Partial<typeof definition> | undefined)[] = [undefined, {}, definition];
  try {
    return definitions.every(toolDefinition => select.call({ toolDefinition }) ===
      (toolDefinition?.[field] ?? (key === "getRenderShell" ? "default" : undefined)));
  } catch { return false; }
}

function supportsSelfShellRender(render: UiMethod): boolean {
  // The adapter needs the host to compose text and images and update mouse height.
  // Exercise that capability without constructing a row or executing a tool.
  const widths: number[] = [];
  const component = (lines: string[]) => ({ render(width: number) { widths.push(width); return lines; } });
  const row = {
    hideComponent: false, hasRendererDefinition: () => true, getRenderShell: () => "self",
    selfRenderContainer: component(["call", "result"]), selfRenderHeight: -1,
    imageSpacers: [component(["spacer"])], imageComponents: [component(["image"])],
  };
  try {
    const lines = render.call(row, 37);
    return Array.isArray(lines) && lines.length === 5 && lines.every((line, i) => line === ["", "call", "result", "spacer", "image"][i])
      && row.selfRenderHeight === 2 && widths.length === 3 && widths.every(width => width === 37);
  } catch { return false; }
}

function supportsRendererLookup(lookup: UiMethod): boolean {
  const name = "__metis_renderer_capability__";
  const definition = { renderCall() {}, renderResult() {}, renderShell: "self" };
  const resolved = { ...definition, renderCall() {} };
  let read = false, resolve = false;
  const session = {
    getToolDefinition(toolName: string) { read = toolName === name; return definition; },
    extensionRunner: { resolveToolRenderers(toolName: string, next: () => unknown) {
      const base = asRecord(next());
      resolve = toolName === name && base.renderCall === definition.renderCall
        && base.renderResult === definition.renderResult && base.renderShell === "self";
      return resolved;
    } },
  };
  try { return lookup.call({ session }, name) === resolved && read && resolve; }
  catch { return false; }
}

export function installAdapter(prototype: object, options: AdapterOptions): AdapterHandle {
  if (Object.prototype.hasOwnProperty.call(prototype, SLOT)) return skipped("Another copy is already installed");
  const hooks = new Map<string, Hook>();
  for (const key of METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
      return skipped(`Unrecognized or read-only Pi UI method: ${key}`);
    }
    if (key !== "render" && !supportsSelector(key, descriptor.value)) {
      return skipped(`Unrecognized or already modified Pi UI selector: ${key}`);
    }
    if (key === "render") {
      if (!supportsSelfShellRender(descriptor.value)) {
        return skipped("Unrecognized or already modified Pi tool-row render method");
      }
    }
    hooks.set(key, { target: prototype, original: descriptor, patched: { ...descriptor } });
  }
  if (!Object.isExtensible(prototype) || typeof asRecord(prototype).updateDisplay !== "function") {
    return skipped("Pi UI prototype is sealed or its display updater is unavailable");
  }
  const definitionPrototype = options.definitionPrototype;
  const lookup =
    definitionPrototype && Object.getOwnPropertyDescriptor(definitionPrototype, "getRegisteredToolDefinition");
  if (
    definitionPrototype &&
    (!lookup ||
      typeof lookup.value !== "function" ||
      !lookup.configurable ||
      !lookup.writable ||
      !supportsRendererLookup(lookup.value))
  ) {
    return skipped("Unrecognized or already modified Pi renderer lookup");
  }
  const sessionGetter = definitionPrototype && Object.getOwnPropertyDescriptor(definitionPrototype, "session");
  if (sessionGetter) {
    const session = {};
    try {
      if (!sessionGetter.configurable || typeof sessionGetter.get !== "function"
          || sessionGetter.get.call({ runtimeHost: { session } }) !== session) {
        return skipped("Unrecognized or already modified Pi session lookup");
      }
    } catch { return skipped("Unrecognized or already modified Pi session lookup"); }
  }
  const captureContext = function (this: object): unknown {
    if (active) LOOKUP_CONTEXTS.set(definitionPrototype!, new WeakRef(this));
    return sessionGetter!.get!.call(this);
  };
  const registered = new WeakMap<object, RegisteredRenderers>();
  const registeredRenderers = (context: unknown, name: string): RegisteredRenderers | undefined => {
    try {
      const session = asRecord(asRecord(context).session);
      const definition = typeof session.getToolDefinition === "function" ? session.getToolDefinition(name) : undefined;
      if (!definition) return;
      const base = asRecord(definition);
      return { name, call: base.renderCall, result: base.renderResult, shell: base.renderShell ?? "default" };
    } catch { /* A stale/disposed native context cannot prove ownership. */ }
  };
  const lookupWrapper = function (this: object, name: string): unknown {
    if (!active) return lookup!.value.call(this, name);
    LOOKUP_CONTEXTS.set(definitionPrototype!, new WeakRef(this));
    // Snapshot BEFORE resolution, including resolvers that mutate next().
    const snapshot = registeredRenderers(this, name);
    const resolved = lookup!.value.call(this, name);
    if (snapshot && resolved && typeof resolved === "object") registered.set(resolved, snapshot);
    return resolved;
  };
  if (definitionPrototype) hooks.set("getRegisteredToolDefinition", {
    target: definitionPrototype, original: lookup!, patched: { ...lookup!, value: lookupWrapper },
  });
  if (sessionGetter) hooks.set("session", {
    target: definitionPrototype!, original: sessionGetter, patched: { ...sessionGetter, get: captureContext },
  });
  const displayed = new WeakMap<object, boolean>();
  const rows = new Set<WeakRef<object>>();
  let active = true;
  const ownsHook = (key: string, hook: Hook) => {
    const current = Object.getOwnPropertyDescriptor(hook.target, key);
    return current?.value === hook.patched.value && current?.get === hook.patched.get;
  };
  const ownsMethods = () => [...hooks].every(([key, hook]) => ownsHook(key, hook));

  function replacement(row: unknown): Renderers | undefined {
    if (!active || !ownsMethods() || !options.enabled()) return;
    const current = asRecord(row);
    const name = current.toolName;
    if (typeof name !== "string") return;
    const definition = asRecord(current.toolDefinition);
    if (Object.keys(definition).length === 0) return;
    // A compatible wrapper may still override a particular row. Check actual
    // selector results before claiming it, in addition to registered provenance.
    if (hooks.get("getCallRenderer")!.original.value.call(row) !== definition.renderCall
        || hooks.get("getResultRenderer")!.original.value.call(row) !== definition.renderResult
        || hooks.get("getRenderShell")!.original.value.call(row) !== (definition.renderShell ?? "default")) return;
    if (definitionPrototype) {
      const base = registered.get(definition)
        ?? registeredRenderers(LOOKUP_CONTEXTS.get(definitionPrototype)?.deref(), name);
      if (!base || base.name !== name || base.call !== definition.renderCall || base.result !== definition.renderResult
          || base.shell !== (definition.renderShell ?? "default")) return;
    }
    // Respect third-party overrides of builtin names; only named FFF searches opt in.
    // Unknown origin is not interpreted as permission to take over a renderer.
    const info = asRecord(options.getTools().find((tool) => asRecord(tool).name === name));
    const source = asRecord(info.sourceInfo);
    if (
      (name === "edit" || name === "write") &&
      typeof source.source === "string" &&
      source.path === OWNED_FUSION_ENTRY
    ) {
      return fusionRenderers(options.renderers[name], options.renderers.bash, () => current.result);
    }
    if (
      name === "exec_command" &&
      options.highlightOwnedCommand &&
      typeof source.source === "string" &&
      source.path === OWNED_EXECUTION_ENTRY
    ) {
      const call = definition.renderCall;
      const result = definition.renderResult;
      if (typeof call !== "function" || typeof result !== "function") return;
      return {
        renderCall: (args, theme, context) =>
          call(
            args,
            {
              fg: (role: string, text: string) => theme.fg(role, text),
              bold: (text: string) => theme.bold(text),
              highlightCommandLines: options.highlightOwnedCommand,
              renderCommandCall: options.renderOwnedCommand
                ? (command: string, state: "running" | "done", expanded: boolean) =>
                    options.renderOwnedCommand!(command, state, expanded, theme, context)
                : undefined,
            },
            context,
          ),
        renderResult: (value, options, theme, context) => result(value, options, theme, context),
      };
    }
    if (name === "codemode" && source.source === "builtin" && source.path === "builtin:codemode" && codemode)
      return {
        renderCall: codemode.renderCall,
        // Native render callbacks omit the persisted nested-call argument ledger.
        renderResult: (value, opts, theme, ctx) =>
          codemode.renderResult(
            { ...asRecord(value), nestedCalls: asRecord(current.result).nestedCalls },
            opts,
            theme,
            ctx,
          ),
      };
    if (!TOOL_NAMES.includes(name as ToolName)) return;
    const builtin = source.source === "builtin" && source.path === `builtin:${name}`;
    const fff = (name === "ffgrep" || name === "fffind") && typeof source.path === "string" && typeof source.source === "string"
      && (source.source === "npm:@ff-labs/pi-fff" || source.source.startsWith("npm:@ff-labs/pi-fff@"));
    if (!builtin && !fff) return;
    // Approved self-shell tools use the same compact renderer as text tools;
    // other provider origins and independent overlays have backed off above.
    return options.renderers[name as ToolName];
  }
  const codemode = options.makeCodemode?.((name, result) => {
    if (!active || !ownsMethods() || !options.enabled() || name === "codemode") return;
    const context = definitionPrototype && LOOKUP_CONTEXTS.get(definitionPrototype)?.deref();
    if (!context) return;
    const definition = lookupWrapper.call(context, name);
    if (!definition || typeof definition !== "object") return;
    const owned = replacement({ toolName: name, toolDefinition: definition, result });
    if (owned) return owned;
    const { renderCall, renderResult } = asRecord(definition);
    if (typeof renderCall !== "function" || typeof renderResult !== "function") return;
    return {
      renderCall: (args, theme, ctx) => renderCall(args, theme, ctx),
      renderResult: (value, opts, theme, ctx) => renderResult(value, opts, theme, ctx),
    };
  });
  const rendering = new Map<unknown, Renderers | undefined>();
  function select(row: unknown): Renderers | undefined {
    if (rendering.has(row)) return active && ownsMethods() && options.enabled() ? rendering.get(row) : undefined;
    try { return replacement(row); } catch { return undefined; }
  }
  for (const key of SELECTORS) {
    const hook = hooks.get(key)!;
    const original = hook.original.value as UiMethod;
    hook.patched.value = function (this: unknown): unknown {
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
    };
  }
  const renderHook = hooks.get("render")!;
  const originalRender = renderHook.original.value as UiMethod;
  renderHook.patched.value = function (this: unknown, width: number): unknown {
    const nested = rendering.has(this), previousSelection = rendering.get(this);
    rendering.set(this, select(this));
    try {
      if (typeof this === "object" && this !== null) {
        const next = rendering.get(this) !== undefined;
        const previous = displayed.get(this) ?? false;
        if (next !== previous) {
          if (!displayed.has(this)) {
            rows.add(new WeakRef(this));
            if (rows.size % 256 === 0) for (const ref of rows) if (!ref.deref()) rows.delete(ref);
          }
          displayed.set(this, next);
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
    } finally {
      if (nested) rendering.set(this, previousSelection);
      else rendering.delete(this);
    }
  };
  const owner = {};
  function restoreOwned(): void {
    for (const [key, hook] of hooks) {
      try {
        if (ownsHook(key, hook)) Object.defineProperty(hook.target, key, hook.original);
      } catch { /* A frozen target keeps an inactive wrapper. */ }
    }
    try {
      if (Object.getOwnPropertyDescriptor(prototype, SLOT)?.value === owner) Reflect.deleteProperty(prototype, SLOT);
    } catch { /* Do not overwrite another extension or a frozen marker. */ }
  }
  try {
    Object.defineProperty(prototype, SLOT, { value: owner, configurable: true });
    for (const [key, hook] of hooks) Object.defineProperty(hook.target, key, hook.patched);
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
