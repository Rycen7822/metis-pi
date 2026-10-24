import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

let windowsPython: string | undefined;
const options = { encoding: "utf8" as const, timeout: 5000, windowsHide: true };
const inspect = "import json,sys; print(json.dumps([sys.executable, sys.version_info >= (3,11)]))";

function onPath(name: string): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory =>
    join(directory.replace(/^"|"$/g, ""), `${name}.exe`),
  ).filter(path => existsSync(path) && (name === "py" || !/\\Microsoft\\WindowsApps\\[^\\]+\.exe$/i.test(path)));
}

function compatiblePython(command: string, args: string[] = []): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHON_MANAGER_AUTOMATIC_INSTALL: "false" };
  delete env.PYLAUNCHER_ALLOW_INSTALL;
  delete env.PYLAUNCHER_ALWAYS_INSTALL;
  const result = spawnSync(command, [...args, "-I", "-c", inspect], { ...options, env });
  if (result.status !== 0) return;
  try {
    // ASCII JSON avoids the console code page corrupting non-ASCII home paths.
    const [executable, supported] = JSON.parse(result.stdout);
    if (supported === true && typeof executable === "string" && existsSync(executable)) return executable;
  } catch { /* A different executable or unsupported interpreter is not a candidate. */ }
}

export function getPythonCommand(): string {
  if (process.platform !== "win32") return "python3";
  if (windowsPython) return windowsPython;
  for (const command of [...onPath("python"), ...onPath("python3")]) {
    const executable = compatiblePython(command);
    if (executable) return windowsPython = executable;
  }
  for (const launcher of onPath("py")) {
    const installed = spawnSync(launcher, ["-0p"], options);
    if (installed.status !== 0) continue;
    // Select only an already installed runtime; do not let a launcher download one.
    for (const line of installed.stdout.split(/\r?\n/)) {
      const selector = /^\s*(-(?:V:[\w./-]+|3\.\d+(?:-\d+)?))\s/.exec(line)?.[1];
      if (!selector) continue;
      const executable = compatiblePython(launcher, [selector]);
      if (executable) return windowsPython = executable;
    }
  }
  throw new Error("Metis subagents require Python 3.11+: install Python and add python.exe or the Python launcher to PATH.");
}
