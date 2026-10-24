"""Bounded JSON-line stdio for the Pi host."""
import asyncio
import os
import sys
import threading
from .common import IS_WINDOWS, MAX_FRAME, dumps


class OutputClosed(Exception):
    """A partial/failed frame retires the connection instead of being replayed."""


def _in_thread(function, *args):
    """A blocking pipe operation must not hold up executor shutdown on exit."""
    loop = asyncio.get_running_loop()
    done = loop.create_future()
    def finish(value, error):
        if not done.done():
            if error is None: done.set_result(value)
            else: done.set_exception(error)
    def run():
        try: result = (function(*args), None)
        except BaseException as exc: result = (None, exc)
        try: loop.call_soon_threadsafe(finish, *result)
        except RuntimeError: pass  # The retired connection's loop has closed.
    threading.Thread(target=run, daemon=True).start()
    return done


class ThreadReader:
    """One bounded read at a time over Node's synchronous Windows stdin pipe."""

    def __init__(self, fd, limit):
        self.fd, self.limit = fd, limit
        self.buffer = bytearray()
        self.pending = None
        self.eof = False

    def _readline(self):
        while True:
            end = self.buffer.find(b"\n") + 1
            if (end or len(self.buffer)) > self.limit:
                raise ValueError("JSONL record exceeds transport limit")
            if end:
                line = bytes(self.buffer[:end])
                del self.buffer[:end]
                return line
            chunk = os.read(self.fd, 65536)
            if not chunk:
                line = bytes(self.buffer)
                self.buffer.clear()
                return line
            self.buffer += chunk

    async def readline(self):
        if self.eof: return b""
        if self.pending is None:
            self.pending = _in_thread(self._readline)
        # Cancellation stops waiting, not the read: the next await gets that line.
        line = await asyncio.shield(self.pending)
        self.pending = None
        if not line: self.eof = True
        return line

    def feed_eof(self):
        self.eof = True
        if self.pending is not None and not self.pending.done():
            self.pending.set_result(b"")


class Stdio:
    async def open(self):
        self.loop=asyncio.get_running_loop()
        self.fd=sys.stdout.fileno()
        self.lock=asyncio.Lock(); self.closed=False
        if IS_WINDOWS:
            self.reader=ThreadReader(sys.stdin.fileno(),MAX_FRAME)
        else:
            self.reader=asyncio.StreamReader(limit=MAX_FRAME)
            self.transport,_=await self.loop.connect_read_pipe(lambda:asyncio.StreamReaderProtocol(self.reader),sys.stdin.buffer)
            self.was_blocking=os.get_blocking(self.fd)
            os.set_blocking(self.fd,False)
        return self

    async def output(self,value,timeout=45):
        async with self.lock:
            if self.closed: raise OutputClosed()
            data=memoryview((dumps(value)+'\n').encode())
            try:
                if len(data)>MAX_FRAME: raise ValueError('Output frame exceeds protocol limit')
                async with asyncio.timeout(timeout):
                    if IS_WINDOWS:
                        await _in_thread(self._write_blocking,data)
                    else:
                        await self._write_nonblocking(data)
            except (OSError,ValueError,TimeoutError,asyncio.CancelledError) as exc:
                self.closed=True; self.reader.feed_eof()
                if not IS_WINDOWS: self.transport.close()
                if isinstance(exc,asyncio.CancelledError): raise
                raise OutputClosed() from exc

    async def _write_nonblocking(self,data):
        while data:
            try: data=data[os.write(self.fd,data):]
            except BlockingIOError:
                ready=self.loop.create_future()
                def writable():
                    if not ready.done(): ready.set_result(None)
                self.loop.add_writer(self.fd,writable)
                try: await ready
                finally: self.loop.remove_writer(self.fd)

    def _write_blocking(self,data):
        # A timed-out write retires the entire bridge; this fd is never reused
        # for another connection, even if the daemon thread finishes late.
        while data:
            data=data[os.write(self.fd,data):]

    def close(self):
        if not IS_WINDOWS:
            self.transport.close()
            os.set_blocking(self.fd,self.was_blocking)
        self.reader.feed_eof()
