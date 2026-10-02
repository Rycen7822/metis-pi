"""Inheritance tests: source resolution, skills, MCP parsing, the private pipe
channel, secret canaries, and no-new-runtime-files guarantees. All offline."""
from __future__ import annotations
import asyncio
import contextlib
import json
import os
from pathlib import Path
import select
import shutil
import tomllib
import sqlite3
import subprocess
import sys
import time
import tempfile
import unittest
from unittest import mock

from paths import ROOT, TEST_ROOT, REPO_ROOT
from subagent_pi.common import AgentError, dumps, socket_path
from subagent_pi.config import PI_BUILTIN_TOOLS, load_config, launch_spec
from subagent_pi.inheritance import capture_scope_env, collect_skills, referenced_env_names, resolve_codex_home
from subagent_pi.mcp_config import CODEX_MCP_BASELINE, parse_mcp_servers, read_access_diagnostics, resolve_environment
from subagent_pi.runtime import Runtime
from subagent_pi.store import SCHEMA_VERSION, Store
from subagent_pi.worker import write_bootstrap

def parse_surface(text: str) -> dict:
    """Latest structured evidence line the shipped managed-surface extension
    writes to stderr: `subagent-pi-surface applied ok=... allowed=... builtins=...
    unknown=...`. Tests read the extension's own read-back of the live registry
    instead of trusting argv."""
    line=None
    for candidate in text.splitlines():
        if candidate.startswith('subagent-pi-surface applied'): line=candidate
    if line is None: raise AssertionError('no subagent-pi-surface evidence in child stderr:\n'+text[-2000:])
    fields={}
    for part in line.split()[2:]:
        key,_,value=part.partition('=')
        fields[key]=value
    return fields


BRIDGE=ROOT/'extensions'/'codex-mcp-bridge.ts'
SURFACE=ROOT/'extensions'/'managed-surface.ts'
FAKE_PI=TEST_ROOT/'fake_pi.py'
ECHO_SERVER_SOURCE = '''import sys,json
for line in sys.stdin:
    request=json.loads(line)
    if "id" in request:
        result={"tools":[{"name":"echo","description":"t"}]} if request.get("method")=="tools/list" else {}
        print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":result}),flush=True)
'''

def make_skill(base: Path, name: str, body='Body.', front_name=None):
    d=base/name
    d.mkdir(parents=True)
    fm=front_name or name
    (d/'SKILL.md').write_text(f'---\nname: {fm}\ndescription: test skill {name}\n---\n\n{body}\n')
    return d

def make_codex_home(base: Path, config: str='') -> Path:
    home=base/'codex-home'
    (home/'skills').mkdir(parents=True)
    (home/'config.toml').write_text(config)
    return home

def fake_pi_command() -> str:
    return json.dumps([sys.executable,str(FAKE_PI)])

