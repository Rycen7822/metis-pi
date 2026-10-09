"""Real Pi-host stdio against a controlled local IPC peer; no child/model launch."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from paths import ROOT
from subagent_pi import RUNTIME_REVISION
from subagent_pi.common import dumps, read_frame, socket_path

class PiHostContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='subagent-pi-host-')
        self.home=Path(self.tmp.name); self.revision=RUNTIME_REVISION; self.calls=[]; self.peers=[]; self.jobs=[]; self.spawn_mode=None
        self.sock=socket_path(self.home)
        async def handle(reader,writer):
            self.peers.append(writer)
            try:
                frame=await read_frame(reader); op=frame['op']; self.calls.append((op,frame['params']))
                if op=='ping': result={'pi_host':1,'runtime_revision':self.revision}
                elif op=='scope_open': result={'scope':'scope_host_test'}
                elif op=='pi_watch' and self.spawn_mode=='lost':
                    self.server.close(); return
                elif op=='spawn':
                    if self.spawn_mode=='lost': return
                    if self.spawn_mode=='idle':
                        self.spawn_mode=None
                        writer.write((dumps({'ok':False,'error':{'code':'daemon_idle','message':'not admitted'}})+'\n').encode())
                        await writer.drain(); return
                    result={'agent_id':'pi_host_test','run_id':'run_host_test'}
                else: result={}
                writer.write((dumps({'ok':True,'result':result})+'\n').encode()); await writer.drain()
            finally:
                writer.close(); await writer.wait_closed()
        def connected(reader,writer): self.jobs.append(asyncio.create_task(handle(reader,writer)))
        self.server=await asyncio.start_unix_server(connected,str(self.sock))
        self.proc=await asyncio.create_subprocess_exec(sys.executable,str(ROOT/'bin/subagent-pi'),'--home',str(self.home),'pi-host',
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        self.rid=0
        self.addAsyncCleanup(self.cleanup)
        source={'env':{},'parent':{'kind':'pi','session_id':'host-test','agent_dir':str(self.home),'session_file':'',
            'sdk_path':str(self.home/'index.js'),'node_path':sys.executable,'lease':'lease_host_test','model':None}}
        initialized=await self.call('initialize',{'cwd':str(self.home)},source=source)
        self.assertTrue(initialized['ok'],initialized)

    async def cleanup(self):
        self.proc.stdin.close()
        try: await asyncio.wait_for(self.proc.wait(),5)
        except asyncio.TimeoutError: self.proc.kill(); await self.proc.wait()
        self.assertEqual(self.proc.returncode,0,(await self.proc.stderr.read()).decode())
        self.server.close(); await self.server.wait_closed()
        for peer in self.peers: peer.close()
        await asyncio.gather(*self.jobs,return_exceptions=True)
        self.sock.unlink(missing_ok=True); self.tmp.cleanup()

    async def call(self,op,p,**extra):
        self.rid+=1
        self.proc.stdin.write((dumps({'id':str(self.rid),'operation':op,'params':p,**extra})+'\n').encode()); await self.proc.stdin.drain()
        frame=json.loads(await asyncio.wait_for(self.proc.stdout.readline(),5))
        self.assertEqual(frame['id'],str(self.rid)); return frame

    async def test_live_revision_is_checked_again_before_each_explicit_operation(self):
        self.revision='controlled-old-source'
        result=await self.call('pi_spawn_agent',{'task':'must not dispatch','access':'read','request_id':'version-guard'})
        self.assertFalse(result['ok']); self.assertEqual(result['error']['code'],'version_mismatch')
        self.assertEqual([op for op,_ in self.calls].count('spawn'),0)
        self.assertIn('Background work has not been interrupted',result['error']['message'])

    async def test_unknown_mutation_reply_is_not_retried(self):
        self.spawn_mode='lost'
        result=await self.call('pi_spawn_agent',{'task':'uncertain','access':'read','request_id':'unknown-mutation'})
        self.assertFalse(result['ok']); self.assertEqual(result['error']['code'],'connection_lost')
        self.assertEqual([op for op,_ in self.calls].count('spawn'),1)
        watched=await self.call('pi_watch',{},passive=True)
        self.assertEqual(watched['error']['code'],'connection_lost','disappearance after dispatch is not proof of normal idle')

    async def test_known_pre_admission_idle_rejection_reuses_the_original_operation(self):
        self.spawn_mode='idle'
        result=await self.call('pi_spawn_agent',{'task':'safe retry','access':'read','request_id':'same-operation'})
        self.assertTrue(result['ok'],result)
        attempts=[p for op,p in self.calls if op=='spawn']
        self.assertEqual(len(attempts),2); self.assertEqual(attempts[0],attempts[1])
        self.assertEqual(attempts[0]['request_id'],'same-operation')

    async def test_passive_call_to_an_absent_daemon_does_not_autostart(self):
        self.server.close(); await self.server.wait_closed(); self.sock.unlink()
        result=await self.call('pi_watch',{},passive=True)
        self.assertFalse(result['ok']); self.assertEqual(result['error']['code'],'daemon_idle')
        self.assertFalse((self.home/'daemon.lock').exists(),'no daemon starter ran')
