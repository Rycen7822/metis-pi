import { AsyncLocalStorage } from "node:async_hooks";
import { getPackageDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadNativeCodemodeSandboxClass } from "./codemode-sandbox.mjs";
import type { CodemodeSandboxBase, CodemodeTool } from "@earendil-works/pi-codemode";
import { asRecord } from "../presentation/tool-names.ts";
import { isCodemodeHelper, type CodemodeAction, type CodemodeActions } from "./transcript/codemode-actions.ts";

type Execute = ToolDefinition["execute"];
type Result = Awaited<ReturnType<Execute>>;
type Update = NonNullable<Parameters<Execute>[3]>;
type SandboxExecute = CodemodeSandboxBase["execute"];
const DEFINITION_OWNER = Symbol.for("metis-pi.codemode-definition-observer.v1");
const SANDBOX_OWNER = Symbol.for("metis-pi.codemode-sandbox-observer.v1");
const MAX_ACTIONS = 128; // Bound persisted helper metadata; keep recent actions like the native call preview.
const MAX_ARGUMENT_CHARS = 200; // Same argument-preview bound as native codemode calls; never copy full helper results.

class ActionRun {
  readonly calls: CodemodeAction[] = [];
  omitted = 0;
  nativeCalls = 0;
  claimedSandbox = false;
  settled = false;
  private sequence = 0;
  private latest: Result = { content: [], details: {} };
  private readonly parent: string;
  private readonly update: Update | undefined;
  readonly enabled: () => boolean;
  constructor(parent: string, update: Update | undefined, enabled: () => boolean) {
    this.parent = parent; this.update = update; this.enabled = enabled;
  }

  attach(result: Result): Result {
    if (!this.enabled() || !this.calls.length && !this.omitted) return result;
    const codemodeActions: CodemodeActions = { calls: this.calls.map(call => ({ ...call })), omitted: this.omitted };
    return { ...result, details: { ...asRecord(result.details), codemodeActions } };
  }

  publish = (result: Result): void => {
    this.latest = result;
    const calls = asRecord(result.details).calls;
    this.nativeCalls = Array.isArray(calls) ? calls.length : this.nativeCalls;
    this.update?.(this.attach(result));
  };

  private refresh(): void { if (!this.settled && this.enabled()) this.update?.(this.attach(this.latest)); }

  observe(global: CodemodeTool): CodemodeTool["execute"] {
    const original = global.execute;
    const name = global.name;
    if (!isCodemodeHelper(name)) return original;
    return async (args, context) => {
      if (this.settled || !this.enabled()) return original.call(global, args, context);
      const call: CodemodeAction = {
        id: `${this.parent}/helper/${++this.sequence}`, name,
        arguments: (Array.isArray(args) ? args : [args]).slice(0, 3).map(previewArgument),
        beforeCall: this.nativeCalls, status: "running",
      };
      if (this.calls.length === MAX_ACTIONS) { this.calls.shift(); this.omitted++; }
      this.calls.push(call);
      this.refresh();
      try {
        const value = await original.call(global, args, context);
        call.status = "ok";
        return value;
      } catch (error) {
        call.status = context.signal.aborted ? "cancelled" : "error";
        call.error = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ARGUMENT_CHARS);
        throw error;
      } finally { this.refresh(); }
    };
  }

  finish(result: Result): Result {
    this.settled = true;
    for (const call of this.calls) if (call.status === "running") call.status = "cancelled";
    return this.attach(result);
  }
}

function previewArgument(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_ARGUMENT_CHARS);
  if (value === null || typeof value !== "object") return String(value).slice(0, MAX_ARGUMENT_CHARS);
  const options = asRecord(value);
  // Search options are small scalar facts, not an invitation to serialize arbitrary objects.
  const namespace = typeof options.namespace === "string" ? `namespace=${options.namespace.slice(0, MAX_ARGUMENT_CHARS)}` : "";
  const limit = typeof options.limit === "number" ? `limit=${options.limit}` : "";
  return [namespace, limit].filter(Boolean).join(", ") || "[object]";
}

interface SandboxLease {
  owners: number;
  scope: AsyncLocalStorage<ActionRun>;
  release(): void;
}

