from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
from . import ipc, locks
from .common import IS_WINDOWS, MAX_FRAME, DELIVERY_OPS, AgentError, dumps, private_dir, read_frame, close_writer
from .runtime import Runtime
from .schema import validate_op
from . import PROTOCOL_VERSION, RUNTIME_REVISION

IDLE_SHUTDOWN_SECONDS = 30
PASSIVE_OPS = frozenset(
    {"ping", "doctor", "pi_watch", "pi_claim", "pi_observe", "pi_release", "pi_uncertain", "pi_detach"}
)


async def serve(home: Path):
    if not (sys.platform.startswith("linux") or IS_WINDOWS):
        raise AgentError("unsupported_platform", "Version 0.1 supports Linux/WSL2 and Windows")
    private_dir(home)
    fd = os.open(home / "daemon.lock", os.O_RDWR | os.O_CREAT, 0o600)
    if not locks.try_lock(fd):
        os.close(fd)
        return
    runtime = None
    clients = {}
    operations = set()
    idle_since = None
    try:
        runtime = Runtime(home)
        notifications = runtime.parent_notifications  # One idle-drain fact for admission and watchers.

        def begin_shutdown():
            # Synchronous: callers must close admission before yielding their idle snapshot.
            notifications.draining = True
            server.close()
            runtime.notify()
            runtime.shutdown_requested.set()

        async def handle(reader, writer):
            nonlocal idle_since
            current = asyncio.current_task()
            clients[current] = None
            job = None
            disconnected = None
            reservation = None
            delivered = None
            op = None
            try:
                try:
                    ipc.check_peer(writer)
                    req = await asyncio.wait_for(read_frame(reader), 10)
                    if not isinstance(req, dict):
                        raise AgentError("invalid_request", "Expected an object")
                    if req.get("v") != PROTOCOL_VERSION:
                        raise AgentError(
                            "version_mismatch", "Client/daemon protocol versions differ; drain and restart the daemon"
                        )
                    op = req.get("op")
                    params = req.get("params", {})
                    validate_op(op, params)
                    if notifications.draining:
                        raise AgentError(
                            "daemon_idle", "Idle daemon stopped admission before dispatch; reconnect when needed"
                        )
                    clients[current] = op
                    if op not in PASSIVE_OPS:
                        idle_since = None
                    source = req.get("source")
                    if source is not None:
                        # Trusted-adapter channel: never model arguments or logs.
                        if not isinstance(source, dict) or not isinstance(source.get("env"), dict):
                            raise AgentError("invalid_request", "source must be an object with an env object")
                        env = source["env"]
                        if len(env) > 64 or any(
                            not isinstance(k, str) or len(k) > 128 or not isinstance(v, str) or len(v) > 16384
                            for k, v in env.items()
                        ):
                            raise AgentError("invalid_request", "source env snapshot exceeds bounds")
                    track_delivery = op in DELIVERY_OPS and req.get("delivery_receipt") is True
                    if track_delivery:
                        reservation = runtime.parent_notifications.reserve_delivery(op, params, source)
                    async def execute():
                        if op != "shutdown" or not params.get("if_idle"):
                            return await runtime.dispatch(op, params, source)
                        if params["expected_pid"] != os.getpid() or params["runtime_revision"] != RUNTIME_REVISION:
                            raise AgentError("daemon_changed", "Daemon identity changed before idle handoff")
                        if not runtime.can_idle_shutdown() or any(
                            task is not current and (other is None or other not in PASSIVE_OPS)
                            for task, other in clients.items()
                        ):
                            raise AgentError("daemon_busy", "Owned work or an admitted operation prevents idle handoff")
                        # No await between checking owned work and closing admission.
                        # Unknown detached writers remain quarantined, not reaped.
                        begin_shutdown()
                        return {"shutdown": "requested", "pid": os.getpid()}

                    job = asyncio.create_task(execute())
                    operations.add(job)
                    job.add_done_callback(operations.discard)
                    if op == "wait":
                        disconnected = asyncio.create_task(reader.read(1))
                        done, _ = await asyncio.wait({job, disconnected}, return_when=asyncio.FIRST_COMPLETED)
                        if disconnected in done and not job.done():
                            job.cancel()
                            await asyncio.gather(job, return_exceptions=True)
                            return
                        disconnected.cancel()
                        await asyncio.gather(disconnected, return_exceptions=True)
                    value = await asyncio.shield(job)
                    if track_delivery:
                        runtime.parent_notifications.prepare_delivery(reservation, op, value)
                    reply = {"ok": True, "result": value}
                except AgentError as e:
                    reply = {"ok": False, "error": e.as_dict()}
                except (json.JSONDecodeError, UnicodeDecodeError):
                    reply = {"ok": False, "error": {"code": "invalid_json", "message": "Invalid JSON request"}}
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    print(f"IPC operation failed: {type(e).__name__}: {e}", file=sys.stderr)
                    reply = {
                        "ok": False,
                        "error": {
                            "code": "internal_error",
                            "message": "Runtime failure. Inspect the ledger before retrying.",
                        },
                    }
                async with asyncio.timeout(10):
                    writer.write((dumps(reply) + "\n").encode())
                    await writer.drain()
                    if reply["ok"] and track_delivery:
                        receipt = await read_frame(reader)
                        if receipt == {"received": True}:
                            delivered = value
            except (OSError, asyncio.TimeoutError, ValueError):
                pass  # No delivery receipt: pending attention becomes eligible again.
            finally:
                if disconnected:
                    disconnected.cancel()
                runtime.parent_notifications.release_delivery(reservation)
                try:
                    await close_writer(writer)
                finally:
                    clients.pop(current, None)

        server = await ipc.serve(handle, home, limit=MAX_FRAME)
        loop = asyncio.get_running_loop()
        # Console-less Windows daemons stop through shutdown or idle drain.
        if not IS_WINDOWS:
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, runtime.shutdown_requested.set)
        runtime.notify()  # Deliver durable pending attention, including restart reconciliation.

        async def monitor():
            nonlocal idle_since
            while not runtime.closing:
                await asyncio.sleep(0.5)
                await runtime.check_idle()
                # Undecoded connections defer admission close below, but do
                # not turn passive traffic into activity that renews the grace.
                if not runtime.can_idle_shutdown() or any(
                    op is not None and op not in PASSIVE_OPS for op in clients.values()
                ):
                    idle_since = None
                    continue
                stamp = loop.time()
                if idle_since is None:
                    idle_since = stamp
                if stamp - idle_since < IDLE_SHUTDOWN_SECONDS:
                    continue
                # Passive status queries do not refresh the grace period, but
                # even their replies must finish before admission is closed.
                if any(op != "pi_watch" for op in clients.values()):
                    continue
                # No await between the final check and closing admission: a
                # newly admitted mutation can never race a zero-work snapshot.
                begin_shutdown()
                return

        watchdog = asyncio.create_task(monitor())
        async with server:
            await runtime.shutdown_requested.wait()
        # New mutations stop at socket close. Give admitted operations a bounded drain window.
        if operations:
            _, pending = await asyncio.wait(operations, timeout=35)
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        watchdog.cancel()
        await asyncio.gather(watchdog, return_exceptions=True)
        await runtime.shutdown()
        for t in list(clients):
            t.cancel()
    finally:
        ipc.remove(home)
        locks.unlock(fd)
        os.close(fd)