class SourceResolution(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-src-'); self.base=Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()
    def config(self,home=None):
        return {'enabled':True,'skills':True,'mcp':True,'codex_home':str(home) if home else None}
    def test_explicit_wins_over_env_and_default(self):
        a=make_codex_home(self.base/'a'); b=make_codex_home(self.base/'b')
        self.assertEqual(resolve_codex_home(self.config(a),{'CODEX_HOME':str(b)}),(a,'explicit'))
    def test_scope_env_before_default(self):
        b=make_codex_home(self.base/'b')
        home,mode=resolve_codex_home(self.config(None),{'CODEX_HOME':str(b)})
        self.assertEqual((home,mode),(b,'scope_env'))
    def test_user_default_uses_home_env(self):
        make_codex_home(self.base/'c')
        with mock.patch.dict(os.environ,{'HOME':str(self.base/'c')}):
            (self.base/'c'/'.codex').mkdir()
            home,mode=resolve_codex_home(self.config(None),{})
            self.assertEqual((mode,home.name),('user_default','.codex'))
    def test_missing_source_returns_none(self):
        with mock.patch.dict(os.environ,{'HOME':str(self.base/'nonexistent-home')}):
            home,mode=resolve_codex_home(self.config(None),{})
            self.assertIsNone(home)
    def test_nonexistent_explicit_dir_is_an_error(self):
        # A missing explicit source must not silently fall back to the valid env source.
        make_codex_home(self.base/'b')
        with self.assertRaises(AgentError) as cm:
            resolve_codex_home(self.config(self.base/'missing'),{'CODEX_HOME':str(self.base/'b')})
        self.assertEqual(cm.exception.code,'inheritance_source_unreadable')
    def test_missing_scope_env_source_is_an_error(self):
        with self.assertRaises(AgentError) as cm:
            resolve_codex_home(self.config(None),{'CODEX_HOME':str(self.base/'also-missing')})
        self.assertEqual(cm.exception.code,'inheritance_source_unreadable')

class SkillCollection(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-skill-'); self.base=Path(self.tmp.name)
        self.home=make_codex_home(self.base)
    def tearDown(self): self.tmp.cleanup()
    def test_codex_skills_selected_in_place(self):
        s=make_skill(self.home/'skills','alpha')
        selected,diag=collect_skills(self.home,{},None,[])
        self.assertEqual([Path(p) for p in selected],[s])
        self.assertTrue((selected[0].startswith(str(self.home))))  # original location
    def test_project_and_profile_dedup_by_realpath(self):
        proj=make_skill(self.base/'proj'/'.agents'/'skills','alpha')
        link=self.home/'skills'/'alpha'
        link.symlink_to(proj)
        selected,diag=collect_skills(self.home,{},str(self.base/'proj'),[str(proj)])
        self.assertEqual(selected,[str(proj)])  # same real path stays single entry
    def test_name_conflict_refuses_ambiguity(self):
        make_skill(self.home/'skills','alpha',front_name='dup')
        proj=make_skill(self.base/'proj'/'.agents'/'skills','beta',front_name='dup')
        selected,diag=collect_skills(self.home,{},str(self.base/'proj'),[str(proj)])
        self.assertNotIn(str(self.home/'skills'/'alpha'),selected)
        self.assertTrue(any('name conflict' in d.reason for d in diag))
    def test_disabled_by_skills_config(self):
        s=make_skill(self.home/'skills','gone')
        config=f'[[skills.config]]\npath = "{s}/SKILL.md"\nenabled = false\n'
        raw=tomllib.loads(config)
        selected,diag=collect_skills(self.home,raw,None,[])
        self.assertEqual(selected,[])
        self.assertTrue(any('disabled by codex' in d.reason for d in diag))
    def test_management_skill_excluded_by_name_and_plugin_path(self):
        make_skill(self.home/'skills','subagent-pi')
        plugin_skill=self.home/'skills'/'subagent-pi'
        alias=self.home/'skills'/'renamed-alias'
        if not alias.exists(): alias.symlink_to(plugin_skill)
        selected,diag=collect_skills(self.home,{},None,[])
        self.assertEqual([p for p in selected if 'renamed-alias' in p],[])
        self.assertTrue(all('subagent-pi' not in p for p in selected))
        self.assertTrue(any('recursion guard' in d.reason for d in diag))
    def test_missing_dir_diagnostic_and_chinese_space_paths(self):
        empty=make_codex_home(self.base/'x')
        (empty/'skills').rmdir()
        selected,diag=collect_skills(empty,{},None,[])
        self.assertEqual(selected,[])
        self.assertTrue(any('not present' in d.reason for d in diag))
        odd=make_skill(self.home/'skills','我的 技能')
        selected,_=collect_skills(self.home,{},None,[])
        self.assertIn(str(odd.resolve()),[str(Path(p).resolve()) for p in selected])
    def test_malformed_skill_entry_skipped(self):
        (self.home/'skills'/'not-a-skill').mkdir()
        (self.home/'skills'/'not-a-skill'/'README.md').write_text('hi')
        selected,diag=collect_skills(self.home,{},None,[])
        self.assertEqual(selected,[])

STDIO_TOML='''
[mcp_servers.filesrv]
command = "python3"
args = ["-m", "fake_server"]
cwd = "servers/dir with space"
env_vars = ["TOKEN_VAR"]

[mcp_servers.filesrv.env]
STATIC_K = "static-v"
'''
REMOTE_TOML='''
[mcp_servers.remote]
command = "run"
env_vars = [{ name = "REMOTE_X", source = "remote" }]
'''
HTTP_TOML='''
[mcp_servers.web]
url = "https://example.com/mcp"
bearer_token_env_var = "WEB_TOKEN"
env_http_headers = { "X-Trace" = "TRACE_ID" }
http_headers = { "X-Static" = "sv" }
enabled_tools = ["search"]
disabled_tools = ["danger"]
startup_timeout_sec = 7
tool_timeout_sec = 33
default_tools_approval_mode = "auto"
'''
class McpParsingCase(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-mcp-'); self.base=Path(self.tmp.name)
        self.home=make_codex_home(self.base)
    def tearDown(self): self.tmp.cleanup()
    def parse(self,config): return parse_mcp_servers(self.home,tomllib.loads(config))

class McpParsing(McpParsingCase):
    def test_env_vars_requires_an_outer_list(self):
        for value in ('"API_KEY"', '{}', 'false'):
            with self.subTest(value=value):
                servers, diagnostics = self.parse('[mcp_servers.a]\ncommand="cat"\nrequired=true\nenv_vars='+value)
                self.assertEqual(servers[0]['disposition'], 'failed')
                self.assertTrue(servers[0]['required'])
                self.assertIn('env_vars must be a list', servers[0]['reasons'][0])
                self.assertTrue(diagnostics)

    def test_stdio_modern_opt_in_selects_modern_and_strips_marker(self):
        config='''
[mcp_servers.a]
command = "srv"
[mcp_servers.a.env]
CODEX_MCP_PROTOCOL_VERSION = "2026-07-28"
API_KEY = "k"
'''
        servers,diag=self.parse(config)
        self.assertEqual(len(servers),1)
        s=servers[0]
        self.assertEqual(s['protocol_mode'],'modern_2026_07_28')
        self.assertNotIn('CODEX_MCP_PROTOCOL_VERSION',s['static_env'])  # marker consumed, never forwarded
        self.assertEqual(s['static_env'],{'API_KEY':'k'})
        self.assertTrue(all('legacy' not in d.reason for d in diag))

    def test_stdio_without_marker_stays_legacy_and_env_is_untouched(self):
        config='''
[mcp_servers.a]
command = "srv"
[mcp_servers.a.env]
API_KEY = "k"
'''
        servers,diag=self.parse(config)
        self.assertEqual(servers[0]['protocol_mode'],'legacy_2025_06_18')
        self.assertEqual(servers[0]['static_env'],{'API_KEY':'k'})

    def test_stdio_unknown_marker_fails_closed(self):
        config='''
[mcp_servers.a]
command = "srv"
required = false
[mcp_servers.a.env]
CODEX_MCP_PROTOCOL_VERSION = "1999-01-01"
'''
        servers,diag=self.parse(config)
        self.assertEqual([s['disposition'] for s in servers],['failed'])
        self.assertTrue(any('CODEX_MCP_PROTOCOL_VERSION' in d.reason for d in diag))
        # the failed entry never becomes a server env, so the process cannot start
        self.assertTrue(all('CODEX_MCP_PROTOCOL_VERSION' not in json.dumps(s) or s.get('disposition')=='failed' for s in servers))

    def test_stdio_marker_stripped_even_under_global_legacy_override(self):
        config='''
[mcp_servers.a]
command = "srv"
[mcp_servers.a.env]
CODEX_MCP_PROTOCOL_VERSION = "2026-07-28"
'''
        servers,diag=parse_mcp_servers(self.home,tomllib.loads(config),'legacy_2025_06_18')
        self.assertEqual(servers[0]['protocol_mode'],'legacy_2025_06_18')  # global override wins for the era
        self.assertNotIn('CODEX_MCP_PROTOCOL_VERSION',servers[0]['static_env'])  # but the marker is still stripped
        self.assertTrue(any('legacy_2025_06_18 keeps this stdio server' in d.reason for d in diag))

    def test_timeout_fields_accept_floating_point_seconds(self):
        config='''
[mcp_servers.a]
command = "srv"
startup_timeout_sec = 1.5
tool_timeout_sec = 0.5
'''
        servers,diag=self.parse(config)
        self.assertEqual(servers[0]['startup_timeout_sec'],1.5)
        self.assertEqual(servers[0]['tool_timeout_sec'],0.5)
        config2='''
[mcp_servers.a]
command = "srv"
tool_timeout_sec = "soon"
'''
        servers2,diag2=self.parse(config2)
        self.assertEqual(servers2[0]['tool_timeout_sec'],60)
        self.assertTrue(any('invalid tool_timeout_sec' in d.reason for d in diag2))

    def test_stdio_fields_normalized(self):
        servers,diag=self.parse(STDIO_TOML)
        self.assertEqual(len(servers),1)
        s=servers[0]
        self.assertEqual(s['disposition'],'ok')
        self.assertEqual(s['transport'],'stdio')
        self.assertEqual(s['command'],'python3')
        self.assertEqual(s['args'],['-m','fake_server'])
        self.assertEqual(s['env_var_names'],['TOKEN_VAR'])
        self.assertTrue(s['cwd'].startswith(str(self.home)))  # relative cwd anchored to codex home
        self.assertIn('dir with space',s['cwd'])
        self.assertEqual(s['static_env'],{'STATIC_K':'static-v'})
    def test_remote_env_source_disables_server(self):
        servers,diag=self.parse(REMOTE_TOML)
        # F11: the failed server keeps its disposition instead of vanishing.
        self.assertEqual([s['disposition'] for s in servers],['failed'])
        self.assertTrue(any('source=remote' in d.reason for d in diag))
    def test_http_fields_and_policy_fields(self):
        servers,diag=self.parse(HTTP_TOML)
        self.assertEqual(len(servers),1)
        s=servers[0]
        self.assertEqual(s['transport'],'http')
        self.assertEqual(s['static_headers'],{'X-Static':'sv'})
        self.assertEqual(s['env_header_names'],{'X-Trace':'TRACE_ID'})
        self.assertEqual(s['bearer_token_env_var'],'WEB_TOKEN')
        self.assertEqual(s['allowed_tools'],['search'])
        self.assertEqual(s['disabled_tools'],['danger'])
        self.assertEqual(s['approval_default'],'auto')
        self.assertEqual(s['tool_approval'],{})
        self.assertEqual(s['startup_timeout_sec'],7)
        self.assertEqual(s['tool_timeout_sec'],33)
    def test_disabled_and_unknown_critical_keys(self):
        config=HTTP_TOML+'\n[mcp_servers.bad]\ncommand = "x"\nsandbox_permissions = ["full"]\n\n[mcp_servers.off]\ncommand = "y"\nenabled = false\n'
        servers,diag=self.parse(config)
        dispo={s['name']:s['disposition'] for s in servers}
        self.assertEqual(dispo['bad'],'failed'); self.assertEqual(dispo['off'],'disabled')
        self.assertEqual(dispo['web'],'ok')  # unaffected servers continue
        self.assertTrue(any('unsupported config keys' in d.reason and d.name=='bad' for d in diag))
        self.assertTrue(any(d.name=='off' and 'disabled in codex config' in d.reason for d in diag))
    def test_oauth_and_helper_rejected(self):
        config='''
[mcp_servers.a]
url = "https://x.example/mcp"
auth = "oauth"
[mcp_servers.b]
url = "https://x.example/mcp"
http_headers_helper = "/bin/helper"
[mcp_servers.c]
command = "run"
experimental_environment = "remote"
'''
        servers,diag=self.parse(config)
        self.assertEqual({s['disposition'] for s in servers},{'failed'})
        reasons=' '.join(d.reason for d in diag)
        self.assertIn('oauth',reasons); self.assertIn('http_headers_helper',reasons); self.assertIn('remote',reasons)
    def test_required_parse_failure_is_kept_and_named(self):
        # F11: an unsupported REQUIRED server cannot silently disappear.
        config='[mcp_servers.core]\nurl = "https://x.example/mcp"\nauth = "oauth"\nrequired = true\n'
        servers,diag=self.parse(config)
        self.assertEqual(servers[0]['disposition'],'failed')
        self.assertTrue(servers[0]['required'])
        self.assertTrue(any('oauth' in d.reason for d in diag))
    def test_empty_allowlist_means_no_tools(self):
        config='[mcp_servers.strict]\ncommand = "x"\nenabled_tools = []\n'
        servers,_=self.parse(config)
        self.assertEqual(servers[0]['allowed_tools'],[])
        self.assertEqual(read_access_diagnostics(servers,'read'),[])
    def test_recursion_guard_direct_command(self):
        bin_path=ROOT/'bin'/'subagent-pi'
        config=f'[mcp_servers.renamed_control]\ncommand = "{bin_path}"\nargs = ["mcp"]\n'
        servers,diag=self.parse(config)
        self.assertEqual(servers[0]['disposition'],'failed')
        self.assertTrue(any('recursion guard' in d.reason for d in diag))
    def test_recursion_guard_installer_wrapper_and_module_form(self):
        # F12: the installer generates command=sys.executable args=[<bin>,'mcp'];
        # `python -m subagent_pi` must be caught too. Renaming the server evades nothing.
        bin_path=ROOT/'bin'/'subagent-pi'
        for cfg in (f'[mcp_servers.ctrl]\ncommand = "{sys.executable}"\nargs = ["{bin_path}", "mcp"]\n',
                    '[mcp_servers.ctrl2]\ncommand = "python3"\nargs = ["-m", "subagent_pi", "mcp"]\n'):
            servers,diag=self.parse(cfg)
            self.assertEqual(servers[0]['disposition'],'failed',cfg)
            self.assertTrue(any('recursion guard' in d.reason for d in diag))
    def test_recursion_guard_does_not_catch_normal_python(self):
        servers,_=self.parse('[mcp_servers.plain]\ncommand = "python3"\nargs = ["-m", "other_tool"]\n')
        self.assertEqual(servers[0]['disposition'],'ok')
    def test_approval_policy_table(self):
        # F06: per-tool override wins over server default; writes/unknown degrade to confirm.
        def policy(cfg):
            servers,_=self.parse(cfg)
            return servers[0]['approval_default'],servers[0]['tool_approval'],servers[0]['disabled_tools'],servers[0].get('tool_output_limits')
        cfg='''[mcp_servers.example]
command = "x"
default_tools_approval_mode = "auto"
[mcp_servers.example.tools.delete_file]
approval_mode = "prompt"
'''
        default,tools,denied,budgets=policy(cfg)
        self.assertEqual(default,'auto')
        self.assertEqual(tools,{'delete_file':'confirm'})
        cfg2='''[mcp_servers.example2]
command = "x"
default_tools_approval_mode = "prompt"
[mcp_servers.example2.tools.safe_thing]
approval_mode = "auto"
'''
        default,tools,denied,budgets=policy(cfg2)
        self.assertEqual(default,'confirm')
        self.assertEqual(tools,{'safe_thing':'auto'})
        cfg3='''[mcp_servers.example3]
command = "x"
[mcp_servers.example3.tools.limited]
output_token_limit = 100
[mcp_servers.example3.tools.weird]
approval_mode = "banana"
'''
        default,tools,denied,budgets=policy(cfg3)
        self.assertNotIn('limited',denied)  # output_token_limit is now mapped, not denied
        self.assertEqual(budgets.get('limited'),400)  # 100 tokens -> conservative 4 bytes/token
        self.assertIn('weird',denied)
        self.assertEqual(tools,{})
    def test_resolve_environment_from_snapshot_only(self):
        servers,_=self.parse(STDIO_TOML)
        resolve_environment(servers,{'TOKEN_VAR':'token-a','PATH':'/bin'})
        self.assertEqual(servers[0]['env']['TOKEN_VAR'],'token-a')
        self.assertEqual(servers[0]['env']['STATIC_K'],'static-v')
        self.assertNotIn('PATH',servers[0]['env'])  # base env is the child runner's job, not per-server
    def test_required_missing_env_blocks(self):
        config='[mcp_servers.core]\ncommand = "x"\nenv_vars = ["MISSING_VAR"]\nrequired = true\n'
        servers,_=self.parse(config)
        with self.assertRaises(AgentError) as cm:
            resolve_environment(servers,{})
        self.assertEqual(cm.exception.code,'inheritance_required_server_failed')
        self.assertIn('core',cm.exception.message)  # message carries server names, not values
        self.assertIn('MISSING_VAR',servers[0]['reasons'][0])
        self.assertEqual(servers[0]['disposition'],'failed')  # disposition recorded before raising
    def test_optional_missing_env_excluded_with_named_diagnostic(self):
        config='[mcp_servers.opt]\ncommand = "x"\nenv_vars = ["ABSENT_VAR"]\n'
        servers,_=self.parse(config)
        resolve_environment(servers,{})
        self.assertEqual(servers[0]['disposition'],'failed')
        self.assertTrue(any('ABSENT_VAR' in r for r in servers[0].get('reasons',[])))
    def test_bearer_and_env_headers_resolved(self):
        servers,_=self.parse(HTTP_TOML)
        resolve_environment(servers,{'WEB_TOKEN':'tok','TRACE_ID':'tr-1'})
        self.assertEqual(servers[0]['bearer_token'],'tok')
        self.assertEqual(servers[0]['headers'],{'X-Static':'sv','X-Trace':'tr-1'})
    def test_read_child_diagnostics_do_not_mutate_policy(self):
        servers,_=self.parse(HTTP_TOML)  # has explicit allowlist
        self.assertEqual(read_access_diagnostics(servers,'read'),[])
        no_list,_=self.parse('[mcp_servers.open]\ncommand = "x"\n')
        before=dumps(no_list)
        diagnostics=read_access_diagnostics(no_list,'read')
        self.assertEqual([(d.name,d.reason) for d in diagnostics],[('open',
            'read child: server has no explicit enabled_tools allowlist; only readOnly tools are visible and every call confirms')])
        self.assertEqual(read_access_diagnostics(no_list,'write'),[])
        self.assertEqual(dumps(no_list),before)
    def test_diagnostics_are_str_only(self):
        # F10: missing default skills dir previously put a Path object into the diagnostic.
        skills,diag=collect_skills(self.home,{},None,[])
        dumps([d.as_dict() for d in diag])  # must not raise
        self.assertTrue(all(isinstance(d.as_dict()['name'],str) for d in diag))
    def test_capture_scope_env_is_minimal(self):
        (self.home/'config.toml').write_text(STDIO_TOML+'[mcp_servers.w2]\nurl="https://e.example"\nbearer_token_env_var="BT"\n')
        environ={'PATH':'/bin','HOME':'/h','TOKEN_VAR':'tv','BT':'bt','ANTHROPIC_API_KEY':'sk-test',
                 'UNRELATED_SECRET':'nope','CODEX_HOME':str(self.home)}
        snap=capture_scope_env(self.home,environ,extra_names=('ANTHROPIC_API_KEY',))
        self.assertIn('TOKEN_VAR',snap); self.assertIn('BT',snap); self.assertIn('PATH',snap)
        self.assertEqual(snap['ANTHROPIC_API_KEY'],'sk-test')  # authorized child-env name is captured for model auth
        self.assertNotIn('UNRELATED_SECRET',snap)
        servers,_=self.parse(STDIO_TOML+'[mcp_servers.w2]\nurl="https://e.example"\nbearer_token_env_var="BT"\n')
        self.assertEqual(set(referenced_env_names(servers)),{'PATH','HOME','LANG','LC_ALL','TERM','TMPDIR','SHELL','USER','LOGNAME',
            'PI_CODING_AGENT_DIR','CODEX_HOME','TOKEN_VAR','BT'})

class RuntimeInheritance(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-rt-')
        self.root=Path(self.tmp.name); self.home=self.root/'state'; self.home.mkdir()
        self.workspace=self.root/'workspace'; self.workspace.mkdir()
        self.codex=make_codex_home(self.root/'src',config=STDIO_TOML)
        make_skill(self.codex/'skills','alpha')
        make_skill(self.workspace/'.agents'/'skills','projskill')
        (self.root/'src'/'server.py').write_text(
            'import sys,json\n'
            'for line in sys.stdin:\n'
            '    r=json.loads(line)\n'
            '    if "id" in r: print(json.dumps({"id":r["id"],"result":{"tools":[]}}),flush=True)\n')
        config=STDIO_TOML
        config+='\n[mcp_servers.localtest]\ncommand = "python3"\nargs = ["server.py"]\nenv_vars = ["SECRET_CANARY"]\n'
        config+=f'\n[mcp_servers.localtest.env]\nFAKE_TEST_ECHO = "echo-ok"\n'
        (self.codex/'config.toml').write_text(config)
        (self.codex/'servers').mkdir()
        (self.home/'config.toml').write_text('pi_command = '+fake_pi_command()+'\nrpc_timeout_seconds = 8\nstartup_timeout_seconds = 25\n')
        self.rt=Runtime(self.home)
        result=await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)},
            source={'env':{'CODEX_HOME':str(self.codex),'SECRET_CANARY':'canary-值-2026','PATH':os.environ['PATH'],'HOME':os.environ['HOME']}})
        self.scope=result['scope']
        self.n=0
    async def asyncTearDown(self):
        await self.rt.shutdown(); self.tmp.cleanup()
    def key(self): self.n+=1; return 'req-'+str(self.n)
    async def spawn(self,**extra):
        return await self.rt.dispatch('spawn',{'scope':self.scope,'request_id':self.key(),
            'cwd':str(self.workspace),'task':'simple','access':'read',**extra})
    async def test_required_malformed_env_vars_blocks_before_subprocess_start(self):
        (self.codex/'config.toml').write_text(
            '[mcp_servers.broken]\ncommand = "cat"\nrequired = true\nenv_vars = "API_KEY"\n')
        with mock.patch('subagent_pi.runtime.asyncio.create_subprocess_exec') as start:
            with self.assertRaises(AgentError) as caught:
                await self.spawn()
        self.assertEqual(caught.exception.code, 'inheritance_required_server_failed')
        start.assert_not_called()
        self.assertFalse(self.rt.workers)
        self.assertEqual(self.run_rows(), [('failed',)])
    async def test_required_server_failure_blocks_spawn_without_prompt(self):
        # F11: a broken REQUIRED server aborts the boot; no prompt is ever sent
        # and the worker does not linger.
        (self.codex/'config.toml').write_text(
            '[mcp_servers.broken]\ncommand = "/definitely/missing/binary"\nrequired = true\n')
        before=self.fake_prompt_count()
        with self.assertRaises(AgentError) as cm:
            await self.spawn()
        self.assertEqual(cm.exception.code,'inheritance_required_server_failed')
        self.assertTrue(all(r[0] not in ('starting','running','queued') for r in self.run_rows()),
                        f'runs not terminal: {self.run_rows()}')
        self.assertTrue(all(w.closed for w in self.rt.workers.values()))  # half-started workers are terminated
        self.assertEqual(self.fake_prompt_count(),before+1)  # the failed run is recorded, never sent
        (self.codex/'config.toml').write_text(STDIO_TOML)
    def fake_prompt_count(self):
        con=sqlite3.connect(f'file:{self.home}/registry.sqlite?mode=ro',uri=True)
        try:
            rows=con.execute("SELECT task FROM runs").fetchall()
        finally: con.close()
        return len(rows)
    def run_rows(self):
        con=sqlite3.connect(f'file:{self.home}/registry.sqlite?mode=ro',uri=True)
        try:
            rows=con.execute("SELECT state FROM runs").fetchall()
        finally: con.close()
        return rows
    async def test_scope_binding_persists_nonsecret_source(self):
        row=self.rt.store.scope(self.scope)
        self.assertEqual(row['codex_home'],str(self.codex))
        self.assertEqual(row['codex_source'],'scope_env')
        self.assertEqual(self.rt.bindings.scope_env[self.scope]['SECRET_CANARY'],'canary-值-2026')
    def snapshot(self,root: Path):
        return {str(p.relative_to(root)):p.stat().st_size for p in root.rglob('*') if p.is_file()}
    async def test_boot_writes_skills_and_marker_without_disk_config(self):
        before_state=self.snapshot(self.home); before_codex=self.snapshot(self.codex)
        s=await self.spawn()
        w=self.rt.workers[s['agent_id']]
        launch=json.loads((self.home/'agents'/s['agent_id']/'launch.json').read_text())
        argv=launch['argv']
        skill_paths=[argv[i+1] for i,f in enumerate(argv) if f=='--skill']
        self.assertIn(str(self.codex/'skills'/'alpha'),skill_paths)
        self.assertIn(str(self.workspace/'.agents'/'skills'/'projskill'),skill_paths)
        self.assertIn(str(BRIDGE),argv)
        self.assertIn('--no-context-files',argv)
        self.assertIn(str(ROOT/'extensions/managed-context.ts'),argv)
        # No --tools: that allowlist would drop the tools Pi's own extensions register.
        self.assertNotIn('--tools',argv)
        self.assertNotIn('--no-tools',argv)
        self.assertNotIn('--no-extensions',argv)
        self.assertNotIn('--no-skills',argv)
        stderr=(self.home/'agents'/s['agent_id']/'stderr.log').read_text()
        self.assertIn('subagent-pi-bridge ready servers=1 names=localtest',stderr)
        self.assertIn('bridge-env localtest=echo-ok',stderr)
        # filesrv is excluded because its TOKEN_VAR is absent from the scope snapshot.
        diag_events=[json.loads(e['payload']) for e in self.rt.store.all("SELECT payload FROM events WHERE type='inheritance_diagnostics'")]
        self.assertTrue(any('TOKEN_VAR' in d.get('reason','') for x in diag_events for d in x.get('diagnostics',[])))
        # No inherited configuration landed on disk; the codex source tree is untouched.
        after_codex=self.snapshot(self.codex)
        self.assertEqual(before_codex,after_codex)  # codex source tree untouched
        await self.mutation_close(s['agent_id'])
    async def mutation_close(self,aid):
        return await self.rt.dispatch('close',{'scope':self.scope,'agent_id':aid,'request_id':self.key()})
    def add_ambient_profile(self, *names, tools=('read','grep','find','ls')):
        """A profile whose child Pi brings its OWN skills, like a real Pi user
        configuration. PI_TEST_AMBIENT_SKILL_DIRS is how the fake Pi stands in for
        Pi's own discovery (the real-Pi test covers the real loader)."""
        skills_dir=self.root/'pi-agent'/'skills'
        for name in names: make_skill(skills_dir,name)
        self.rt.config['profiles']['ambient']={'tools':list(tools),
            'env':{'PI_TEST_AMBIENT_SKILL_DIRS':str(skills_dir)}}
        return skills_dir
    def events_of(self, aid, kind):
        return [json.loads(r['payload']) for r in self.rt.store.all(
            "SELECT payload FROM events WHERE agent_id=? AND type=? ORDER BY rowid",(aid,kind))]
    async def test_pi_skill_owns_a_duplicate_name_and_the_boot_records_it(self):
        ambient=self.add_ambient_profile('alpha')  # same declared name as the codex skill
        s=await self.spawn(profile='ambient'); aid=s['agent_id']
        # Pi resolves the collision itself: its own skill is registered, the
        # inherited path was passed but never entered the registry. The record
        # below is what the child reported through get_commands, not a guess.
        record=self.events_of(aid,'inheritance_skills')[-1]
        entry=[i for i in record['inherited'] if i['name']=='alpha'][0]
        self.assertEqual(entry['state'],'skipped')
        self.assertEqual(entry['kept'],str((ambient/'alpha'/'SKILL.md').resolve()))
        self.assertEqual([i for i in record['inherited'] if i['path'].endswith('projskill')][0]['state'],'loaded')
        self.assertIn({'name':'alpha','path':str((ambient/'alpha'/'SKILL.md').resolve())},record['pi_skills'])
        await self.mutation_close(aid)
    async def test_unique_inherited_skills_load_next_to_pi_skills(self):
        ambient=self.add_ambient_profile('pi-only')
        s=await self.spawn(profile='ambient'); aid=s['agent_id']
        record=self.events_of(aid,'inheritance_skills')[-1]
        states={i['path']:i['state'] for i in record['inherited']}
        self.assertEqual(states[str(self.codex/'skills'/'alpha')],'loaded')
        self.assertEqual(states[str(self.workspace/'.agents'/'skills'/'projskill')],'loaded')
        self.assertIn({'name':'pi-only','path':str((ambient/'pi-only'/'SKILL.md').resolve())},record['pi_skills'])
        await self.mutation_close(aid)
    async def test_unloadable_inherited_skill_is_reported_not_invented(self):
        # A skill Pi refuses to load (no description) is neither "loaded" nor a
        # name collision: the record says not_loaded instead of guessing.
        (self.codex/'skills'/'alpha'/'SKILL.md').write_text('---\nname: alpha\n---\n\nonly a body\n')
        s=await self.spawn(); aid=s['agent_id']
        record=self.events_of(aid,'inheritance_skills')[-1]
        entry=[i for i in record['inherited'] if i['name']=='alpha'][0]
        self.assertEqual(entry['state'],'not_loaded')
        await self.mutation_close(aid)
    async def test_launch_argv_leaves_pi_configuration_alone(self):
        s=await self.spawn(); aid=s['agent_id']
        argv=json.loads((self.home/'agents'/aid/'launch.json').read_text())['argv']
        for flag in ('--no-extensions','--no-skills','--tools','--no-tools','--exclude-tools'): self.assertNotIn(flag,argv)
        self.assertIn(str(SURFACE),argv)
        await self.mutation_close(aid)
    def restricted_profile(self, **env):
        """A reader-shaped profile whose extra env controls the fake Pi's surface
        report (the fake stands in for extensions/managed-surface.ts)."""
        self.rt.config['profiles']['restricted']={'tools':['read','grep','find','ls'],'env':dict(env)}
        return 'restricted'
    async def test_restricted_launch_records_the_verified_builtin_surface(self):
        s=await self.spawn(profile=self.restricted_profile()); aid=s['agent_id']
        report=self.events_of(aid,'tool_surface')[-1]
        self.assertTrue(report['ok'])
        self.assertEqual(report['allowed'],'find,grep,ls,read')
        self.assertEqual(report['builtins'],'find,grep,ls,read')   # applied == allowed, read back
        self.assertEqual(report['expected'],report['builtins'])
        await self.mutation_close(aid)
    async def test_full_builtin_profile_needs_no_surface_report(self):
        # No restriction means no plan and no claim to verify: a missing report
        # cannot fail a profile that allows every built-in tool. (write access:
        # read access narrows the built-in list, which is a restriction again.)
        from subagent_pi.config import PI_BUILTIN_TOOLS
        self.rt.config['profiles']['allbuiltins']={'tools':list(PI_BUILTIN_TOOLS),'env':{'PI_TEST_SURFACE':'missing'}}
        s=await self.spawn(profile='allbuiltins',access='write'); aid=s['agent_id']
        self.assertEqual(self.events_of(aid,'tool_surface'),[])
        await self.mutation_close(aid)
    async def test_missing_surface_report_fails_the_launch(self):
        import subagent_pi.worker as worker_module
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
        self.assertTrue(all(w.closed for w in self.rt.workers.values()))  # no unverified worker survives
    async def test_mismatched_surface_report_fails_the_launch(self):
        with self.assertRaises(AgentError) as cm:
            await self.spawn(profile=self.restricted_profile(PI_TEST_SURFACE='mismatch'))
        self.assertEqual(cm.exception.code,'tool_surface_unapplied')
        aid=cm.exception.details['agent_id']
        report=self.events_of(aid,'tool_surface')[-1]
        self.assertFalse(report['ok'])
        self.assertEqual(report['builtins'],'find,grep,ls')   # the child's real state, not the wish
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
        await self.mutation_close(aid)
    async def test_read_profile_may_load_extensions(self):
        # The old read+extension rejection is gone: Pi's own configuration loads
        # in every profile, so a read child's limits are its builtin allowlist,
        # the MCP exposure policy and writer exclusivity - never a read-only
        # claim about the extensions Pi loads.
        ext=self.root/'custom-ext.ts'; ext.write_text('export default () => {}\n')
        self.rt.config['profiles']['reader-ext']={'tools':['read','grep','find','ls'],'extensions':[str(ext)]}
        s=await self.spawn(profile='reader-ext'); aid=s['agent_id']
        argv=json.loads((self.home/'agents'/aid/'launch.json').read_text())['argv']
        self.assertIn(str(ext),argv)  # profile extension loads in a read child
        await self.mutation_close(aid)
    async def test_canary_never_reaches_disk(self):
        s=await self.spawn()
        await asyncio.sleep(0.2)
        needle=b'canary-\xe5\x80\xbc-2026'
        for p in self.home.rglob('*'):
            if p.is_file():
                if p.suffix in ('.sqlite','.db') or 'registry' in p.name:
                    continue
                self.assertNotIn(needle,p.read_bytes(),f'canary leaked into {p}')
        db=sqlite3.connect(self.home/'registry.sqlite')
        for table in ('agents','scopes','runs','events','requests','receipts','meta'):
            for row in db.execute(f'SELECT * FROM {table}'):
                for cell in row:
                    if isinstance(cell,bytes): self.assertNotIn(needle,cell)
                    if isinstance(cell,str): self.assertNotIn('canary-值-2026',cell)
        db.close()
        for p in Path(os.environ.get('XDG_RUNTIME_DIR','/tmp')).glob(f'subagent-pi-*'):
            self.assertNotIn(needle,p.read_bytes() if p.is_file() else b'')
    async def test_respawn_rebuilds_inheritance_without_argv_growth(self):
        s=await self.spawn()
        aid=s['agent_id']
        await self.mutation_close(aid)
        first=json.loads((self.home/'agents'/aid/'launch.json').read_text())['argv']
        # Existing sessions created before this policy still have their old
        # persisted argv. Boot must add context isolation without mutating it.
        legacy=json.loads(self.rt.store.agent(self.scope,aid)['launch'])
        context_path=str(ROOT/'extensions/managed-context.ts')
        index=legacy['argv'].index(context_path)
        del legacy['argv'][index-1:index+1]
        legacy['argv'].remove('--no-context-files')
        self.rt.store.agent_update(aid,launch=json.dumps(legacy))
        # Source change: skill removed; respawn must reflect it, not accumulate flags.
        shutil.rmtree(self.codex/'skills'/'alpha')
        await self.rt.dispatch('respawn',{'scope':self.scope,'agent_id':aid,'request_id':self.key()})
        second=json.loads((self.home/'agents'/aid/'launch.json').read_text())['argv']
        await self.mutation_close(aid)
        await self.rt.dispatch('respawn',{'scope':self.scope,'agent_id':aid,'request_id':self.key()})
        third=json.loads((self.home/'agents'/aid/'launch.json').read_text())['argv']
        self.assertNotIn(str(self.codex/'skills'/'alpha'),second)
        # Model pinning survives respawns exactly once; inheritance flags never accumulate.
        self.assertEqual(second.count('--model'),1)
        self.assertEqual(third.count('--model'),1)
        self.assertLessEqual(third.count('--skill'),second.count('--skill'))
        self.assertIn(str(BRIDGE),third)
        self.assertEqual(second.count('--no-context-files'),1)
        self.assertEqual(third.count('--no-context-files'),1)
        self.assertEqual(third.count(context_path),1)
        self.assertEqual(third.count('--extension'),3)  # context + surface + bridge, never accumulating
        await self.mutation_close(aid)
    async def test_disabled_inheritance_leaves_original_path(self):
        # Per-scope management switch: an explicit scope_open with inheritance=false.
        await self.rt.dispatch('scope_open',{'cwd':str(self.workspace),'scope':self.scope,'inheritance':False},
            source={'env':{'CODEX_HOME':str(self.codex),'PATH':os.environ['PATH']}})
        s=await self.rt.dispatch('spawn',{'scope':self.scope,'request_id':self.key(),
            'cwd':str(self.workspace),'task':'simple','access':'read'})
        launch=json.loads((self.home/'agents'/s['agent_id']/'launch.json').read_text())
        self.assertNotIn('--skill',launch['argv'])
        self.assertNotIn(str(BRIDGE),launch['argv'])  # no inherited bridge
        self.assertIn(str(SURFACE),launch['argv'])      # profile tool surface stays
        await self.rt.dispatch('close',{'scope':self.scope,'agent_id':s['agent_id'],'request_id':self.key()})
    async def test_source_conflict_requires_explicit_rebind(self):
        other=make_codex_home(self.root/'other')
        with self.assertRaises(AgentError) as cm:
            await self.rt.dispatch('scope_open',{'cwd':str(self.workspace),'scope':self.scope},
                source={'env':{'CODEX_HOME':str(other),'PATH':os.environ['PATH']}})
        self.assertEqual(cm.exception.code,'inheritance_source_conflict')
        r=await self.rt.dispatch('scope_open',{'cwd':str(self.workspace),'scope':self.scope,'codex_home':str(other)},
            source={'env':{'PATH':os.environ['PATH']}})
        self.assertEqual(self.rt.store.scope(self.scope)['codex_home'],str(other))
    async def test_doctor_reports_names_not_values(self):
        s=await self.spawn()
        report=(await self.rt.dispatch('doctor',{'inheritance':True}))['inheritance']
        blob=json.dumps(report)
        self.assertIn('canary' if False else 'SECRET_CANARY',blob)  # variable NAME is allowed
        self.assertNotIn('canary-值-2026',blob)  # value is not
        scope_report=[x for x in report['scopes'] if x['scope']==self.scope][0]
        self.assertEqual(scope_report['source_mode'],'scope_env')
        self.assertIn('SECRET_CANARY',scope_report['bound_env_names'])
        self.assertTrue(any(x['name']=='localtest' for x in scope_report['mcp_servers']))
        await self.mutation_close(s['agent_id'])
    async def test_bootstrap_write_failure_recorded_without_payload(self):
        r,w=os.pipe()
        os.close(r)
        await self.rt.record_bootstrap_write(w,'pi_none',9,b'{"mcp":{"servers":[]}}')
        row=self.rt.store.one("SELECT payload FROM events WHERE type='bootstrap_write_failed' ORDER BY seq DESC LIMIT 1")
        self.assertIsNotNone(row)
        self.assertEqual(json.loads(row['payload'])['error'],'BrokenPipeError')

class StoreMigration(unittest.TestCase):
    def test_v5_upgrade_preserves_queued_notification_receipts(self):
        with tempfile.TemporaryDirectory(prefix='notification-migration-') as path:
            base=Path(path)
            with sqlite3.connect(base/'registry.sqlite') as db:
                db.executescript('''
                CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
                INSERT INTO meta VALUES('schema','5');
                CREATE TABLE parent_notifications(id TEXT PRIMARY KEY,scope TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,ui_id TEXT,state TEXT NOT NULL DEFAULT 'pending',queued_id TEXT,error TEXT,created REAL NOT NULL);
                INSERT INTO parent_notifications(id,scope,run_id,kind,state,queued_id,created)
                    VALUES('notice_old','scope_old','run_old','terminal','queued','receipt_old',1);
                ''')
            store=Store(base)
            try:
                row=store.one("SELECT state,queued_id,handled FROM parent_notifications WHERE id='notice_old'")
                self.assertEqual(row,{'state':'queued','queued_id':'receipt_old','handled':0})
                self.assertEqual(store.one("SELECT value FROM meta WHERE key='schema'")['value'],str(SCHEMA_VERSION))
            finally: store.close()

    def test_v1_and_v2_databases_upgrade_without_losing_scope_data(self):
        # Schema 2 was written by 0.2.7; both old shapes must reach the current ledger.
        for version in (1, 2):
            with self.subTest(version=version), tempfile.TemporaryDirectory(prefix='inh-mig-') as path:
                base=Path(path)
                old_columns=',codex_home TEXT,codex_source TEXT,inheritance INTEGER NOT NULL DEFAULT 1' if version==2 else ''
                db=sqlite3.connect(base/'registry.sqlite')
                db.executescript(f'''
                CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE runs(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,task TEXT NOT NULL,created REAL NOT NULL,started REAL,ended REAL,deadline REAL,result_path TEXT,result_sha TEXT,ack INTEGER NOT NULL DEFAULT 0,error TEXT,usage TEXT NOT NULL DEFAULT '{{}}');
                CREATE TABLE scopes(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,label TEXT NOT NULL,created REAL NOT NULL,revision INTEGER NOT NULL DEFAULT 0{old_columns});
                INSERT INTO meta VALUES('schema','{version}');
                INSERT INTO scopes(id,cwd,label,created) VALUES('scope_x','/tmp','old',1);
                ''')
                if version==2: db.execute("UPDATE scopes SET codex_source='scope_env' WHERE id='scope_x'")
                db.commit(); db.close()
                store=Store(base)
                cols={r['name'] for r in store.all('PRAGMA table_info(scopes)')}
                self.assertIn('base_env',cols)
                self.assertEqual(store.one("SELECT value FROM meta WHERE key='schema'")['value'],str(SCHEMA_VERSION))
                scope=store.scope('scope_x')
                if version==1:
                    self.assertIn('codex_home',cols); self.assertIn('inheritance',cols)
                    self.assertEqual(scope['inheritance'],1)
                else: self.assertEqual(scope['codex_source'],'scope_env')
                store.close()
    def test_future_schema_is_refused(self):
        tmp=tempfile.TemporaryDirectory(prefix='inh-mig3-'); base=Path(tmp.name)
        db=sqlite3.connect(base/'registry.sqlite')
        db.executescript("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema','999');")
        db.commit(); db.close()
        with self.assertRaises(AgentError) as cm: Store(base)
        self.assertEqual(cm.exception.code,'version_mismatch')
        tmp.cleanup()

class RealPiBridge(unittest.IsolatedAsyncioTestCase):
    """Real Pi process + real TS bridge. NOT in the default suite.

    Requires explicit SUBAGENT_PI_LIVE_PI=1. It boots a real Pi worker and
    verifies the extension loads and reports ready through the receipt channel;
    it never sends a business prompt, so no model call is possible.
    """
    async def asyncSetUp(self):
        if os.environ.get('SUBAGENT_PI_LIVE_PI')!='1':
            raise unittest.SkipTest('set SUBAGENT_PI_LIVE_PI=1 to run the real-Pi check; default suite never launches Pi')
        if not shutil.which('pi'): self.skipTest('pi executable not available')
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-live-')
        self.root=Path(self.tmp.name); self.home=self.root/'state'; self.home.mkdir()
        self.workspace=self.root/'workspace'; self.workspace.mkdir()
        self.codex=make_codex_home(self.root/'src')
        (self.root/'srv.py').write_text(ECHO_SERVER_SOURCE)
        (self.codex/'config.toml').write_text(
            '[mcp_servers.echosrv]\ncommand = "python3"\nargs = ["../srv.py"]\n'.replace('../srv.py',str(self.root/'srv.py')))
        (self.home/'config.toml').write_text('pi_command = ["pi"]\nrpc_timeout_seconds = 15\nstartup_timeout_seconds = 40\n')
        self.rt=Runtime(self.home)
        r=await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)},
            source={'env':{'CODEX_HOME':str(self.codex),'PATH':os.environ['PATH'],'HOME':os.environ['HOME']}})
        self.scope=r['scope']
        # Boot only: start_run is stubbed so no business prompt (and therefore no
        # model request) can ever be sent from this test.
        async def _no_prompt(w,rid): return None
        self.rt.start_run=_no_prompt
    async def asyncTearDown(self):
        await self.rt.shutdown(); self.tmp.cleanup()
    async def test_bridge_loads_in_real_pi_child(self):
        s=await self.rt.dispatch('spawn',{'scope':self.scope,'request_id':'live-1',
            'cwd':str(self.workspace),'task':'simple','access':'read'})
        aid=s['agent_id']
        stderr=(self.home/'agents'/aid/'stderr.log').read_text()
        self.assertIn('subagent-pi-bridge ready servers=1',stderr)
        # The daemon accepted the bridge receipt for this agent/generation.
        events=[json.loads(e['payload']) for e in self.rt.store.all(
            "SELECT payload FROM events WHERE agent_id=? AND type='bridge_receipt'",(aid,))]
        self.assertTrue(any(x.get('state')=='ready' and x.get('agent')==aid for x in events))
        await self.rt.dispatch('close',{'scope':self.scope,'agent_id':aid,'request_id':'live-close'})
        self.assertIn('--extension',' '.join(json.loads((self.home/'agents'/aid/'launch.json').read_text())['argv']))
        await self.rt.dispatch('close',{'scope':self.scope,'agent_id':aid,'request_id':'live-close'})

