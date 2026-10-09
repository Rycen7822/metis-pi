"""Real isolated daemon admission/parking and demand-start contracts; fake Pi only."""
import asyncio
import contextlib
import sys
import unittest
from test_transport import McpHarness
from subagent_pi.client import request
from subagent_pi import PROTOCOL_VERSION
from subagent_pi.common import AgentError, dumps, socket_path

class DaemonIdleTests(McpHarness, unittest.IsolatedAsyncioTestCase):
    async def parked(self, proc, timeout=15):
        end=asyncio.get_running_loop().time()+timeout
        while proc.poll() is None and asyncio.get_running_loop().time()<end:
            await asyncio.sleep(.05)
        self.assertEqual(proc.poll(),0,'owned idle daemon exited normally')
        with self.assertRaises(AgentError) as caught: await request(self.home,'ping',{},autostart=False)
        self.assertEqual(caught.exception.code,'daemon_unavailable')

    async def test_empty_daemon_exits_despite_passive_watch_and_preserves_scope(self):
        source={'env':{},'parent':{'kind':'pi','session_id':'idle-watch','agent_dir':str(self.root),'session_file':'',
            'sdk_path':str(self.root/'index.js'),'node_path':sys.executable,'lease':'lease_idle_watch','model':None}}
        sid=(await request(self.home,'scope_open',{'cwd':str(self.workspace)},source=source))['scope']
        proc=self.daemons[-1]
        first=await request(self.home,'pi_watch',{'scope':sid},autostart=False,source=source)
        watching=asyncio.create_task(request(self.home,'pi_watch',{'scope':sid,'after':first['cursor']},timeout=15,autostart=False,source=source))
        await asyncio.sleep(4)
        refreshed=asyncio.get_running_loop().time()
        await request(self.home,'scope_open',{'cwd':str(self.workspace),'scope':sid},source=source,autostart=False)
        with self.assertRaises(AgentError) as caught: await asyncio.wait_for(watching,15)
        self.assertEqual(caught.exception.code,'daemon_idle')
        self.assertGreaterEqual(asyncio.get_running_loop().time()-refreshed,4.9,'a short admitted operation starts a fresh full quiet grace')
        await self.parked(proc)
        self.assertEqual(len(self.daemons),1,'passive watch did not respawn a daemon')
        restored=await request(self.home,'scope_open',{'scope':sid,'cwd':str(self.workspace)},source=source)
        self.assertEqual(restored['scope'],sid)
        self.assertNotEqual(self.daemons[-1].pid,proc.pid)

    async def test_live_work_survives_parent_disconnect_then_followup_wakes_same_history(self):
        sid=await self.open_scope(); proc=self.daemons[-1]
        gate=self.root/'release-task'
        run=await self.spawn(sid,f'gate={gate}|durable original')
        # No parent connection exists during this interval, longer than the
        # real production grace. Active work must still own its background.
        await asyncio.sleep(6)
        self.assertIsNone(proc.poll())
        self.assertEqual((await request(self.home,'ping',{},autostart=False))['pid'],proc.pid)
        gate.touch()
        waited=await request(self.home,'wait',{'scope':sid,'run_ids':[run['run_id']],'timeout_seconds':8})
        self.assertEqual(waited['runs'][0]['state'],'completed')
        original=await request(self.home,'result',{'scope':sid,'run_id':run['run_id']})
        await self.parked(proc)
        follow=await request(self.home,'followup',{'scope':sid,'agent_id':run['agent_id'],'request_id':'wake-followup','message':'second task'})
        self.assertEqual(follow['agent_id'],run['agent_id']); self.assertNotEqual(follow['run_id'],run['run_id'])
        self.assertNotEqual(self.daemons[-1].pid,proc.pid)
        done=await request(self.home,'wait',{'scope':sid,'run_ids':[follow['run_id']],'timeout_seconds':8})
        self.assertEqual(done['runs'][0]['state'],'completed')
        reread=await request(self.home,'result',{'scope':sid,'run_id':run['run_id']})
        self.assertEqual(reread['result_sha256'],original['result_sha256'])

    async def test_disconnected_admitted_spawn_blocks_idle_admission_close(self):
        # Pause an admitted mutation before any run/worker exists, then close
        # its caller. The daemon still owns that operation, not the connection.
        from paths import ROOT
        gate=self.root/'release-admitted'; params=None; writer=None
        script="""
import asyncio,sys
from pathlib import Path
from subagent_pi import daemon
original=daemon.Runtime.dispatch
async def dispatch(self,op,p,source=None):
    if op=='spawn':
        print('SPAWN_ADMITTED',flush=True)
        while not Path(sys.argv[2]).exists(): await asyncio.sleep(.01)
    return await original(self,op,p,source)
daemon.Runtime.dispatch=dispatch
asyncio.run(daemon.serve(Path(sys.argv[1])))
"""
        proc=await asyncio.create_subprocess_exec(sys.executable,'-c',script,str(self.home),str(gate),cwd=ROOT,
            stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        try:
            end=asyncio.get_running_loop().time()+5
            while True:
                try:
                    ready=await request(self.home,'ping',{},autostart=False)
                    self.assertEqual(ready['pid'],proc.pid); break
                except AgentError as exc:
                    if exc.code!='daemon_unavailable' or asyncio.get_running_loop().time()>=end: raise
                    await asyncio.sleep(.01)
            sid=(await request(self.home,'scope_open',{'cwd':str(self.workspace)},autostart=False))['scope']
            params={'scope':sid,'task':'detached caller work','access':'read','request_id':'detached-admission'}
            _,writer=await asyncio.open_unix_connection(str(socket_path(self.home)))
            writer.write((dumps({'v':PROTOCOL_VERSION,'op':'spawn','params':params})+'\n').encode()); await writer.drain()
            self.assertEqual(await asyncio.wait_for(proc.stdout.readline(),5),b'SPAWN_ADMITTED\n')
            writer.close(); await writer.wait_closed(); writer=None
            await asyncio.sleep(6)
            self.assertEqual((await request(self.home,'ping',{},autostart=False))['pid'],proc.pid,'admitted detached operation keeps admission open')
            gate.touch()
            # Explicitly retransmit the same key, not an automatic/new mutation.
            started=await request(self.home,'spawn',params,autostart=False)
            done=await request(self.home,'wait',{'scope':sid,'run_ids':[started['run_id']],'timeout_seconds':8},autostart=False)
            self.assertEqual(done['runs'][0]['state'],'completed','idle shutdown did not interrupt accepted work')
        finally:
            gate.touch()
            if writer: writer.close()
            with contextlib.suppress(AgentError): await request(self.home,'shutdown',{'force':True},autostart=False)
            try: await asyncio.wait_for(proc.wait(),15)
            except asyncio.TimeoutError: proc.terminate(); await asyncio.wait_for(proc.wait(),15)
            self.assertEqual(proc.returncode,0,(await proc.stderr.read()).decode())

    async def test_autostart_waits_for_a_draining_daemon_lock(self):
        # Model the real socket-close / verified-cleanup gap without touching
        # another process: no replacement may be spawned until the lock is free.
        import fcntl
        with (self.home/'daemon.lock').open('a+b') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            pending=asyncio.create_task(request(self.home,'ping',{},timeout=5))
            await asyncio.sleep(.2)
            self.assertFalse(pending.done()); self.assertEqual(self.daemons,[])
            fcntl.flock(lock,fcntl.LOCK_UN)
            result=await pending
        self.assertEqual(result['pid'],self.daemons[0].pid)
