import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from paths import ROOT, TEST_ROOT, REPO_ROOT
from subagent_pi.common import AgentError, live_identity, crop
from subagent_pi.client import call_timeout, boot_budget
from subagent_pi import __version__
from unittest.mock import patch

class ClientTimeoutBudget(unittest.TestCase):
    """A slow-but-healthy boot must not be reported as a failed mutation: the
    client wait has to cover the daemon's own boot budget."""
    def test_boot_ops_cover_daemon_boot_budget(self):
        budget=boot_budget(None)                       # startup_timeout_seconds default 30
        self.assertGreaterEqual(call_timeout('spawn',{},None),budget)
        self.assertGreaterEqual(call_timeout('respawn',{},None),budget)
        self.assertGreaterEqual(call_timeout('close',{},None),budget)
        for op in ('soft_interrupt','message','followup','send'):
            self.assertGreaterEqual(call_timeout(op,{},None),budget)
        self.assertGreater(budget,45)                  # the old flat 45s was the bug
    def test_boot_timeout_ignores_model_inactivity_limit(self):
        self.assertEqual(call_timeout('spawn',{'idle_timeout_seconds':604800},None),
                         call_timeout('spawn',{},None))

    def test_spawn_exposes_inactivity_not_total_timeout(self):
        from subagent_pi.schema import validate_op
        from subagent_pi.cli import parser
        from subagent_pi.config import load_config
        validate_op('spawn',{'scope':'scope','request_id':'new','task':'long work','idle_timeout_seconds':60})
        with self.assertRaises(AgentError):
            validate_op('spawn',{'scope':'scope','request_id':'old','task':'long work','timeout_seconds':60})
        args=parser().parse_args(['spawn','--task','work','--idle-timeout-seconds','60'])
        self.assertEqual(args.idle_timeout_seconds,60)
        with tempfile.TemporaryDirectory() as path:
            home=Path(path)
            (home/'config.toml').write_text('default_run_timeout_seconds=900\n')
            config=load_config(home)
            self.assertEqual(config['default_idle_timeout_seconds'],900)
            self.assertNotIn('default_run_timeout_seconds',config)
    def test_wait_scales_with_its_own_timeout(self):
        from subagent_pi.common import DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS
        self.assertEqual(call_timeout('wait',{},None),DEFAULT_WAIT_SECONDS+10)
        self.assertEqual(call_timeout('wait',{'timeout_seconds':MAX_WAIT_SECONDS},None),MAX_WAIT_SECONDS+10)
        self.assertGreater(call_timeout('wait',{'timeout_seconds':120},None),
                           call_timeout('wait',{'timeout_seconds':25},None))
        self.assertEqual(call_timeout('list',{},None),45)


    def test_wait_schema_and_cli_expose_seconds_only(self):
        from subagent_pi.schema import BY_NAME, validate_op
        from subagent_pi.cli import parser
        from subagent_pi.common import AgentError
        props=BY_NAME['pi_wait_agent']['inputSchema']['properties']
        self.assertNotIn('timeout_ms',props)
        self.assertEqual(props['mode'],{'type':'string','enum':['any','all'],'default':'any'})
        self.assertEqual((props['timeout_seconds']['default'],props['timeout_seconds']['maximum']),(600,3600))
        for seconds in (0,1,600,3600):
            validate_op('wait',{'scope':'scope','timeout_seconds':seconds})
        for args in ({'timeout_ms':600000},{'timeout_seconds':3601},{'timeout_seconds':-1},{'timeout_seconds':True}):
            with self.subTest(args=args),self.assertRaises(AgentError): validate_op('wait',{'scope':'scope',**args})
        self.assertEqual(parser().parse_args(['wait','--timeout-seconds','3600']).timeout_seconds,3600)
        self.assertIsNone(parser().parse_args(['wait']).timeout_seconds)
        self.assertEqual(parser().parse_args(['wait','--mode','all']).mode,'all')
        validate_op('wait',{'scope':'scope','mode':'all','timeout_seconds':0})

class ProcessIdentity(unittest.TestCase):
    def test_pid_reuse_is_not_live_owner(self):
        with patch('subagent_pi.common.process_identity',return_value='boot:new-tick'):
            self.assertFalse(live_identity(123,'boot:old-tick'))
            self.assertTrue(live_identity(123,'boot:new-tick'))
        with patch('subagent_pi.common.process_identity',return_value='unknown'):
            self.assertIsNone(live_identity(123,'boot:old-tick'))
    def test_utf8_crop(self):
        self.assertEqual(crop('🙂字',4),'🙂')
        self.assertEqual(crop('🙂字',3),'')

class SdkTransport(unittest.TestCase):
    def test_stock_pi_command_resolves_only_to_plugin_files(self):
        from subagent_pi.worker import managed_command
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'dist/bundle').mkdir(parents=True)
            manifest=root/'package.json'; manifest.write_text('{"name":"@earendil-works/pi-coding-agent","version":"0.99.1"}')
            cli=root/'dist/bundle/cli.js'; cli.write_text('unchanged cli')
            sdk=root/'dist/index.js'; sdk.write_text('unchanged sdk')
            before={p:p.read_bytes() for p in (manifest,cli,sdk)}
            with patch('shutil.which',return_value='/usr/bin/node'):
                argv=managed_command([str(cli),'--mode','rpc'])
            self.assertEqual(argv[1:],[str(ROOT/'runtime/pi-sdk.mjs'),str(sdk),'--mode','rpc'])
            self.assertEqual({p:p.read_bytes() for p in before},before)

    def test_stock_pi_command_rejects_old_or_unknown_sdk_versions(self):
        from subagent_pi.worker import managed_command
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'dist/bundle').mkdir(parents=True)
            manifest=root/'package.json'
            cli=root/'dist/bundle/cli.js'; cli.write_text('unchanged cli')
            sdk=root/'dist/index.js'; sdk.write_text('unchanged sdk')
            for version in ('0.87.0', '0.99.0', None, 'unknown'):
                with self.subTest(version=version):
                    manifest.write_text(json.dumps({'name':'@earendil-works/pi-coding-agent','version':version}))
                    with self.assertRaises(AgentError) as error:
                        managed_command([str(cli),'--mode','rpc'])
                    self.assertEqual(error.exception.code,'unsupported_pi_version')
                    self.assertIn('0.99.1',error.exception.message)
            for version in ('0.99.1', '0.100.0', '1.0.0'):
                with self.subTest(version=version), patch('shutil.which',return_value='/usr/bin/node'):
                    manifest.write_text(json.dumps({'name':'@earendil-works/pi-coding-agent','version':version}))
                    self.assertEqual(managed_command([str(cli),'--mode','rpc'])[2],str(sdk))
