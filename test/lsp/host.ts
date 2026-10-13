import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Only the capabilities consumed by owned LSP registration/lifecycle are substituted.
export function createMockPi() {
  const tools: any[] = [];
  const events = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, any>();
  const pi = {
    registerTool(tool: any) { tools.push(tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: any) { events.set(name, [...events.get(name) ?? [], handler]); },
  } as unknown as ExtensionAPI;
  return { pi, tools, events, commands };
}
export function createMockContext(overrides: Record<string, unknown> = {}) {
  const statuses = new Map<string, string | undefined>();
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd: process.cwd(), sessionManager: {},
    ui: {
      setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
      notify(message: string, level?: string) { notifications.push({ message, level }); },
    }, ...overrides,
  } as unknown as ExtensionContext;
  return { ctx, statuses, notifications };
}