class RealPiSkillBoundary(unittest.IsolatedAsyncioTestCase):
    """Real Pi loader, real skill files, real tool registry, real get_commands.
    NOT in the default suite (SUBAGENT_PI_LIVE_PI=1) and no model call: start_run
    is stubbed.

    Covers the boundaries the fake Pi can only simulate: Pi's own discovery loads
    the skill directory the CLIENT bound, Pi resolves a skill name collision in
    its own favour, an ambient extension that shadows a built-in tool name keeps
    working, and the daemon's built-in surface plan is verified against Pi's live
    registry (which an independent probe extension reports).
    """
    async def asyncSetUp(self):
        if os.environ.get('SUBAGENT_PI_LIVE_PI')!='1':
            raise unittest.SkipTest('set SUBAGENT_PI_LIVE_PI=1 to run the real-Pi check; default suite never launches Pi')
        if not shutil.which('pi'): self.skipTest('pi executable not available')
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-live-skills-')
        self.root=Path(self.tmp.name); self.home=self.root/'state'; self.home.mkdir()
        self.workspace=self.root/'workspace'; self.workspace.mkdir()
        self.temp_home=self.root/'home'; self.temp_home.mkdir()
        # The agent config directory comes from the CLIENT environment; the
        # default location under this HOME holds a skill that must NOT appear.
        self.agent_dir=self.root/'pi-agent'
        make_skill(self.agent_dir/'skills','dup',body='Pi version of the duplicate.')
        make_skill(self.agent_dir/'skills','pi-only')
        make_skill(self.temp_home/'.pi'/'agent'/'skills','fallback-only')
        self.codex=make_codex_home(self.root/'src')
        make_skill(self.codex/'skills','dup',body='Codex version of the duplicate.')
        make_skill(self.codex/'skills','codex-only')
        make_skill(self.workspace/'.agents'/'skills','projskill')
        (self.root/'srv.py').write_text(ECHO_SERVER_SOURCE)
        (self.codex/'config.toml').write_text(
            '[mcp_servers.echosrv]\ncommand = "python3"\nargs = ["%s"]\n' % (self.root/'srv.py'))
        (self.home/'config.toml').write_text(
            'pi_command = ["pi"]\nrpc_timeout_seconds = 15\nstartup_timeout_seconds = 40\n'
            '\n[profiles.reader.env]\n'
            'PI_OFFLINE = "1"\nPI_SKIP_VERSION_CHECK = "1"\nPI_TELEMETRY = "0"\n')
        self.rt=Runtime(self.home); self.closed=False
        self.client_env={'CODEX_HOME':str(self.codex),'PATH':os.environ['PATH'],
                         'HOME':str(self.temp_home),'PI_CODING_AGENT_DIR':str(self.agent_dir)}
        r=await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)},source={'env':self.client_env})
        self.scope=r['scope']
        async def _no_prompt(w,rid): return None
        self.rt.start_run=_no_prompt
    async def asyncTearDown(self):
        if not self.closed: await self.rt.shutdown()
        self.tmp.cleanup()
    def spawn(self,rid):
        return self.rt.dispatch('spawn',{'scope':self.scope,'request_id':rid,
            'cwd':str(self.workspace),'task':'simple','access':'read'})
    def stderr_of(self,aid):
        path=self.home/'agents'/aid/'stderr.log'
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            text=path.read_text(errors='replace') if path.exists() else ''
            if 'subagent-pi-surface applied' in text and 'PROBE_TOOLS ' in text: return text
            time.sleep(0.1)
        return path.read_text(errors='replace') if path.exists() else ''
    def write_probe_extension(self, override=()):
        """An ambient Pi extension in the bound agent directory. It registers
        tools that shadow built-in names (when asked) and reports Pi's live
        registry, so tests compare ordinary Pi with a managed child instead of
        trusting the plugin's own evidence line."""
        path=self.agent_dir/'extensions'/'probe.ts'; path.parent.mkdir(parents=True,exist_ok=True)
        registered=''.join(
            "  pi.registerTool({name: %r, label: %r, description: 'override', parameters: {type:'object',properties:{}}, "
            "async execute(){return {content:[{type:'text',text:'override'}]}}});\n" % (name,name) for name in override)
        path.write_text(
            "export default function (pi) {\n"
            + registered +
            "  pi.on('session_start', function () {\n"          # synchronous: Pi does not run extension timers in this mode
            "    try { process.stderr.write('PROBE_TOOLS '+JSON.stringify({"
            "active: pi.getActiveTools(), all: pi.getAllTools().map(function (t) { return {name: t.name, path: t.sourceInfo && t.sourceInfo.path}; })})+'\\n'); }\n"
            "    catch (e) { process.stderr.write('PROBE_TOOLS_ERR '+String(e)+'\\n'); }\n"
            "  });\n"
            "}\n")
        return path
    def plain_pi_probe(self, timeout=25.0, cwd=None):
        """Ordinary Pi session (no daemon, no managed plan) with the same agent
        directory: the baseline that proves an overriding extension works at all."""
        env={'PATH':os.environ['PATH'],'HOME':str(self.temp_home),'PI_CODING_AGENT_DIR':str(self.agent_dir),
             'PI_OFFLINE':'1','PI_SKIP_VERSION_CHECK':'1','PI_TELEMETRY':'0'}
        proc=subprocess.Popen(['pi','--mode','rpc'],cwd=str(cwd or self.workspace),env=env,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            proc.stdin.write(json.dumps({'id':'probe','type':'get_state'})+'\n'); proc.stdin.flush()
            deadline=time.monotonic()+timeout; line=None
            while time.monotonic()<deadline:
                ready,_,_=select.select([proc.stderr],[],[],0.5)
                if not ready: continue
                line=proc.stderr.readline()
                if not line: break
                if line.startswith('PROBE_TOOLS '): break
            if not line or not line.startswith('PROBE_TOOLS '):
                raise AssertionError('ordinary Pi never reported PROBE_TOOLS')
            return json.loads(line[len('PROBE_TOOLS '):])
        finally:
            proc.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired): proc.communicate(timeout=10)
            if proc.poll() is None: proc.kill(); proc.communicate()
    def active_tools(self, probe):
        return set(probe['active'])
    def tool_path(self, probe, name):
        for entry in probe['all']:
            if entry['name']==name: return entry.get('path')
        return None
    async def test_client_bound_directory_wins_over_the_default_home_directory(self):
        s=await self.spawn('live-agentdir-1'); aid=s['agent_id']
        record=[json.loads(e['payload']) for e in self.rt.store.all(
            "SELECT payload FROM events WHERE agent_id=? AND type='inheritance_skills'",(aid,))][-1]
        names={p['name']:p['path'] for p in record['pi_skills']}
        self.assertIn('pi-only',names)          # the directory the client bound was opened
        self.assertIn('dup',names)
        for path in names.values():
            self.assertTrue(path.startswith(str(self.agent_dir)),path)
        self.assertNotIn('fallback-only',names)  # HOME/.pi/agent was not the directory Pi used
        dup=[i for i in record['inherited'] if i['name']=='dup'][0]
        self.assertEqual(dup['state'],'skipped')
        self.assertEqual(dup['kept'],str((self.agent_dir/'skills'/'dup'/'SKILL.md').resolve()))
        loaded={i['name']:i['state'] for i in record['inherited']}
        self.assertEqual(loaded['codex-only'],'loaded')
        self.assertEqual(loaded['projskill'],'loaded')
        self.closed=True; await self.rt.dispatch('close',{'scope':self.scope,'agent_id':aid,'request_id':'live-agentdir-close-1'})
    async def test_extension_tool_shadowing_a_builtin_survives_in_both_pis(self):
        probe_ext=self.write_probe_extension(override=('bash',))
        baseline=self.plain_pi_probe()
        self.assertIn('bash',self.active_tools(baseline))
        self.assertEqual(self.tool_path(baseline,'bash'),str(probe_ext))  # the override really wins in ordinary Pi
        s=await self.spawn('live-override-2'); aid=s['agent_id']
        stderr=self.stderr_of(aid)
        probe=json.loads(stderr.split('PROBE_TOOLS ',1)[1].splitlines()[0])
        self.assertEqual(self.tool_path(probe,'bash'),str(probe_ext))
        self.assertIn('bash',self.active_tools(probe))                    # ... and the managed child keeps it
        for name in ('edit','write'):                                     # real built-ins stay restricted
            self.assertEqual(self.tool_path(probe,name),f'builtin:{name}')
            self.assertNotIn(name,self.active_tools(probe))
        evidence=parse_surface(stderr)
        self.assertEqual(evidence['ok'],'true')
        self.assertEqual(sorted(evidence['builtins'].split(',')),['find','grep','ls','read'])
        self.assertEqual(self.active_tools(probe),
                         set(evidence['builtins'].split(',')) | {'bash','codex_mcp','ask_parent'})
        self.closed=True; await self.rt.dispatch('close',{'scope':self.scope,'agent_id':aid,'request_id':'live-override-close-2'})
    async def test_reader_without_an_override_restricts_every_write_builtin(self):
        self.write_probe_extension()
        s=await self.spawn('live-surface-3'); aid=s['agent_id']
        stderr=self.stderr_of(aid)
        probe=json.loads(stderr.split('PROBE_TOOLS ',1)[1].splitlines()[0])
        for name in ('bash','edit','write','powershell'):
            self.assertEqual(self.tool_path(probe,name),f'builtin:{name}')  # registered by Pi ...
            self.assertNotIn(name,self.active_tools(probe))                   # ... but not usable
        for name in ('read','grep','find','ls'): self.assertIn(name,self.active_tools(probe))
        self.assertIn('codex_mcp',self.active_tools(probe))                   # Pi's own extension tool kept
        evidence=parse_surface(stderr)
        self.assertEqual(evidence['ok'],'true')
        self.assertEqual(sorted(evidence['builtins'].split(',')),['find','grep','ls','read'])
        self.assertIn('subagent-pi-bridge ready servers=1',stderr)
        self.closed=True; await self.rt.dispatch('close',{'scope':self.scope,'agent_id':aid,'request_id':'live-surface-close-3'})

