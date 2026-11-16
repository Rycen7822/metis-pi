import { parentPort, workerData } from "node:worker_threads";
import { spawnSync } from "node:child_process";

// A bounded synchronous child wait belongs here, not on the TUI event loop.
parentPort.on("message", ({ id, args, cwd, env }) => {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    timeout: workerData.timeout, maxBuffer: workerData.maxBuffer, killSignal: "SIGKILL",
  });
  parentPort.postMessage({ id, result: {
    ok: !result.error && result.status === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    code: result.status,
  } });
});
