"""Shared isolated fake-Pi fixture; contains no discoverable test cases."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
from paths import ROOT, TEST_ROOT, REPO_ROOT
from subagent_pi.runtime import Runtime


class RuntimeHarness:
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='subagent-pi-test-')
        self.root=Path(self.tmp.name); self.home=self.root/'state'; self.home.mkdir()
        self.workspace=self.root/'workspace'; self.workspace.mkdir()
        self.fake=TEST_ROOT/'fake_pi.py'
        (self.home / "config.toml").write_text(
            "pi_command = "
            + json.dumps([sys.executable, str(self.fake)])
            + "\nrpc_timeout_seconds = 8\nstartup_timeout_seconds = 10\n[inheritance]\nenabled = false\n"
        )
        self.rt=Runtime(self.home)
        self.scope=(await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)}))['scope']
        self.n=0
    async def asyncTearDown(self):
        await self.rt.shutdown()
        self.tmp.cleanup()
    def key(self):
        self.n+=1; return 'request-'+str(self.n)
    async def spawn(self,task='simple',**extra):
        p={'scope':self.scope,'request_id':self.key(),'cwd':str(self.workspace),'task':task,'access':'read',**extra}
        return await self.rt.dispatch('spawn',p)
    async def mutation(self,op,aid,**extra):
        return await self.rt.dispatch(op,{'scope':self.scope,'agent_id':aid,'request_id':self.key(),**extra})
    async def wait(self,rid):
        return await self.rt.dispatch('wait',{'scope':self.scope,'run_ids':[rid],'mode':'all','timeout_seconds':4})
    async def result(self,rid,**extra):
        return await self.rt.dispatch('result',{'scope':self.scope,'run_id':rid,**extra})
    async def until(self,probe,timeout=8.0):
        # Bounded event/state sync point; never a fixed short sleep.
        loop=asyncio.get_running_loop(); end=loop.time()+timeout
        while loop.time()<end:
            value=probe()
            if value: return value
            await asyncio.sleep(.01)
        raise AssertionError(f'condition not reached within {timeout}s')
    def events(self,aid,kind):
        return self.rt.store.all('SELECT payload FROM events WHERE agent_id=? AND type=? ORDER BY created',(aid,kind))
