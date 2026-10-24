import childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

// Keep real subprocess I/O, but Windows must explicitly interpret Node shebang fixtures.
if (process.platform === "win32") {
  const redirect = (command, args) => {
    if (!["curl", "git", "gh"].includes(command)) return [command, args];
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const script = join(directory, command);
      if (existsSync(script) && readFileSync(script, "utf8").startsWith("#!/usr/bin/env node\n"))
        return [process.execPath, [script, ...args]];
    }
    // An absent substitute must fail as ENOENT, never fall through to a real CLI.
    return [join(tmpdir(), `metis-unbound-test-${command}.exe`), args];
  };
  for (const name of ["spawn", "execFile"]) {
    const original = childProcess[name];
    const wrapped = (command, args, ...rest) => original(...redirect(command, args), ...rest);
    if (name === "execFile")
      wrapped[promisify.custom] = (command, args, ...rest) => promisify(original)(...redirect(command, args), ...rest);
    childProcess[name] = wrapped;
  }
  syncBuiltinESMExports();
  const option = `--import=${import.meta.url}`;
  if (!(process.env.NODE_OPTIONS ?? "").includes(option))
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, option].filter(Boolean).join(" ");
}
