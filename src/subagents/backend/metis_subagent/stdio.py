"""Bounded JSON-line pipes shared by the two host adapters."""
import asyncio
import os
import sys
from .common import MAX_FRAME, dumps

class OutputClosed(Exception):
    """A partial/failed frame retires the connection instead of being replayed."""

class Stdio:
    async def open(self):
        self.reader=asyncio.StreamReader(limit=MAX_FRAME)
        self.loop=asyncio.get_running_loop()
        self.transport,_=await self.loop.connect_read_pipe(lambda:asyncio.StreamReaderProtocol(self.reader),sys.stdin.buffer)
        self.fd=sys.stdout.fileno()
        self.was_blocking=os.get_blocking(self.fd)
        os.set_blocking(self.fd,False)
        self.lock=asyncio.Lock(); self.closed=False
        return self

    async def output(self,value,timeout=45):
        async with self.lock:
            if self.closed: raise OutputClosed()
            data=memoryview((dumps(value)+'\n').encode())
            try:
                if len(data)>MAX_FRAME: raise ValueError('Output frame exceeds protocol limit')
                async with asyncio.timeout(timeout):
                    while data:
                        try: data=data[os.write(self.fd,data):]
                        except BlockingIOError:
                            ready=self.loop.create_future()
                            def writable():
                                if not ready.done(): ready.set_result(None)
                            self.loop.add_writer(self.fd,writable)
                            try: await ready
                            finally: self.loop.remove_writer(self.fd)
            except (OSError,ValueError,TimeoutError,asyncio.CancelledError) as exc:
                self.closed=True; self.transport.close(); self.reader.feed_eof()
                if isinstance(exc,asyncio.CancelledError): raise
                raise OutputClosed() from exc

    def close(self):
        self.transport.close()
        os.set_blocking(self.fd,self.was_blocking)
