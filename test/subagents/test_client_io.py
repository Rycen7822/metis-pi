"""Local IPC deadlines over real backpressured Unix sockets; no Pi or daemon."""
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from paths import ROOT, TEST_ROOT, REPO_ROOT
from subagent_pi.client import request
from subagent_pi.common import AgentError, dumps, read_frame, socket_path

class ClientIO(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='subagent-client-')
        self.home=Path(self.tmp.name); self.peers=[]; self.jobs=[]
        self.accepted=asyncio.Event(); self.handler=None
        self.server=await asyncio.start_unix_server(self.connected,str(socket_path(self.home)))
    def connected(self,reader,writer):
        self.peers.append(writer); self.accepted.set()
        if self.handler: self.jobs.append(asyncio.create_task(self.handler(reader,writer)))
        else: writer.transport.pause_reading()
    async def asyncTearDown(self):
        for peer in self.peers: peer.transport.abort()
        for job in self.jobs: job.cancel()
        await asyncio.gather(*self.jobs,return_exceptions=True)
        self.server.close(); await self.server.wait_closed()
        self.tmp.cleanup()
    def blocked_request(self,timeout):
        # Legal env snapshot size, enough to exceed a Unix socket's send buffer.
        return asyncio.create_task(request(self.home,'scope_open',{},timeout=timeout,autostart=False,
            source={'env':{f'TEST_{i}':'x'*16000 for i in range(40)}}))
    async def finish_task(self,task):
        for peer in self.peers: peer.transport.abort()
        task.cancel(); await asyncio.gather(task,return_exceptions=True)
    async def test_deadline_includes_request_drain_and_close(self):
        task=self.blocked_request(.1)
        try:
            done,_=await asyncio.wait({task},timeout=1.5)
            self.assertIn(task,done,'request drain or close escaped its deadline')
            with self.assertRaises(AgentError) as caught: await task
            self.assertEqual(caught.exception.code,'client_timeout')
        finally: await self.finish_task(task)
    async def test_cancelling_a_blocked_write_also_bounds_close(self):
        task=self.blocked_request(60)
        try:
            await self.accepted.wait()
            task.cancel()
            done,_=await asyncio.wait({task},timeout=1.5)
            self.assertIn(task,done,'cancelled request is stuck flushing its socket')
            with self.assertRaises(asyncio.CancelledError): await task
        finally: await self.finish_task(task)
    async def test_successful_delivery_confirms_after_output(self):
        receipts=[]; output=[]
        async def handler(reader,writer):
            frame=await read_frame(reader)
            self.assertTrue(frame['delivery_receipt'])
            writer.write((dumps({'ok':True,'result':{'runs':[]}})+'\n').encode()); await writer.drain()
            receipt=await read_frame(reader)
            receipts.append((len(output),receipt))
        self.handler=handler
        async def deliver(value): output.append(value)
        for op in ('wait','result','inspect','soft_interrupt'):
            with self.subTest(op=op):
                result=await request(self.home,op,{},timeout=1,autostart=False,on_result=deliver)
                self.assertEqual(output[-1],result)
                async with asyncio.timeout(1):
                    while len(receipts)<len(output): await asyncio.sleep(.01)
                self.assertEqual(receipts[-1],(len(output),{'received':True}))
    async def test_receipt_timeout_after_output_does_not_replace_success(self):
        # Tiny receipts do not normally fill a kernel buffer. Stall just that
        # drain to exercise the post-delivery deadline deterministically.
        async def handler(reader,writer):
            await read_frame(reader)
            writer.write(b'{"ok":true,"result":{"runs":[]}}\n'); await writer.drain()
        self.handler=handler
        connect=asyncio.open_unix_connection; delivered=[]
        async def wrapped_connect(*args,**kwargs):
            reader,writer=await connect(*args,**kwargs)
            drain=writer.drain
            async def blocked_receipt():
                if delivered: await asyncio.Event().wait()
                await drain()
            writer.drain=blocked_receipt
            return reader,writer
        async def deliver(value): delivered.append(value)
        with mock.patch('subagent_pi.client.asyncio.open_unix_connection',wrapped_connect):
            task=asyncio.create_task(request(self.home,'wait',{},timeout=.1,autostart=False,on_result=deliver))
            try:
                done,_=await asyncio.wait({task},timeout=1.5)
                self.assertIn(task,done,'receipt drain is unbounded')
                self.assertEqual(await task,{'runs':[]})
                self.assertEqual(delivered,[{'runs':[]}])
            finally: await self.finish_task(task)

class DaemonReplyIO(unittest.IsolatedAsyncioTestCase):
    async def test_unread_reply_releases_daemon_connection(self):
        # Run the real IPC handler. Only the reply body is enlarged; close is
        # observed after it completes, without replacing the production deadline.
        script="""
import asyncio,sys
from pathlib import Path
from subagent_pi import daemon
original_dispatch=daemon.Runtime.dispatch
async def dispatch(self,op,p,source=None):
    if op=='doctor': return {'blob':'x'*(1024*1024)}
    return await original_dispatch(self,op,p,source)
daemon.Runtime.dispatch=dispatch
original_close=daemon.close_writer
async def close(writer):
    try: await original_close(writer)
    finally: print('REPLY_CLOSED',flush=True)
daemon.close_writer=close
asyncio.run(daemon.serve(Path(sys.argv[1])))
"""
        with tempfile.TemporaryDirectory(prefix='subagent-daemon-io-') as tmp:
            home=Path(tmp); path=socket_path(home)
            proc=await asyncio.create_subprocess_exec(sys.executable,'-c',script,str(home),cwd=ROOT,
                stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            writer=None
            try:
                end=asyncio.get_running_loop().time()+5
                while writer is None:
                    try: reader,writer=await asyncio.open_unix_connection(str(path),limit=1024)
                    except (FileNotFoundError,ConnectionRefusedError):
                        if asyncio.get_running_loop().time()>=end: raise
                        await asyncio.sleep(.01)
                writer.transport.pause_reading()
                from subagent_pi import PROTOCOL_VERSION
                writer.write((dumps({'v':PROTOCOL_VERSION,'op':'doctor','params':{}})+'\n').encode())
                await writer.drain()
                self.assertEqual(await asyncio.wait_for(proc.stdout.readline(),14),b'REPLY_CLOSED\n')
                writer.transport.resume_reading()
                partial=await asyncio.wait_for(reader.read(),2)
                self.assertGreater(len(partial),0)
                self.assertLess(len(partial),1024*1024,'unread reply was not bounded')
                self.assertFalse(partial.endswith(b'\n'))
                try: await request(home,'shutdown',{'force':True},autostart=False)
                except AgentError as exc:
                    # A zero-work daemon may park after the unread reply has
                    # closed. All deadline/partial-output assertions above stay.
                    self.assertIn(exc.code,{'daemon_unavailable','daemon_idle'})
                await asyncio.wait_for(proc.wait(),3)
                self.assertEqual(proc.returncode,0,(await proc.stderr.read()).decode())
            finally:
                if writer: writer.transport.abort()
                if proc.returncode is None: proc.kill()
                await proc.communicate()
