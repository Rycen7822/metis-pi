"""Continuing native scope, profile and verified-surface protections.

Migrated from the former inheritance fixture. No Codex source/bridge is read.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock
from paths import ROOT, WORKER_ROOT
from runtime_harness import RuntimeHarness
from test_transport import IpcHarness
from metis_subagent.common import AgentError
from metis_subagent.config import PI_BUILTIN_TOOLS, load_config, launch_spec
from metis_subagent.runtime import Runtime
from metis_subagent.store import Store

SURFACE = WORKER_ROOT/'managed-surface.ts'

class RuntimeSurfaceTests(RuntimeHarness, unittest.IsolatedAsyncioTestCase):
    def events_of(self, aid, kind):
        return [json.loads(r['payload']) for r in self.rt.store.all(
            'SELECT payload FROM events WHERE agent_id=? AND type=? ORDER BY rowid', (aid, kind))]

    def restricted_profile(self, **env):
        """A reader-shaped profile whose extra env controls the fake Pi's surface
        report (the fake stands in for worker/managed-surface.ts)."""
        self.rt.config['profiles']['restricted']={'tools':['read','grep','find','ls'],'env':dict(env)}
        return 'restricted'


    async def test_restricted_launch_records_the_verified_builtin_surface(self):
        s=await self.spawn(profile=self.restricted_profile()); aid=s['agent_id']
        report=self.events_of(aid,'tool_surface')[-1]
        self.assertTrue(report['ok'])
        self.assertEqual(report['allowed'],'find,grep,ls,read')
        self.assertEqual(report['builtins'],'find,grep,ls,read')
        self.assertEqual(report['expected'],report['builtins'])
        await self.mutation('close',aid)


    async def test_missing_surface_report_fails_the_launch(self):
        import metis_subagent.worker as worker_module
        original=worker_module.SURFACE_TIMEOUT_SECONDS
        worker_module.SURFACE_TIMEOUT_SECONDS=0.5
        self.addCleanup(setattr,worker_module,'SURFACE_TIMEOUT_SECONDS',original)
        with self.assertRaises(AgentError) as cm:
            await self.spawn(profile=self.restricted_profile(PI_TEST_SURFACE='missing'))
        self.assertEqual(cm.exception.code,'tool_surface_unavailable')
        aid=cm.exception.details['agent_id']
        report=self.events_of(aid,'tool_surface')[-1]
        self.assertFalse(report['ok']); self.assertEqual(report['reason'],'no-report')
        self.assertEqual(self.rt.store.agent(self.scope,aid)['state'],'crashed')
        self.assertTrue(all(w.closed for w in self.rt.workers.values()))


    async def test_mismatched_surface_report_fails_the_launch(self):
        with self.assertRaises(AgentError) as cm:
            await self.spawn(profile=self.restricted_profile(PI_TEST_SURFACE='mismatch'))
        self.assertEqual(cm.exception.code,'tool_surface_unapplied')
        aid=cm.exception.details['agent_id']
        report=self.events_of(aid,'tool_surface')[-1]
        self.assertFalse(report['ok'])
        self.assertEqual(report['builtins'],'find,grep,ls')
        self.assertEqual(report['expected'],'find,grep,ls,read')
        self.assertTrue(all(w.closed for w in self.rt.workers.values()))


    async def test_malformed_surface_report_fails_the_launch(self):
        with self.assertRaises(AgentError) as cm:
            await self.spawn(profile=self.restricted_profile(PI_TEST_SURFACE='malformed'))
        self.assertEqual(cm.exception.code,'tool_surface_unapplied')
        self.assertEqual(self.events_of(cm.exception.details['agent_id'],'tool_surface')[-1]['ok'],False)


    async def test_profile_opt_out_keeps_the_disable_flags(self):
        self.rt.config['profiles']['isolated']={'tools':['read'],'ambient_extensions':False,'ambient_skills':False}
        s=await self.spawn(profile='isolated'); aid=s['agent_id']
        argv=json.loads((self.home/'agents'/aid/'launch.json').read_text())['argv']
        self.assertIn('--no-extensions',argv); self.assertIn('--no-skills',argv)
        await self.mutation('close',aid)


    async def test_read_profile_may_load_extensions(self):
        # Ambient extensions do not make a read-only claim about custom tools.
        ext = self.root / "custom-ext.ts"
        ext.write_text("export default () => {}\n")
        self.rt.config["profiles"]["reader-ext"] = {"tools": ["read", "grep", "find", "ls"], "extensions": [str(ext)]}
        s = await self.spawn(profile="reader-ext")
        aid = s["agent_id"]
        argv = json.loads((self.home / "agents" / aid / "launch.json").read_text())["argv"]
        self.assertIn(str(ext), argv)
        await self.mutation('close',aid)


class BuiltinSurfacePlan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='native-surface-')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.enterContext(mock.patch.dict(os.environ, {'METIS_PI_CONFIG':str(self.home/'metis-pi.toml')}))
        self.host = {'kind':'pi','node_path':sys.executable,'sdk_path':str(self.home/'index.js'),
            'model':{'provider':'offline','id':'mock'}}

    def config(self, **profiles):
        config = load_config(self.home)
        config['profiles'].update(profiles)
        return config

    def test_restricting_profile_without_the_extension_is_refused(self):
        gone = self.home/'gone.ts'
        with mock.patch('metis_subagent.config.surface_extension_path', return_value=gone):
            for profile, access in [('reader','read'), ('default','write')]:
                with self.subTest(profile=profile), self.assertRaises(AgentError) as caught:
                    launch_spec(self.config(),profile,'test/model',str(ROOT),access,host=self.host)
                self.assertEqual(caught.exception.code,'invalid_config')
                self.assertIn(str(gone),caught.exception.message)

    def test_restricting_profile_carries_the_surface_plan_and_no_name_filters(self):
        spec=launch_spec(self.config(),'reader','test/model',str(ROOT),'read',host=self.host)
        self.assertTrue(spec['surface'])
        self.assertEqual(spec['builtins'],['read','grep','find','ls'])
        self.assertIn(str(SURFACE),spec['argv'])
        for flag in ('--tools','--no-tools','--exclude-tools'): self.assertNotIn(flag,spec['argv'])


    def spec(self, profile, access, tools=None):
        config = self.config()
        if tools is not None:
            config['profiles'][profile]['tools'] = tools
        return launch_spec(config,profile,'test/model',str(ROOT),access,host=self.host)

    def test_empty_builtin_profile_is_still_fail_closed(self):
        spec=self.spec('default','write',tools=[])
        self.assertTrue(spec['surface'])
        self.assertEqual(spec['builtins'],[])
        self.assertIn(str(SURFACE),spec['argv'])


    def test_default_profiles_load_pi_configuration(self):
        for profile in ('default','reader'):
            for argv in (self.spec(profile,'write')['argv'] if profile=='default' else self.spec(profile,'read')['argv'],):
                self.assertNotIn('--no-extensions',argv)
                self.assertNotIn('--no-skills',argv)

    def test_ambient_opt_out_keeps_the_explicit_flags(self):
        config=self.config()
        config['profiles']['isolated']={'tools':['read'],'ambient_extensions':False,'ambient_skills':False}
        argv=launch_spec(config,'isolated','test/model',str(ROOT),'read',host=self.host)['argv']
        self.assertIn('--no-extensions',argv)
        self.assertIn('--no-skills',argv)
        self.assertNotIn('--exclude-tools',argv)
        self.assertTrue(launch_spec(config,'isolated','test/model',str(ROOT),'read',host=self.host)['surface'])


    def test_surface_plan_covers_every_restricting_profile(self):
        partial=self.spec('default','write',tools=['read','bash','edit','write'])
        self.assertTrue(partial['surface'])          # powershell is still restricted
        self.assertIn(str(SURFACE),partial['argv'])
        self.assertEqual(partial['builtins'],['read','bash','edit','write'])
        extra=self.spec('default','write',tools=['read','bash','edit','write','grep'])
        self.assertTrue(extra['surface'])
        self.assertEqual(extra['builtins'],['read','bash','edit','write','grep'])


    def test_skills_are_repeatable_flags(self):
        dirs=[]
        for name in ('one','two'):
            d=Path(self.tmp.name)/name; d.mkdir(); (d/'SKILL.md').write_text(f'---\nname: {name}\ndescription: d\n---\n')
            dirs.append(str(d))
        config=self.config()
        config['profiles']['skilly']={'tools':['read'],'skills':dirs}
        argv=launch_spec(config,'skilly','test/model',str(ROOT),'read',host=self.host)['argv']
        self.assertEqual([argv[i+1] for i,arg in enumerate(argv) if arg=='--skill'],dirs)


class ScopeEnvIsolation(RuntimeHarness, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.rt.config['child_env'] = ['PI_TEST_HOME_TAG','PI_TEST_SECRET_VAR']
        self.canary = 'PI_TEST_ENV_CANARY'
        self.enterContext(mock.patch.dict(os.environ, {self.canary:'daemon-only'}))

    async def _spawn_with_env(self, label, cwd, env, rid):
        source = {**self.source, 'env':env}
        sid = (await self.rt.dispatch('scope_open', {'cwd':str(cwd),'label':label}, source))['scope']
        s = await self.rt.dispatch('spawn', {'scope':sid,'request_id':rid,'task':'simple','access':'read'}, source)
        return sid, s['agent_id']

    async def test_two_scopes_get_their_own_values(self):
        ws_a = self.root / "a"
        ws_a.mkdir()
        ws_b = self.root / "b"
        ws_b.mkdir()
        base = {"PATH": os.environ["PATH"], "HOME": str(self.root)}
        scope_a, aid_a = await self._spawn_with_env("a", ws_a, {**base, "PI_TEST_HOME_TAG": "A"}, "env-1")
        scope_b, aid_b = await self._spawn_with_env("b", ws_b, {**base, "PI_TEST_HOME_TAG": "B"}, "env-2")
        for scope, aid, tag in ((scope_a, aid_a, "A"), (scope_b, aid_b, "B")):
            w = self.rt.workers[aid]
            state = await w.rpc("get_state")
            probe = state.get("env_probe", {})
            self.assertEqual(probe.get("PI_TEST_HOME_TAG"), tag)
            self.assertNotIn(self.canary, probe)
            await self.rt.dispatch("close", {"scope": scope, "agent_id": aid, "request_id": f"close-{tag}"})


    async def test_control_plane_has_no_env_values(self):
        ws = self.root / "c"
        ws.mkdir()
        scope, aid = await self._spawn_with_env(
            "c",
            ws,
            {**{"PATH": os.environ["PATH"], "HOME": str(self.root)}, "PI_TEST_SECRET_VAR": "scope-secret-value"},
            "env-3",
        )
        probe = (await self.rt.workers[aid].rpc('get_state'))['env_probe']
        self.assertEqual(probe['PI_TEST_SECRET_VAR'], 'scope-secret-value')
        blobs = [p for p in self.home.rglob("*") if p.is_file() and p.suffix in (".json", ".jsonl", "")]
        for p in blobs:
            self.assertNotIn(b"scope-secret-value", p.read_bytes(), p)
        db = self.home / "registry.sqlite"
        if db.exists():
            import sqlite3

            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                    for row in con.execute(f"SELECT * FROM {table}"):
                        self.assertNotIn("scope-secret-value", str(row))
            finally:
                con.close()
        wal = self.home / "registry.sqlite-wal"
        if wal.exists():
            self.assertNotIn(b"scope-secret-value", wal.read_bytes())


class CodingAgentDirBinding(RuntimeHarness, unittest.IsolatedAsyncioTestCase):
    async def test_client_bound_directory_reaches_the_child(self):
        self.rt.config['profiles']['reader']['env'] = {'PI_CODING_AGENT_DIR':str(self.root/'profile-override')}
        source = {**self.source, 'env':{**self.source['env'],'PI_CODING_AGENT_DIR':str(self.root/'env-override')}}
        await self.rt.dispatch('scope_open', {'scope':self.scope,'cwd':str(self.workspace)}, source)
        a = await self.spawn()
        probe = (await self.rt.workers[a['agent_id']].rpc('get_state'))['env_probe']
        self.assertEqual(probe['PI_CODING_AGENT_DIR'],self.source['parent']['agent_dir'])

    async def test_bound_directory_survives_a_daemon_restart(self):
        a = await self.spawn()
        await self.mutation('close',a['agent_id'])
        await self.rt.shutdown()
        self.rt = Runtime(self.home)
        # The stored native parent locator remains authoritative after restart.
        revived = await self.rt.dispatch('respawn', {'scope':self.scope,'agent_id':a['agent_id'],
            'request_id':'agentdir-restart'}, {**self.source,'env':{}})
        probe = (await self.rt.workers[a['agent_id']].rpc('get_state'))['env_probe']
        self.assertEqual(probe['PI_CODING_AGENT_DIR'],self.source['parent']['agent_dir'])
        self.assertEqual(revived['generation'],2)


class EnvironmentBindingChain(IpcHarness, unittest.IsolatedAsyncioTestCase):
    async def test_native_ipc_keeps_custom_path_authorized_env_and_secret_isolation(self):
        fakebin = self.root/'bin'; fakebin.mkdir()
        # A program on PATH the child really executes. Windows uses a batch shim
        # that the fixture starts through cmd.exe explicitly (never a file
        # association); the discovery still happens through the custom PATH.
        if sys.platform == 'win32':
            interp = fakebin/'tag-interp.cmd'
            interp.write_text('@echo off\r\necho interp-ok\r\n')
        else:
            interp = fakebin/'tag-interp'
            interp.write_text('#!/bin/sh\necho interp-ok\n'); interp.chmod(0o755)
        probe = self.root/'probe.json'
        self.config_path.write_text('[subagents]\nchildEnv=["PI_TEST_AUTH","PI_TEST_HOME_TAG",'
            '"PI_TEST_PROBE_FILE","PI_TEST_PROBE_CMD"]\n')
        self.source['env'].update(PATH=str(fakebin)+os.pathsep+os.environ['PATH'],
            PI_TEST_AUTH='real-secret-123', PI_TEST_DAEMON_ONLY='daemon-canary-x',
            PI_TEST_HOME_TAG='A', PI_TEST_PROBE_FILE=str(probe), PI_TEST_PROBE_CMD='tag-interp')
        sid = await self.open_scope()
        await self.spawn(sid)
        data = json.loads(probe.read_text())
        self.assertEqual(data['rc'],0)
        self.assertIn('interp-ok',data['out'])
        self.assertTrue(data['path'].startswith(str(fakebin)))
        self.assertEqual(data['home_tag'],'A')
        self.assertTrue(data['has_auth'])
        self.assertFalse(data['has_daemon_only'])
        for path in self.home.rglob('*'):
            # Live byte locks (daemon/session lease) cannot be read on Windows;
            # they are empty by construction and cannot carry the secret.
            if path.is_file() and path.suffix != '.lock':
                self.assertNotIn(b'real-secret-123',path.read_bytes(),path)


class StoreSchemaBoundary(unittest.TestCase):
    def test_future_schema_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='native-schema-') as tmp:
            home = Path(tmp)
            # Close explicitly: the context manager only ends the transaction, and
            # Windows cannot remove a file whose handle is still open.
            db = sqlite3.connect(home/'registry.sqlite')
            try:
                db.executescript("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); "
                    "INSERT INTO meta VALUES('schema','999'); INSERT INTO meta VALUES('owner','metis-pi/native-subagent');")
            finally:
                db.close()
            before = (home/'registry.sqlite').read_bytes()
            with self.assertRaises(AgentError) as caught:
                Store(home)
            self.assertEqual(caught.exception.code,'foreign_database')
            self.assertEqual((home/'registry.sqlite').read_bytes(),before)
