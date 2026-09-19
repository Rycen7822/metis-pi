import { StringDecoder } from "node:string_decoder";
import { getCodexShellArgs } from "../../adapter/prompt/runtime-shell.js";
import { chunkToBytes, createExecBridgeClient } from "./bridge-client.js";
const EXIT_OUTPUT_GRACE_MS = 100;
export function createBridgeSessionRuntime(binaryPath) {
    const bridge = createExecBridgeClient(binaryPath);
    let pollQueue = Promise.resolve();
    function setClosedExitCode(session, code, signal) {
        if (session.exitCode !== undefined && session.exitCode !== null)
            return;
        if (session.terminating) {
            session.exitCode = code && code !== 0 ? code : signal ? 128 + signalNumber(signal) : 143;
            return;
        }
        session.exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
    }
    async function poll(session, hooks, waitMs = 0, maxBytes) {
        if (!hooks.isOwned(session))
            return;
        const response = await bridge.request({
            op: "read",
            process_id: session.processId,
            after_seq: session.lastSeq,
            max_bytes: maxBytes,
            wait_ms: waitMs,
        });
        let receivedOutput = false;
        for (const chunk of response.chunks ?? []) {
            hooks.onOutput(session, session.outputDecoders[chunk.stream].write(chunkToBytes(chunk.chunk)));
            session.lastSeq = Math.max(session.lastSeq, chunk.seq);
            receivedOutput = true;
        }
        session.lastSeq = Math.max(session.lastSeq, response.nextSeq - 1);
        if (response.exited) {
            session.observedExitCode = response.exitCode;
            if (session.postExitIdleSince === undefined || receivedOutput)
                session.postExitIdleSince = Date.now();
        }
        const postExitIdle = session.postExitIdleSince !== undefined
            && Date.now() - session.postExitIdleSince >= EXIT_OUTPUT_GRACE_MS;
        if (response.closed || postExitIdle) {
            if (!session.outputDecodersFlushed) {
                session.outputDecodersFlushed = true;
                for (const decoder of Object.values(session.outputDecoders))
                    hooks.onOutput(session, decoder.end());
            }
            setClosedExitCode(session, response.exitCode ?? session.observedExitCode);
            hooks.onExit(session);
        }
    }
    async function pollBackground(session, hooks) {
        const previous = pollQueue;
        let release;
        pollQueue = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await poll(session, hooks, 250);
        }
        finally {
            release();
        }
    }
    async function pollLoop(session, hooks) {
        while (hooks.isOwned(session) && (session.exitCode === undefined || session.exitCode === null)) {
            try {
                await pollBackground(session, hooks);
            }
            catch (error) {
                hooks.onOutput(session, `${error instanceof Error ? error.message : String(error)}\n`);
                session.exitCode = 1;
                hooks.onExit(session);
                return;
            }
        }
    }
    function create(args) {
        const { id, input, workdir, shell, signal, hooks } = args;
        const session = {
            id,
            processId: `pi-${id}`,
            startup: Promise.resolve(),
            started: false,
            tty: Boolean(input.tty),
            command: input.command,
            buffer: "",
            bufferStartOffset: 0,
            emittedOffset: 0,
            outputVersion: 0,
            exitCode: undefined,
            listeners: new Set(),
            interactive: Boolean(input.tty),
            lastSeq: 0,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            finalized: false,
            exposed: false,
            terminating: false,
            outputDecoders: {
                stdout: new StringDecoder("utf8"),
                stderr: new StringDecoder("utf8"),
                pty: new StringDecoder("utf8"),
            },
            outputDecodersFlushed: false,
        };
        session.startup = (async () => {
            try {
                const shellArgs = getCodexShellArgs(shell, input.executionCommand, input.login ?? true);
                await bridge.request({
                    op: "exec",
                    process_id: session.processId,
                    argv: [shell, ...shellArgs],
                    cwd: workdir,
                    env: input.executionEnv,
                    tty: Boolean(input.tty),
                    pipe_stdin: Boolean(input.tty),
                    arg0: null,
                });
                session.started = true;
                if (signal?.aborted) {
                    session.terminating = true;
                    await bridge.request({ op: "terminate", process_id: session.processId });
                }
                void pollLoop(session, hooks);
            }
            catch (error) {
                hooks.onOutput(session, `${error instanceof Error ? error.message : String(error)}\n`);
                session.exitCode = 1;
                hooks.onExit(session);
            }
        })();
        return session;
    }
    async function waitForStartup(session, signal) {
        if (!signal)
            return session.startup;
        if (signal.aborted)
            throw new Error("exec_command aborted");
        let removeAbortListener = () => { };
        const aborted = new Promise((_, reject) => {
            const onAbort = () => reject(new Error("exec_command aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        });
        try {
            await Promise.race([session.startup, aborted]);
        }
        finally {
            removeAbortListener();
        }
    }
    return {
        create,
        poll,
        waitForStartup,
        write: async (session, chars) => {
            await bridge.request({ op: "write", process_id: session.processId, chunk: Array.from(Buffer.from(chars, "utf8")) });
        },
        terminate: async (session) => {
            await bridge.request({ op: "terminate", process_id: session.processId });
        },
        shutdown: () => bridge.shutdown(),
    };
}
function signalNumber(signal) {
    if (signal === "SIGTERM")
        return 15;
    if (signal === "SIGKILL")
        return 9;
    if (signal === "SIGINT")
        return 2;
    const numericSignal = /^SIG(\d+)$/.exec(signal)?.[1];
    return numericSignal ? Number.parseInt(numericSignal, 10) : 1;
}
