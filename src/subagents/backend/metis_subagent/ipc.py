"""One local IPC transport for both hosts.

POSIX keeps the AF_UNIX socket the daemon always used. Windows uses byte-mode
named pipes: the same JSONL frames over the same StreamReader/StreamWriter API,
a DACL admitting only this user (and SYSTEM), and an independent check of the
peer's real token SID in both directions.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
import socket
import struct

from .common import IS_WINDOWS, MAX_FRAME, AgentError, socket_path
if IS_WINDOWS:
    from . import windows

PIPE_PREFIX = r"\\.\pipe\metis-subagent-"


def address(home: Path):
    """The connectable address for a state directory."""
    if not IS_WINDOWS:
        return socket_path(home)
    return PIPE_PREFIX + hashlib.sha256(str(home).encode()).hexdigest()[:24]


def remove(home: Path):
    """Drop the address after the daemon closed it (named pipes have no path)."""
    if not IS_WINDOWS:
        Path(address(home)).unlink(missing_ok=True)


def exists(home: Path) -> bool:
    """Whether a daemon address currently exists."""
    if not IS_WINDOWS:
        return Path(address(home)).exists()
    return windows.pipe_exists(address(home))


def peer_pid(writer):
    """PID of the process on the other end of this connection, or None."""
    if IS_WINDOWS:
        handle = writer.get_extra_info("pipe")
        return windows.named_pipe_client_pid(handle) if handle is not None else None
    peer = writer.get_extra_info("socket")
    if hasattr(socket, "SO_PEERCRED"):
        # struct ucred is {pid, uid, gid}: the FIRST field is the peer PID.
        pid, _, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return pid
    return None


def check_peer(writer):
    """Reject a local peer whose real OS identity is not this user's. The DACL is
    the barrier; this verifies the process behind the handle, not a name."""
    if not IS_WINDOWS:
        peer = writer.get_extra_info("socket")
        if hasattr(socket, "SO_PEERCRED"):
            _, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                raise AgentError("permission_denied", "IPC peer belongs to another user")
        return
    pid = peer_pid(writer)
    if pid is None:
        raise AgentError("permission_denied", "Cannot identify the IPC peer")
    try:
        sid = windows.process_sid(pid)
    except (OSError, ProcessLookupError):
        raise AgentError("permission_denied", "Cannot identify the IPC peer") from None
    if sid != windows.current_user_sid():
        raise AgentError("permission_denied", "IPC peer belongs to another user")


async def connect(home: Path, limit: int = MAX_FRAME):
    """Client side: (reader, writer) for a running daemon."""
    if not IS_WINDOWS:
        return await asyncio.open_unix_connection(str(address(home)), limit=limit)
    loop = asyncio.get_running_loop()
    handle = await asyncio.to_thread(windows.connect_pipe, address(home))
    reader = asyncio.StreamReader(limit=limit)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport = loop._make_duplex_pipe_transport(handle, protocol, extra={"pipe": handle})
    writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    try:
        pid = windows.named_pipe_server_pid(handle)
        if pid is None or windows.process_sid(pid) != windows.current_user_sid():
            raise PermissionError(0, "IPC server belongs to another user")
    except BaseException:
        transport.abort()
        raise
    return reader, writer


class PipeServer:
    """The asyncio.Server surface the daemon uses, for one byte-mode pipe."""

    def __init__(self, name, handler, limit):
        self.name, self.handler, self.limit = name, handler, limit
        self.closed = False
        self._listening = None
        self._accept = None

    async def start(self):
        self._listening = windows.create_pipe_instance(self.name, first=True)
        self._accept = asyncio.create_task(self._accept_loop())
        return self

    def _next_instance(self):
        if self.closed:
            return None
        try:
            return windows.create_pipe_instance(self.name, first=False)
        except OSError:
            return None

    async def _accept_loop(self):
        loop = asyncio.get_running_loop()
        while not self.closed and self._listening is not None:
            handle, self._listening = self._listening, None
            try:
                await loop._proactor.accept_pipe(handle)
            except asyncio.CancelledError:
                handle.close()
                raise
            except OSError:
                handle.close()
                self._listening = self._next_instance()
                continue
            # Keep one instance listening before this connection is dispatched.
            self._listening = self._next_instance()
            try:
                pid = windows.named_pipe_client_pid(handle)
                if pid is None or windows.process_sid(pid) != windows.current_user_sid():
                    raise AgentError("permission_denied", "IPC peer belongs to another user")
            except (AgentError, OSError, ProcessLookupError):
                handle.close()
                continue
            reader = asyncio.StreamReader(limit=self.limit)
            protocol = asyncio.StreamReaderProtocol(reader)
            transport = loop._make_duplex_pipe_transport(handle, protocol, extra={"pipe": handle})
            # asyncio server handlers may be sync (they schedule their own task).
            result = self.handler(reader, asyncio.StreamWriter(transport, protocol, reader, loop))
            if asyncio.iscoroutine(result):
                asyncio.create_task(result)

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self._accept is not None:
            self._accept.cancel()
        if self._listening is not None:
            self._listening.close()
            self._listening = None

    async def wait_closed(self):
        if self._accept is not None:
            try:
                await self._accept
            except (asyncio.CancelledError, OSError):
                pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.close()
        await self.wait_closed()


async def serve(handler, home: Path, limit: int = MAX_FRAME):
    """Server side: an object with close()/wait_closed()/async-with."""
    if not IS_WINDOWS:
        remove(home)
        server = await asyncio.start_unix_server(handler, str(address(home)), limit=limit)
        os.chmod(address(home), 0o600)
        return server
    return await PipeServer(address(home), handler, limit).start()