/** One bridge per actual SDK prototype; concurrent sessions share it but not their AsyncLocalStorage scope. */
function sandboxLease(prototype: CodemodeSandboxBase): SandboxLease | undefined {
  const original = prototype.execute;
  const previous = (original as SandboxExecute & { [SANDBOX_OWNER]?: SandboxLease })[SANDBOX_OWNER];
  if (previous && previous.owners > 0) { previous.owners++; return previous; }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "execute");
  if (!descriptor?.writable || !descriptor.configurable) return;
  const scope = new AsyncLocalStorage<ActionRun>();
  const wrapper: SandboxExecute = function (this: CodemodeSandboxBase, ...args) {
    const run = lease.owners > 0 ? scope.getStore() : undefined;
    if (!run || !run.enabled() || run.claimedSandbox) return original.apply(this, args);
    run.claimedSandbox = true;
    const globals = this.globals.filter(global => isCodemodeHelper(global.name));
    const saved = globals.map(global => global.execute);
    globals.forEach(global => { global.execute = run.observe(global); });
    const restore = () => globals.forEach((global, index) => { global.execute = saved[index]!; });
    try { return original.apply(this, args).finally(restore); }
    catch (error) { restore(); throw error; }
  };
  const lease: SandboxLease = {
    owners: 1, scope,
    release() {
      if (--lease.owners > 0) return;
      // A later wrapper may retain ours; zero owners also makes that retained closure a native passthrough.
      restoreMethod(prototype, wrapper, descriptor);
      scope.disable();
    },
  };
  Object.defineProperty(wrapper, SANDBOX_OWNER, { value: lease });
  Object.defineProperty(prototype, "execute", { ...descriptor, value: wrapper });
  return lease;
}

interface DefinitionLease {
  target: Pick<ToolDefinition, "execute">;
  descriptor: PropertyDescriptor;
  wrapper: Execute;
  owners: Set<() => boolean>;
}

function restoreMethod(target: object, wrapper: unknown, original: PropertyDescriptor): void {
  const current = Object.getOwnPropertyDescriptor(target, "execute");
  if (current && current.value === wrapper && current.configurable === original.configurable
    && current.writable === original.writable && current.enumerable === original.enumerable)
    Object.defineProperty(target, "execute", original);
}

export function createCodemodeObserver(enabled: () => boolean): {
  observe(definition: Pick<ToolDefinition, "execute">): void;
  dispose(): void;
} {
  const definitions = new Set<WeakRef<DefinitionLease>>();
  const seen = new WeakSet<object>();
  const owner = () => enabled();
  return {
    observe(definition) {
      if (seen.has(definition)) return;
      seen.add(definition);
      const original = definition.execute;
      const previous = (original as Execute & { [DEFINITION_OWNER]?: DefinitionLease })[DEFINITION_OWNER];
      if (previous && previous.owners.size > 0) {
        previous.owners.add(owner);
        definitions.add(new WeakRef(previous));
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(definition, "execute");
      if (!descriptor?.writable || !descriptor.configurable) return;
      const wrapper: Execute = async function (this: unknown, ...args) {
        const isObserving = () => [...binding.owners].some(owner => owner());
        if (!isObserving()) return original.apply(this, args);
        // Keep QuickJS and the sandbox bridge lazy, just like native codemode execution.
        const CodemodeSandboxBase = await loadNativeCodemodeSandboxClass(getPackageDir());
        if (!isObserving()) return original.apply(this, args);
        const bridge = sandboxLease(CodemodeSandboxBase.prototype);
        if (!bridge) return original.apply(this, args);
        const [id, input, signal, onUpdate, context] = args;
        const run = new ActionRun(id, onUpdate, isObserving);
        try {
          return await bridge.scope.run(run, async () => {
            const result = await original.call(this, id, input, signal, run.publish, context);
            return run.finish(result);
          });
        } finally { run.settled = true; bridge.release(); }
      };
      const binding: DefinitionLease = { target: definition, descriptor, wrapper, owners: new Set([owner]) };
      Object.defineProperty(wrapper, DEFINITION_OWNER, { value: binding });
      Object.defineProperty(definition, "execute", { ...descriptor, value: wrapper });
      definitions.add(new WeakRef(binding));
    },
    dispose() {
      for (const ref of definitions) {
        const binding = ref.deref();
        if (!binding) continue;
        binding.owners.delete(owner);
        if (!binding.owners.size) restoreMethod(binding.target, binding.wrapper, binding.descriptor);
      }
      definitions.clear();
    },
  };
}