class BuiltinSurfacePlan(unittest.TestCase):
    """A profile that restricts the built-in surface depends on the shipped
    activator: the launch spec must refuse to start without it (instead of
    launching a child whose built-ins were never bounded), and it must never ask
    Pi to filter tools by name."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-surface-')
        self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name)/'state'; self.home.mkdir()
    def config(self, **profiles):
        config=load_config(self.home); config['pi_command']=[sys.executable]
        config['profiles'].update(profiles)
        return config
    def test_restricting_profile_without_the_extension_is_refused(self):
        gone=Path(self.tmp.name)/'gone.ts'
        with mock.patch('subagent_pi.config.surface_extension_path',return_value=gone):
            with self.assertRaises(AgentError) as cm:
                launch_spec(self.config(),'reader','test/model',str(ROOT),'read')
            self.assertEqual(cm.exception.code,'invalid_config')
            self.assertIn(str(gone),cm.exception.message)
            # A profile that allows every built-in restricts nothing and still starts.
            spec=launch_spec(self.config(allbuiltins={'tools':list(PI_BUILTIN_TOOLS)}),
                             'allbuiltins','test/model',str(ROOT),'write')
            self.assertFalse(spec['surface'])
    def test_restricting_profile_carries_the_surface_plan_and_no_name_filters(self):
        spec=launch_spec(self.config(),'reader','test/model',str(ROOT),'read')
        self.assertTrue(spec['surface'])
        self.assertEqual(spec['builtins'],['read','grep','find','ls'])
        self.assertIn(str(SURFACE),spec['argv'])
        for flag in ('--tools','--no-tools','--exclude-tools'): self.assertNotIn(flag,spec['argv'])

class CliCodexParsing(unittest.TestCase):
    def test_cd_forms_and_separator(self):
        from subagent_pi.cli import split_codex_cwd
        # F02: arguments are returned VERBATIM; only the cwd is scanned out.
        self.assertEqual(split_codex_cwd(['-C','/tmp','run']),('/tmp',['-C','/tmp','run']))
        self.assertEqual(split_codex_cwd(['--cd','/tmp x']),('/tmp x',['--cd','/tmp x']))
        self.assertEqual(split_codex_cwd(['--cd=/a b','exec']),('/a b',['--cd=/a b','exec']))
        self.assertEqual(split_codex_cwd(['-C/attached','run']),('/attached',['-C/attached','run']))
        self.assertEqual(split_codex_cwd(['--','--cd','/x']),(None,['--','--cd','/x']))  # after -- untouched
        self.assertEqual(split_codex_cwd(['exec','--profile','p']),(None,['exec','--profile','p']))
        self.assertEqual(split_codex_cwd(['-C','/a','-C','/b']),('/b',['-C','/a','-C','/b']))  # last wins
        self.assertEqual(split_codex_cwd(['--cd','/中文 目录','run']),('/中文 目录',['--cd','/中文 目录','run']))

class BootstrapStress(unittest.IsolatedAsyncioTestCase):
    async def test_payload_larger_than_pipe_capacity(self):
        tmp=tempfile.TemporaryDirectory(prefix='inh-big-')
        try:
            base=Path(tmp.name); home=base/'state'; home.mkdir(); workspace=base/'ws'; workspace.mkdir()
            codex=make_codex_home(base/'src')
            config=''
            for n in range(8):
                big='x'*100_000
                config+=f'[mcp_servers.big{n}]\ncommand = "python3"\nargs = ["srv.py"]\n\n[mcp_servers.big{n}.env]\nBULK = "{big}"\n\n'
            (codex/'config.toml').write_text(config)
            (home/'config.toml').write_text('pi_command = '+fake_pi_command()+'\nstartup_timeout_seconds = 25\n')
            rt=Runtime(home)
            try:
                r=await rt.dispatch('scope_open',{'cwd':str(workspace)},
                    source={'env':{'CODEX_HOME':str(codex),'PATH':os.environ['PATH'],'HOME':os.environ['HOME']}})
                s=await rt.dispatch('spawn',{'scope':r['scope'],'request_id':'big-1',
                    'cwd':str(workspace),'task':'simple','access':'read'})
                launch=json.loads((home/'agents'/s['agent_id']/'launch.json').read_text())
                stderr=(home/'agents'/s['agent_id']/'stderr.log').read_text()
                self.assertIn('subagent-pi-bridge ready servers=8',stderr)  # ~800KB payload crossed the 64KB pipe
                self.assertIn('--extension',' '.join(launch['argv']))
                await rt.dispatch('close',{'scope':r['scope'],'agent_id':s['agent_id'],'request_id':'big-close'})
            finally:
                await rt.shutdown()
        finally:
            tmp.cleanup()

class RealPiParserProbe(unittest.TestCase):
    """F01 layer-3: the argv the daemon actually launches must parse in Pi's real
    CLI parser as a bounded built-in surface that leaves extension tools alone.
    Static parse only: no Pi process, no model call. Skipped without pi."""
    def pi_args_js(self):
        exe=shutil.which('pi')
        if not exe: return None
        real=Path(exe).resolve()
        for parent in [real.parent,*real.parents]:
            guess=parent/'dist'/'cli'/'args.js'
            if guess.is_file(): return guess
        return None
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='parser-probe-')
        self.addCleanup(self.tmp.cleanup)
        self.config_home=Path(self.tmp.name)/'config'
        self.config_home.mkdir()
    def config(self):
        config=load_config(self.config_home)
        config['pi_command']=[sys.executable]  # executable lookup only; Pi is probed via node
        return config
    def spec(self, profile, access, tools=None):
        config=self.config()
        if tools is not None: config['profiles'][profile]['tools']=tools
        return launch_spec(config,profile,'test/model',str(ROOT),access)
    def probe(self,argv):
        js=self.pi_args_js()
        if js is None: self.skipTest('pi dist/cli/args.js not found')
        script=("const {parseArgs}=require(process.argv[1]);const r=parseArgs(process.argv.slice(2));"
                "console.log(JSON.stringify({tools:r.tools,noTools:r.noTools,noExtensions:r.noExtensions,"
                "noContextFiles:r.noContextFiles,"
                "noSkills:r.noSkills,excludeTools:r.excludeTools,extensions:r.extensions,skills:r.skills}))")
        out=subprocess.run(['node','-e',script,str(js),*argv[1:]],capture_output=True,text=True,timeout=30)
        self.assertEqual(out.returncode,0,out.stderr)
        return json.loads(out.stdout)
    def test_writer_argv_never_names_tools_or_filters_by_name(self):
        argv=self.spec('default','write')['argv']
        parsed=self.probe(argv)
        # --tools is an allowlist over built-in, extension AND custom tools, so
        # using it would drop every tool Pi's own extensions register.
        self.assertIsNone(parsed.get('tools'))
        self.assertIsNone(parsed.get('noTools'))
        self.assertIsNone(parsed.get('noExtensions'))
        self.assertIsNone(parsed.get('noSkills'))
        self.assertTrue(parsed['noContextFiles'])
        # --exclude-tools is name-based over the same registry: an extension that
        # registers a tool named `bash` would be filtered out with the built-in.
        # The built-in surface is applied and verified inside Pi instead.
        self.assertIsNone(parsed.get('excludeTools'))
        self.assertIn(str(ROOT/'extensions/managed-context.ts'),parsed['extensions'])
        self.assertIn(str(SURFACE),parsed['extensions'])
    def test_reader_argv_does_not_exclude_anything_by_name(self):
        spec=self.spec('reader','read')
        parsed=self.probe(spec['argv'])
        self.assertIsNone(parsed.get('excludeTools'))
        self.assertIsNone(parsed.get('tools'))
        self.assertIn(str(SURFACE),parsed['extensions'])
        self.assertTrue(spec['surface'])
    def test_full_builtin_profile_needs_no_surface_plan(self):
        # A profile that allows every built-in restricts nothing, so it neither
        # loads the surface extension nor asks the daemon to verify one.
        spec=self.spec('default','write',tools=list(PI_BUILTIN_TOOLS))
        self.assertFalse(spec['surface'])
        self.assertNotIn(str(SURFACE),spec['argv'])
    def test_empty_builtin_profile_is_still_fail_closed(self):
        # An empty list is a plan ("no built-in tools"), not "no plan": it must
        # ship the surface extension with an empty allowlist.
        spec=self.spec('default','write',tools=[])
        self.assertTrue(spec['surface'])
        self.assertEqual(spec['builtins'],[])
        self.assertIn(str(SURFACE),spec['argv'])
    def test_default_profiles_load_pi_configuration(self):
        for profile in ('default','reader'):
            for argv in (self.spec(profile,'write')['argv'] if profile=='default' else self.spec(profile,'read')['argv'],):
                self.assertNotIn('--no-extensions',argv)
                self.assertNotIn('--no-skills',argv)
                self.assertIn('--no-context-files',argv)
                self.assertIn(str(ROOT/'extensions/managed-context.ts'),argv)
    def test_ambient_opt_out_keeps_the_explicit_flags(self):
        config=self.config()
        config['profiles']['isolated']={'tools':['read'],'ambient_extensions':False,'ambient_skills':False}
        argv=launch_spec(config,'isolated','test/model',str(ROOT),'read')['argv']
        self.assertIn('--no-extensions',argv)
        self.assertIn('--no-skills',argv)
        parsed=self.probe(argv)
        self.assertTrue(parsed['noExtensions'] and parsed['noSkills'])
        self.assertIsNone(parsed.get('excludeTools'))
        self.assertTrue(launch_spec(config,'isolated','test/model',str(ROOT),'read')['surface'])
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
        parsed=self.probe(launch_spec(config,'skilly','test/model',str(ROOT),'read')['argv'])
        self.assertEqual(parsed['skills'],dirs)  # repeatable, inherited flags append without merging

class CodexLauncherProcess(unittest.TestCase):
    """F02 layer-3: a real launcher subprocess must forward Codex's arguments
    verbatim (including -C/--cd) and bind the scope to the target directory.
    The fake codex prints its cwd and argv; nothing touches a real Codex."""
    def test_launcher_forwards_args_and_binds_scope(self):
        tmp=tempfile.TemporaryDirectory(prefix='codex-launch-')
        try:
            root=Path(tmp.name); bin_dir=root/'bin'; bin_dir.mkdir()
            proj=root/'my project'; proj.mkdir()  # space in path on purpose
            fake=bin_dir/'codex'
            fake.write_text('#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({"cwd":os.getcwd(),"argv":sys.argv[1:]}))\n')
            fake.chmod(0o755)
            env={k:v for k,v in os.environ.items() if k not in ('PI_AGENTS_HOME','PI_AGENTS_SCOPE','CODEX_HOME')}
            env['PATH']=f'{bin_dir}{os.pathsep}{env.get("PATH","")}'
            env['PI_AGENTS_HOME']=str(root/'state')
            cli=str(ROOT/'bin'/'subagent-pi')
            def run(*args,**kw):
                return subprocess.run([sys.executable,cli,*args],env=env,capture_output=True,text=True,timeout=90,**kw)
            try:
                proc=run('codex','-C',str(proj),'exec','--profile','p','--','prompt text')
                self.assertEqual(proc.returncode,0,proc.stderr or proc.stdout)
                out=json.loads(proc.stdout)
                # Codex receives the ORIGINAL arguments, unchanged, and runs in
                # the launcher's cwd (Codex applies -C itself).
                self.assertEqual(out['argv'],['-C',str(proj),'exec','--profile','p','--','prompt text'])
                self.assertEqual(Path(out['cwd']),Path(os.getcwd()))
                doc=run('doctor','--inheritance')
                self.assertEqual(doc.returncode,0,doc.stderr)
                report=json.loads(doc.stdout)['inheritance']
                self.assertEqual(report['scopes'][0]['cwd'],str(proj.resolve()))
                # --cd= form and no-override form are also accepted end to end.
                proc2=run('codex','--cd='+str(proj),'run')
                self.assertEqual(proc2.returncode,0,proc2.stderr or proc2.stdout)
                self.assertEqual(json.loads(proc2.stdout)['argv'],['--cd='+str(proj),'run'])
                proc3=run('codex','exec')
                self.assertEqual(proc3.returncode,0,proc3.stderr or proc3.stdout)
                self.assertEqual(json.loads(proc3.stdout)['argv'],['exec'])
            finally:
                stop_daemon(cli,env)
        finally:
            tmp.cleanup()

class ScopeEnvIsolation(unittest.IsolatedAsyncioTestCase):
    """F07 layer-3: each scope's Pi worker must see ITS OWN base env values and
    never a daemon-only canary. Probes flow through get_state responses in
    memory only (fake_pi echoes only PI_TEST_* names, which the canary check
    then proves absent from every control-plane file)."""
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-env-')
        self.root=Path(self.tmp.name); self.home=self.root/'state'; self.home.mkdir()
        (self.home/'config.toml').write_text('pi_command = '+fake_pi_command()+'\nstartup_timeout_seconds = 25\n\n[inheritance]\nchild_env = ["PI_TEST_HOME_TAG"]\n')
        self.rt=Runtime(self.home)
        self.canary='PI_TEST_ENV_CANARY'
        os.environ[self.canary]='daemon-only'  # present in the daemon environ
        self.addAsyncCleanup(os.environ.pop,self.canary,None)
    async def asyncTearDown(self):
        await self.rt.shutdown(); self.tmp.cleanup()
    async def _spawn_with_env(self,label,cwd,env,rid):
        r=await self.rt.dispatch('scope_open',{'cwd':str(cwd),'label':label},source={'env':env})
        scope=r['scope']
        s=await self.rt.dispatch('spawn',{'scope':scope,'request_id':rid,
            'cwd':str(cwd),'task':'simple','access':'read'})
        return scope,s['agent_id']
    async def test_two_scopes_get_their_own_values(self):
        ws_a=self.root/'a'; ws_a.mkdir(); ws_b=self.root/'b'; ws_b.mkdir()
        base={'PATH':os.environ['PATH'],'HOME':os.environ['HOME']}
        scope_a,aid_a=await self._spawn_with_env('a',ws_a,{**base,'PI_TEST_HOME_TAG':'A'},'env-1')
        scope_b,aid_b=await self._spawn_with_env('b',ws_b,{**base,'PI_TEST_HOME_TAG':'B'},'env-2')
        for scope,aid,tag in ((scope_a,aid_a,'A'),(scope_b,aid_b,'B')):
            w=self.rt.workers[aid]
            state=await w.rpc('get_state')
            probe=state.get('env_probe',{})
            self.assertEqual(probe.get('PI_TEST_HOME_TAG'),tag)
            self.assertNotIn(self.canary,probe)  # daemon-only canary never reaches any child
            await self.rt.dispatch('close',{'scope':scope,'agent_id':aid,'request_id':f'close-{tag}'})
    async def test_control_plane_has_no_env_values(self):
        ws=self.root/'c'; ws.mkdir()
        scope,aid=await self._spawn_with_env('c',ws,{**{'PATH':os.environ['PATH'],'HOME':os.environ['HOME']},
                                                     'PI_TEST_SECRET_VAR':'scope-secret-value'},'env-3')
        blobs=[p for p in self.home.rglob('*') if p.is_file() and p.suffix in ('.json','.jsonl','')]
        for p in blobs:
            self.assertNotIn(b'scope-secret-value',p.read_bytes(),p)
        db=self.home/'registry.sqlite'
        if db.exists():
            import sqlite3
            con=sqlite3.connect(f'file:{db}?mode=ro',uri=True)
            try:
                for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                    for row in con.execute(f'SELECT * FROM {table}'):
                        self.assertNotIn('scope-secret-value',str(row))
            finally: con.close()
        wal=self.home/'registry.sqlite-wal'
        if wal.exists():
            self.assertNotIn(b'scope-secret-value',wal.read_bytes())

class CodingAgentDirBinding(unittest.IsolatedAsyncioTestCase):
    """The child Pi must open the agent config dir the CLIENT bound to its scope.
    PI_CODING_AGENT_DIR is a non-secret configuration locator (like HOME), so it
    travels through the real chain — client env -> scope snapshot -> daemon ->
    guard -> Pi — without being listed in inheritance.child_env or profile.env.
    A profile env value keeps priority and an unset variable keeps Pi's default
    (HOME/.pi/agent). The reason this is asserted at the child, not at the
    launch spec: only the child can prove which directory it actually opened."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inh-agentdir-')
        self.root=Path(self.tmp.name); self.home=self.root/'state'; self.home.mkdir()
        self.ws=self.root/'ws'; self.ws.mkdir()
        self.codex=make_codex_home(self.root/'src')
        self.client_dir=self.root/'client-agent'; self.client_dir.mkdir()
        self.profile_dir=self.root/'profile-agent'; self.profile_dir.mkdir()
        self.rt=None
        self.addCleanup(self.tmp.cleanup)
        self.enterContext(mock.patch.dict(os.environ))
        os.environ.pop('PI_CODING_AGENT_DIR',None)
    def write_config(self,extra=''):
        (self.home/'config.toml').write_text('pi_command = '+fake_pi_command()+'\nstartup_timeout_seconds = 25\n'+extra)
    async def asyncTearDown(self):
        if self.rt is not None: await self.rt.shutdown()
    async def _spawn(self,env,rid,profile=None,resume=None):
        """Open (or, for `resume`, simply reuse) a scope and spawn one agent. A
        resumed scope performs no rebind, so only the persisted base snapshot can
        supply the directory — which is what a post-restart worker must rely on."""
        if self.rt is None: self.rt=Runtime(self.home)
        if resume is not None:
            scope=resume
        else:
            source={'env':env}
            if profile is not None: source['profile']=profile
            r=await self.rt.dispatch('scope_open',{'cwd':str(self.ws),'label':'agentdir'},source=source)
            scope=r['scope']
        s=await self.rt.dispatch('spawn',{'scope':scope,'request_id':rid,
            'cwd':str(self.ws),'task':'simple','access':'read'})
        return scope,s['agent_id']
    async def _child_env_probe(self,aid):
        state=await self.rt.workers[aid].rpc('get_state')
        return state.get('env_probe',{})
    async def test_client_bound_directory_reaches_the_child(self):
        self.write_config()
        self.assertNotIn('PI_CODING_AGENT_DIR',os.environ)  # the daemon's own env must not be the source
        scope,aid=await self._spawn({'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],
            'PI_CODING_AGENT_DIR':str(self.client_dir)},'agentdir-1')
        probe=await self._child_env_probe(aid)
        self.assertEqual(probe.get('PI_CODING_AGENT_DIR'),str(self.client_dir))
        await self.rt.dispatch('close',{'scope':scope,'agent_id':aid,'request_id':'agentdir-close-1'})
    async def test_profile_env_keeps_priority(self):
        self.write_config(f'\n[profiles.reader.env]\nPI_CODING_AGENT_DIR = "{self.profile_dir}"\n')
        scope,aid=await self._spawn({'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],
            'PI_CODING_AGENT_DIR':str(self.client_dir)},'agentdir-2')
        probe=await self._child_env_probe(aid)
        self.assertEqual(probe.get('PI_CODING_AGENT_DIR'),str(self.profile_dir))
        await self.rt.dispatch('close',{'scope':scope,'agent_id':aid,'request_id':'agentdir-close-2'})
    async def test_unset_variable_keeps_pi_default(self):
        self.write_config()
        scope,aid=await self._spawn({'PATH':os.environ['PATH'],'HOME':os.environ['HOME']},'agentdir-3')
        probe=await self._child_env_probe(aid)
        self.assertNotIn('PI_CODING_AGENT_DIR',probe)
        await self.rt.dispatch('close',{'scope':scope,'agent_id':aid,'request_id':'agentdir-close-3'})
    async def test_bound_directory_survives_a_daemon_restart(self):
        self.write_config()
        env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'CODEX_HOME':str(self.codex),
             'PI_CODING_AGENT_DIR':str(self.client_dir)}
        scope,aid=await self._spawn(env,'agentdir-4')
        await self.rt.dispatch('close',{'scope':scope,'agent_id':aid,'request_id':'agentdir-close-4'})
        await self.rt.shutdown(); self.rt=None          # a restart drops the in-memory snapshot
        scope2,aid2=await self._spawn(env,'agentdir-5',resume=scope)
        self.assertEqual(scope2,scope)
        probe=await self._child_env_probe(aid2)
        self.assertEqual(probe.get('PI_CODING_AGENT_DIR'),str(self.client_dir))
        await self.rt.dispatch('close',{'scope':scope2,'agent_id':aid2,'request_id':'agentdir-close-5'})

