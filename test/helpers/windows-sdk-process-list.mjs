import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

export function mockWindowsSdkProcessList(readProcesses) {
  const original = childProcess.execFile;
  const run = promisify(original);
  const replacement = (...args) => original(...args);
  replacement[promisify.custom] = (file, args, options) => {
    if (path.basename(file).toLowerCase() === "powershell.exe" && args.at(-1)?.includes("Get-CimInstance Win32_Process")) {
      return Promise.resolve({ stdout: JSON.stringify(readProcesses()), stderr: "" });
    }
    return run(file, args, options);
  };
  childProcess.execFile = replacement;
  syncBuiltinESMExports();
  return () => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  };
}

if (process.platform === "win32" && process.env.METIS_TEST_WINDOWS_SDK_PROCESS_LIST === "empty") {
  mockWindowsSdkProcessList(() => []);
}
