"""Shared isolated protocol fixture; production has no executable override."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
from paths import TEST_ROOT
from metis_subagent.runtime import Runtime
from metis_subagent.config import launch_spec as native_launch_spec
from metis_subagent.common import python_executable


class RuntimeHarness:
    async def idle_loop(self):
        while not self.rt.closing:
            await asyncio.sleep(0.5)
            await self.rt.check_idle()

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='metis-subagent-test-')
        self.root = Path(self.tmp.name)
        self.home = self.root/'state'; self.home.mkdir()
        self.workspace = self.root/'workspace'; self.workspace.mkdir()
        self.fake = TEST_ROOT/'fake_pi.py'
        self.command = [python_executable(),str(self.fake)]
        config = self.root/'metis-pi.toml'
        config.write_text('[subagents]\nrpcTimeoutSeconds=8\nstartupTimeoutSeconds=10\n')
        self.enterContext(patch.dict(os.environ,{'METIS_PI_CONFIG':str(config)}))
        def launch(*args,**kwargs):
            spec = native_launch_spec(*args,**kwargs)
            spec['argv'] = [*self.command,*spec['argv'][2:]]
            spec.pop('sdk_path',None)
            spec['host'] = 'fixture'
            return spec
        self.enterContext(patch('metis_subagent.runtime.launch_spec',side_effect=launch))
        self.source = {'env':{'PATH':os.environ['PATH'],'HOME':str(self.root)},'parent':{
            'kind':'pi','session_id':'fixture','agent_dir':str(self.root),'session_file':'',
            'sdk_path':str(self.root/'index.js'),'node_path':sys.executable,'lease':'fixture_parent',
            'model':{'provider':'offline','id':'fixture'}}}
        self.rt = Runtime(self.home)
        original = self.rt.dispatch
        async def dispatch(op,p,source=None):
            return await original(op,p,{**self.source,**(source or {})})
        self.rt.dispatch = dispatch
        self.scope = (await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)}))['scope']
        self.n = 0

    async def asyncTearDown(self):
        await self.rt.shutdown()
        self.tmp.cleanup()

    def key(self):
        self.n += 1
        return 'request-'+str(self.n)

    async def spawn(self,task='simple',**extra):
        return await self.rt.dispatch('spawn',{'scope':self.scope,'request_id':self.key(),
            'cwd':str(self.workspace),'task':task,'access':'read',**extra})

    async def mutation(self,op,aid,**extra):
        return await self.rt.dispatch(op,{'scope':self.scope,'agent_id':aid,'request_id':self.key(),**extra})

    async def wait(self,rid):
        return await self.rt.dispatch('wait',{'scope':self.scope,'run_ids':[rid],'mode':'all','timeout_seconds':4})

    async def result(self,rid,**extra):
        return await self.rt.dispatch('result',{'scope':self.scope,'run_id':rid,**extra})

    async def until(self,probe,timeout=8.0):
        loop = asyncio.get_running_loop(); end = loop.time()+timeout
        while loop.time()<end:
            value = probe()
            if value: return value
            await asyncio.sleep(.01)
        raise AssertionError(f'condition not reached within {timeout}s')

    def events(self,aid,kind):
        return self.rt.store.all('SELECT payload FROM events WHERE agent_id=? AND type=? ORDER BY created',(aid,kind))