def stop_daemon(cli, env, timeout=15.0):
    """`daemon stop --force` returns when shutdown is *requested*, not when the
    daemon process has exited; wait for the IPC socket (unlinked in the daemon's
    final teardown) to disappear so late daemon writes cannot race
    TemporaryDirectory.cleanup()."""
    subprocess.run([sys.executable, cli, 'daemon', 'stop', '--force'], env=env, capture_output=True, timeout=30)
    sock = socket_path(Path(env['PI_AGENTS_HOME']))
    deadline = time.monotonic() + timeout
    while sock.exists() and time.monotonic() < deadline:
        time.sleep(0.05)

class EnvironmentBindingChain(unittest.TestCase):
    """P1-E end-to-end: a REAL CLI client -> autostarted daemon -> worker guard
    -> fake-Pi subprocess chain. The client process carries a custom PATH, an
    authorized auth canary name (value never asserted nor persisted), a
    daemon-only canary, and the fake Pi records non-secret probe facts through
    its own business-output file. Master switch OFF must keep the base
    environment binding; Codex sources must not even be read."""
    def _client_env(self, state, fakebin, home_tag):
        env={k:v for k,v in os.environ.items() if k not in ('PI_AGENTS_HOME','PI_AGENTS_SCOPE','CODEX_HOME','PI_TEST_AUTH','PI_TEST_DAEMON_ONLY','PI_TEST_HOME_TAG','PI_TEST_PROBE_FILE','PI_TEST_PROBE_CMD')}
        env['PI_AGENTS_HOME']=str(state)
        env['PATH']=f'{fakebin}{os.pathsep}{env.get("PATH","")}'
        env['PI_TEST_AUTH']='real-secret-123'          # value must never surface
        env['PI_TEST_DAEMON_ONLY']='daemon-canary-x'   # must never reach the child
        env['PI_TEST_HOME_TAG']=home_tag
        env['PI_TEST_PROBE_CMD']='tag-interp'
        return env

    def _cli(self, cli, env, *args, check=True):
        proc=subprocess.run([sys.executable,cli,*args],env=env,capture_output=True,text=True,timeout=120)
        if check: self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)
        return proc

    def _scenario(self, state_config, codex_home_value, home_tag):
        cli=str(ROOT/'bin'/'subagent-pi')
        tmp=tempfile.TemporaryDirectory(prefix='env-chain-')
        env=None
        try:
            root=Path(tmp.name); state=root/'state'; state.mkdir()
            ws=root/'ws'; ws.mkdir()
            fakebin=root/'bin'; fakebin.mkdir()
            interp=fakebin/'tag-interp'
            interp.write_text('#!/bin/sh\necho interp-ok\n'); interp.chmod(0o755)
            # A FIFO as config.toml would BLOCK any reader: hard evidence the
            # disabled path never opens the Codex source.
            codex=root/'codex'; codex.mkdir()
            if codex_home_value=='fifo':
                os.mkfifo(codex/'config.toml')
            (state/'config.toml').write_text(state_config)
            probe=root/'probe.json'
            env=self._client_env(state,fakebin,home_tag)
            env['PI_TEST_PROBE_FILE']=str(probe)
            if codex_home_value=='fifo':
                env['CODEX_HOME']=str(codex)
            elif codex_home_value:
                env['CODEX_HOME']=str(codex_home_value)
            opened=self._cli(cli,env,'scope','open','--cwd',str(ws),'--label','chain')
            scope_id=json.loads(opened.stdout)['scope']
            # The client binds the scope it opened; spawning into a DIFFERENT,
            # never-bound scope would legitimately have no base environment.
            spawn=self._cli(cli,env,'spawn','--scope',scope_id,'--cwd',str(ws),'--task','simple','--access','read',check=False)
            self.assertEqual(spawn.returncode,0,spawn.stdout+spawn.stderr)
            agent_id=json.loads(spawn.stdout)['agent_id']
            launch_file=state/'agents'/agent_id/'launch.json'
            for _ in range(40):  # boot completes asynchronously from the CLI's view
                if probe.exists() and launch_file.exists(): break
                time.sleep(0.25)
            self.assertTrue(probe.exists(),f'probe missing; spawn said: {spawn.stdout} {spawn.stderr}')
            data=json.loads(probe.read_text())
            # Base environment is bound from THIS client, not the daemon environ:
            self.assertEqual(data['rc'],0)                     # custom-PATH interpreter ran
            self.assertIn('interp-ok',data['out'])
            self.assertTrue(data['path'].startswith(str(fakebin)))
            self.assertEqual(data['home_tag'],home_tag)
            # Return the live handle: the TemporaryDirectory object MUST stay
            # referenced by the caller or its finalizer deletes the state tree.
            return data,state,env,cli,tmp
        except Exception:
            if env is not None:
                stop_daemon(cli,env)
            tmp.cleanup()
            raise

    def test_master_off_keeps_base_env_and_never_reads_source(self):
        cfg='pi_command = '+fake_pi_command()+'\nstartup_timeout_seconds = 30\n\n[inheritance]\nenabled = false\nchild_env = ["PI_TEST_AUTH", "PI_TEST_PROBE_FILE", "PI_TEST_PROBE_CMD", "PI_TEST_HOME_TAG"]\n'
        data,state,env,cli,tmp_s=self._scenario(cfg,'fifo','A')
        try:
            self.assertTrue(data['has_auth'])          # authorized auth name still delivered
            self.assertFalse(data['has_daemon_only'])  # daemon-only canary did NOT reach the child
            # No inheritance import happened: the FIFO was never opened (no block,
            # no error) and launch argv carries no bridge/skill flags.
            launches=list((state/'agents').glob('*/launch.json'))
            self.assertTrue(launches)
            argv=json.loads(launches[0].read_text())['argv']
            self.assertNotIn(str(BRIDGE),argv)
            self.assertNotIn('--skill',argv)
            # The authorized secret value never reached any control-plane file.
            for p in state.rglob('*'):
                if p.is_file():
                    self.assertNotIn(b'real-secret-123',p.read_bytes(),p)
        finally:
            stop_daemon(cli,env)
            tmp_s.cleanup()

    def test_two_scopes_get_their_own_chain_env(self):
        cfg='pi_command = '+fake_pi_command()+'\nstartup_timeout_seconds = 30\n\n[inheritance]\nenabled = false\nchild_env = ["PI_TEST_AUTH", "PI_TEST_PROBE_FILE", "PI_TEST_PROBE_CMD", "PI_TEST_HOME_TAG"]\n'
        data_a,state_a,env_a,cli_a,tmp_a=self._scenario(cfg,None,'A')
        try:
            self.assertEqual(data_a['home_tag'],'A')
        finally:
            stop_daemon(cli_a,env_a)
            tmp_a.cleanup()
        data_b,state_b,env_b,cli_b,tmp_b=self._scenario(cfg,None,'B')
        try:
            self.assertEqual(data_b['home_tag'],'B')   # not scope A's value
        finally:
            stop_daemon(cli_b,env_b)
            tmp_b.cleanup()

    def test_reenabling_inheritance_restores_import(self):
        tmp=tempfile.TemporaryDirectory(prefix='env-chain-on-')
        try:
            root=Path(tmp.name); state=root/'state'; state.mkdir()
            ws=root/'ws'; ws.mkdir()
            fakebin=root/'bin'; fakebin.mkdir()
            interp=fakebin/'tag-interp'; interp.write_text('#!/bin/sh\necho ok\n'); interp.chmod(0o755)
            codex=make_codex_home(root/'src',config=STDIO_TOML)
            make_skill(codex/'skills','alpha')
            (state/'config.toml').write_text('pi_command = '+fake_pi_command()+'\nstartup_timeout_seconds = 30\n\n[inheritance]\nenabled = false\nchild_env = ["PI_TEST_AUTH", "PI_TEST_PROBE_FILE", "PI_TEST_PROBE_CMD", "PI_TEST_HOME_TAG"]\n')
            probe=root/'probe.json'
            env=self._client_env(state,fakebin,'A')
            env['PI_TEST_PROBE_FILE']=str(probe)
            env['CODEX_HOME']=str(codex)
            env['TOKEN_VAR']='tv'  # referenced by the fake codex config; proves env resolution after rebind
            cli=str(ROOT/'bin'/'subagent-pi')
            opened=self._cli(cli,env,'scope','open','--cwd',str(ws))
            scope_id=json.loads(opened.stdout)['scope']
            self._cli(cli,env,'spawn','--scope',scope_id,'--cwd',str(ws),'--task','simple','--access','read')
            launches=list((state/'agents').glob('*/launch.json'))
            argv=json.loads(launches[0].read_text())['argv']
            self.assertNotIn(str(BRIDGE),argv)  # master off: no import
            # Flip the master switch on and rebind: import comes back.
            (state/'config.toml').write_text('pi_command = '+fake_pi_command()+'\nstartup_timeout_seconds = 30\n\n[inheritance]\nenabled = true\nchild_env = ["PI_TEST_AUTH", "PI_TEST_PROBE_FILE", "PI_TEST_PROBE_CMD", "PI_TEST_HOME_TAG"]\n')
            stop_daemon(cli,env)  # fully exited before the next autostart races the same socket
            # The restart wiped the daemon's source memory: the owning client
            # must re-open the scope to rebind (no silent ~/.codex fallback).
            self._cli(cli,env,'scope','open','--cwd',str(ws),'--label','chain','--scope',scope_id)
            doc=self._cli(cli,env,'doctor','--inheritance')
            sc=json.loads(doc.stdout)['inheritance']['scopes'][0]
            self.assertEqual(sc['codex_home'],str(codex))  # rebind bound the client's source
            spawn=self._cli(cli,env,'spawn','--scope',scope_id,'--cwd',str(ws),'--task','simple','--access','read')
            agent_id=json.loads(spawn.stdout)['agent_id']
            argv2=json.loads((state/'agents'/agent_id/'launch.json').read_text())['argv']
            self.assertIn('--extension',argv2)    # inheritance restored end to end
            self.assertIn('--skill',argv2)
            self.assertIn('alpha',' '.join(argv2))  # the codex skill path is referenced in place
        finally:
            stop_daemon(cli,env)
            tmp.cleanup()

