import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function createJupyterConnectionFile() {
    const [shellPort, iopubPort, stdinPort, controlPort, heartbeatPort] = await reserveLoopbackPorts(5);
    const info = {
        ip: "127.0.0.1",
        transport: "tcp",
        shell_port: shellPort,
        iopub_port: iopubPort,
        stdin_port: stdinPort,
        control_port: controlPort,
        hb_port: heartbeatPort,
        signature_scheme: "hmac-sha256",
        key: randomBytes(24).toString("hex"),
        kernel_name: "deno",
    };
    const dir = mkdtempSync(join(tmpdir(), "pi-codex-deno-kernel-"));
    const path = join(dir, "connection.json");
    writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    return { info, path, dir };
}
async function reserveLoopbackPorts(count) {
    const servers = [];
    try {
        for (let index = 0; index < count; index += 1) {
            const server = createServer();
            servers.push(server);
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
        }
        return servers.map((server) => {
            const address = server.address();
            if (!address || typeof address === "string")
                throw new Error("Could not reserve a Jupyter loopback port");
            return address.port;
        });
    }
    finally {
        await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    }
}
