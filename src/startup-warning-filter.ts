// Some extensions print compatibility fallbacks directly into the live TUI
// while a subagent reloads resources. Do not mute stderr or all console warnings:
// only this reviewed, non-fatal fallback is safe to hide after UI startup.
const WEB_ACTIVATION_FALLBACK = "[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.";
const OWNER = Symbol.for("metis-pi.startup-warning-filter");

type WarningConsole = Pick<Console, "warn"> & { [OWNER]?: { dispose(): void } };

export function installStartupWarningFilter(target: WarningConsole = console): { dispose(): void } {
  target[OWNER]?.dispose();
  const previous = target.warn;
  let active = true;
  function warn(this: WarningConsole, ...args: unknown[]): void {
    if (active && args.length === 1 && args[0] === WEB_ACTIVATION_FALLBACK) return;
    Reflect.apply(previous, this, args);
  }
  const handle = {
    dispose() {
      active = false;
      if (target.warn === warn) target.warn = previous;
      if (target[OWNER] === handle) delete target[OWNER];
    },
  };
  target.warn = warn;
  target[OWNER] = handle;
  return handle;
}