if __name__=='__main__':
    unittest.main()


class CodexConfigCompatTests(McpParsingCase):
    """P1-B: every current Codex RawMcpServerConfig field lands in exactly one
    compatibility class; unknown fields still fail closed."""
    def test_field_classification_matrix(self):
        cfg='''[mcp_servers.s]
command = "x"
startup_timeout_sec = 7
startup_timeout_ms = 2500
tool_timeout_sec = 33
supports_parallel_tool_calls = true
name = "legacy-label"
environment_id = "local"
[mcp_servers.s.tools.t]
approval_mode = "auto"
output_token_limit = 50
'''
        servers,diag=self.parse(cfg)
        self.assertEqual(servers[0]['disposition'],'ok')
        self.assertEqual(servers[0]['startup_timeout_sec'],7)  # sec wins over ms (Codex semantics)
        reasons=[d.reason for d in diag]
        self.assertTrue(any('startup_timeout_ms ignored' in r for r in reasons))
        self.assertTrue(any('supports_parallel_tool_calls' in r for r in reasons))
        self.assertTrue(any('legacy name label' in r for r in reasons))
        self.assertEqual(servers[0]['tool_output_limits'].get('t'),200)  # 50 tokens * 4 bytes, tighten-only
        self.assertEqual(servers[0]['protocol_mode'],'legacy_2025_06_18')  # stdio stays legacy

    def test_unsupported_fields_required_vs_optional(self):
        for field,value in [('oauth','true'),('scopes',"['a']"),('oauth_resource','"https://x"'),
                            ('omit_tools_from',"['model']"),('http_headers_helper','"cmd"'),
                            ('experimental_environment','"remote"')]:
            for required in ('true','false'):
                cfg=f'''[mcp_servers.s]
command = "x"
required = {required}
{field} = {value}
'''
                servers,diag=self.parse(cfg)
                self.assertEqual(servers[0]['disposition'],'failed',f'{field} required={required}')
                self.assertTrue(any(field in d.reason for d in diag),field)

    def test_environment_id_local_ok_remote_failed(self):
        ok,_=self.parse('[mcp_servers.s]\ncommand = "x"\nenvironment_id = "local"\n')
        self.assertEqual(ok[0]['disposition'],'ok')
        remote,diag=self.parse('[mcp_servers.s]\ncommand = "x"\nenvironment_id = "exec-7"\n')
        self.assertEqual(remote[0]['disposition'],'failed')
        self.assertTrue(any('environment_id' in d.reason for d in diag))

    def test_unknown_field_still_fails_closed(self):
        servers,diag=self.parse('[mcp_servers.s]\ncommand = "x"\nsome_new_future_field = "v"\n')
        self.assertEqual(servers[0]['disposition'],'failed')
        self.assertTrue(any('some_new_future_field' in d.reason for d in diag))

    def test_http_protocol_mode_passthrough_and_fallback_default(self):
        http='[mcp_servers.s]\nurl = "http://x/mcp"\n'
        servers,_=parse_mcp_servers(self.home,tomllib.loads(http),'modern_2026_07_28')
        self.assertEqual(servers[0]['protocol_mode'],'modern_2026_07_28')
        servers,_=parse_mcp_servers(self.home,tomllib.loads(http),'banana')
        self.assertEqual(servers[0]['protocol_mode'],'auto')
        servers,_=parse_mcp_servers(self.home,tomllib.loads(http))
        self.assertEqual(servers[0]['protocol_mode'],'auto')

    def test_compatibility_baseline_constant(self):
        self.assertIn('2026-07-28',CODEX_MCP_BASELINE)
        self.assertIn('RawMcpServerConfig',CODEX_MCP_BASELINE)
