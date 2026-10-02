"""Layer-4: the REAL TypeScript bridge, loaded by jiti exactly like Pi loads
extensions, driven against local fake stdio/HTTP MCP servers. No Pi process,
no model call, no disk cache. Skipped (with a documented reason) when the
installed Pi distribution or node is unavailable."""
from __future__ import annotations
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

def find_pi_dir() -> Path | None:
    exe = shutil.which('pi')
    if not exe:
        return None
    real = Path(exe).resolve()
    for parent in [real.parent, *real.parents]:
        if (parent / 'dist' / 'cli' / 'args.js').is_file():
            return parent
    return None

def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

from paths import ROOT, TEST_ROOT, REPO_ROOT

class HostHarness:
    """Spawns fake MCP servers, builds bootstrap payloads, drives the host.

    Every fake server exposes an EVENTS file so tests can prove WHICH stage was
    reached (request received, headers flushed, stdin closed) instead of
    inferring it from error strings.
    """
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.procs = []
    def start_stdio(self, mode='normal', hide='', paged=False, many=False, dynamic=False, mutate=False, close_after_call=False, extra=None):
        """Returns server config env vars; the bridge spawns the server itself
        with ONLY its declared env + base keys, so mode/call-log must travel in
        cfg.env — which also proves the per-server env delivery path."""
        n = len(self.procs)
        env = {'FAKE_MCP_MODE': mode, 'FAKE_MCP_HIDE': hide,
               'FAKE_MCP_PAGED': '1' if paged else '', 'FAKE_MCP_MANY': '1' if many else '',
               'FAKE_MCP_DYNAMIC': '1' if dynamic else '', 'FAKE_MCP_MUTATE': '1' if mutate else '',
               'FAKE_MCP_CLOSE_AFTER_CALL': '1' if close_after_call else '',
               'FAKE_MCP_CALL_LOG': str(self.tmp / f'stdio-calls-{n}.log'),
               'FAKE_MCP_EVENTS': str(self.tmp / f'stdio-events-{n}.log'),
               'FAKE_MCP_DYN_FILE': str(self.tmp / f'dyn-{n}.name')}
        for k, v in (extra or {}).items():
            env[k] = v
        self.procs.append(None)
        return {'log': Path(env['FAKE_MCP_CALL_LOG']), 'events': Path(env['FAKE_MCP_EVENTS']),
                'dyn_file': Path(env['FAKE_MCP_DYN_FILE']), 'env': env}
    def start_http(self, mode='normal', extra=None):
        port = free_port()
        n = len(self.procs)
        env = {k: v for k, v in os.environ.items()}
        env['FAKE_MCP_HTTP_MODE'] = mode
        env['FAKE_MCP_HTTP_CALL_LOG'] = str(self.tmp / f'http-calls-{n}.log')
        env['FAKE_MCP_HTTP_EVENTS'] = str(self.tmp / f'http-events-{n}.log')
        for k, v in (extra or {}).items():
            env[k] = v
        proc = subprocess.Popen([sys.executable, str(HERE / 'fake_mcp_http.py'), str(port)],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
        proc.stdout.readline()  # ready
        self.procs.append(proc)
        return {'proc': proc, 'log': Path(env['FAKE_MCP_HTTP_CALL_LOG']),
                'events': Path(env['FAKE_MCP_HTTP_EVENTS']), 'url': f'http://127.0.0.1:{port}/mcp'}
    def run_host(self, servers, actions, timeout=60, access='read', strict_rejections=True, agent_id='pi_hosttest'):
        payload = {'v': 1,
                   'agent': {'id': agent_id, 'access': access, 'generation': 3},
                   'source': {'codex_home': '/unused', 'mode': 'scope_env'},
                   'mcp': {'servers': servers}}
        payload_file = self.tmp / 'payload.json'; payload_file.write_text(json.dumps(payload))
        actions_file = self.tmp / 'actions.json'; actions_file.write_text(json.dumps(actions))
        result_file = self.tmp / 'result.json'
        env = {k: v for k, v in os.environ.items()}
        env['BRIDGE_TS'] = str(ROOT / 'extensions')
        cmd = ['node']
        if strict_rejections:
            cmd.append('--unhandled-rejections=strict')
        cmd += [str(HERE / 'bridge_host.mjs'), str(payload_file), str(actions_file), str(result_file)]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, cwd=str(REPO_ROOT))
        if out.returncode != 0:
            raise AssertionError(f'bridge host failed (rc={out.returncode}): {out.stderr[-2000:]}')
        return json.loads(result_file.read_text())
    def stop(self):
        for proc in self.procs:
            if proc is None: continue
            proc.terminate()
            try: proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait()
            proc.stdout.close()
    def events(self, path):
        if not Path(path).exists(): return []
        return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
    def kill_started(self, srv):
        for event in self.events(srv['events']):
            if event['event'] != 'server-start': continue
            try: os.kill(event['pid'], 9)
            except ProcessLookupError: pass
    def calls(self, log):
        return Path(log).read_text().splitlines() if Path(log).exists() else []

def stdio_cfg(name='local', server_env=None, **over):
    cfg = {'name': name, 'transport': 'stdio', 'command': sys.executable,
           'args': [str(HERE / 'fake_mcp_stdio.py')], 'cwd': None,
           'env': dict(server_env or {}),
           'startup_timeout_sec': 10, 'tool_timeout_sec': 5, 'required': False,
           'allowed_tools': None, 'disabled_tools': [], 'approval_default': 'prompt',
           'tool_approval': {}}
    cfg.update(over)
    return cfg


class BridgeHostCase(unittest.TestCase):
    """Shared fixture for tests that drive the real bridge against fake servers."""
    prefix = 'bridge-http-'
    def setUp(self):
        if find_pi_dir() is None: self.skipTest('installed pi distribution not found')
        if shutil.which('node') is None: self.skipTest('node not available')
        self.tmp = tempfile.TemporaryDirectory(prefix=self.prefix)
        self.h = HostHarness(Path(self.tmp.name))
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.h.stop)
    def http_cfg(self, srv, **over):
        cfg = {'name': 'web', 'transport': 'http', 'url': srv['url'], 'headers': {},
               'bearer_token': None, 'startup_timeout_sec': 10, 'tool_timeout_sec': 5,
               'required': False, 'allowed_tools': None, 'disabled_tools': [],
               'approval_default': 'auto', 'tool_approval': {}}
        cfg.update(over)
        return cfg



class BridgeHostTests(BridgeHostCase):
    prefix = 'bridge-host-'

    def test_equivalent_json_result_is_rendered_once(self):
        srv = self.h.start_stdio(mode='duplicate_result')
        out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
            {'action':'call','server':'local','tool':'echo','args':{'text':'unique-marker'},'confirm':True},
        ])['results'][0]
        self.assertEqual(out['kind'], 'result')
        self.assertEqual(out['text'].count('unique-marker'), 1)
        self.assertNotIn('structuredContent:', out['text'])

    def test_unicode_output_uses_one_safe_byte_budget(self):
        for budget, body, expected in [(4, '你好', '你'), (5, '🦊🦊', '🦊'), (4, '\ufeff你好', '\ufeff')]:
            with self.subTest(budget=budget, body=body):
                srv = self.h.start_stdio(mode='text_only_result')
                cfg = stdio_cfg(server_env=srv['env'], tool_output_limits={'echo':budget})
                row = self.h.run_host([cfg], [{'action':'call','server':'local','tool':'echo',
                    'args':{'text':body},'confirm':True}])['results'][0]
                self.assertEqual(row['kind'], 'result')
                self.assertEqual(row['text'].split('\n[output truncated', 1)[0], expected)
                self.assertNotIn('\ufffd', row['text'])
        srv = self.h.start_stdio(mode='text_only_result')
        row = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
            {'action':'call','server':'local','tool':'echo','args':{'text':'你'*100000},'confirm':True},
        ])['results'][0]
        body, notice = row['text'].split('\n[output truncated', 1)
        self.assertLessEqual(len(body.encode('utf-8')), 256*1024)
        self.assertTrue(notice)
        self.assertNotIn('\ufffd', body)

    # ---- happy paths ----
    def test_stdio_list_describe_call(self):
        srv = self.h.start_stdio()
        out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
            {'name': 'list', 'action': 'list'},
            {'name': 'describe', 'action': 'describe', 'server': 'local', 'tool': 'echo'},
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'abc', 'count': 2}, 'confirm': True},
        ])
        self.assertEqual(out['receipt']['state'], 'ready')  # optional servers stay lazy
        self.assertTrue(out['registered'] and out['registered']['name'] == 'codex_mcp')
        listing = json.loads(next(r for r in out['results'] if r['step'] == 'list')['text'])
        self.assertEqual(listing['servers'][0]['policy']['approval_default'], 'prompt')
        described = next(r for r in out['results'] if r['step'] == 'describe')
        schema = described['details']['inputSchema']
        self.assertEqual(schema['required'], ['text'])
        self.assertEqual(schema['properties']['count']['type'], 'integer')
        called = next(r for r in out['results'] if r['step'] == 'call')
        self.assertIn('abcabc', called['text'])
        self.assertIn('structuredContent', called['text'])
        self.assertIn('echo:{"count": 2, "text": "abc"}', self.h.calls(srv['log']))
    def test_http_json_and_sse(self):
        srv = self.h.start_http()
        cfg = self.http_cfg(srv, allowed_tools=['search'])
        out = self.h.run_host([cfg], [
            {'name': 'describe', 'action': 'describe', 'server': 'web', 'tool': 'search'},
            # P1-B: a read child confirms EVERY call, even parent-auto readOnly tools.
            {'name': 'call', 'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'x'}, 'confirm': True},
        ])
        self.assertEqual(out['receipt']['state'], 'ready')
        self.assertEqual(out['confirm_count'], 1)  # parent auto cannot waive the child confirmation
        called = next(r for r in out['results'] if r['step'] == 'call')
        self.assertEqual(called['kind'], 'result')
        self.assertIn('handled', called['text'])

    # ---- stdio failure modes (F03) ----
    def test_stdio_deadline_rejects_once(self):
        srv = self.h.start_stdio(mode='no_answer')
        out = self.h.run_host([stdio_cfg(server_env=srv['env'], tool_timeout_sec=2)], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': True},
        ])
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertIn('timed out', err['message'])
        # Exactly one request reached the server: no retry, no duplicate.
        self.assertEqual(len(self.h.calls(srv['log'])), 1)
    def test_stdio_rejects_matching_id_without_rpc_result(self):
        srv = self.h.start_stdio(mode='invalid_call_response')
        out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
            {'action':'call','server':'local','tool':'echo','args':{'text':'x'},'confirm':True},
        ])['results'][0]
        self.assertEqual(out['kind'],'error',out)
        self.assertIn('invalid JSON-RPC response',out['message'])
        self.assertEqual(len([e for e in self.h.events(srv['events']) if e['event']=='invalid-call-response-sent']),1)
    def test_stdio_stalled_reader_does_not_keep_timed_out_writes(self):
        srv = self.h.start_stdio(mode='stall_stdin_after_list')
        cfg = stdio_cfg(server_env=srv['env'], tool_timeout_sec=1)
        call = {'action':'call','server':'local','tool':'echo',
                'args':{'text':'x'*(1024*1024)},'confirm':True}
        try:
            out = self.h.run_host([cfg], [dict(call,name='first'),dict(call,name='second')], timeout=15)
            self.assertEqual([r['kind'] for r in out['results']],['error','error'])
            starts = [e['pid'] for e in self.h.events(srv['events']) if e['event']=='server-start']
            self.assertGreaterEqual(len(starts),2,'a blocked stdin must close and reconnect after timeout')
        finally:
            self.h.kill_started(srv)
    def test_stdio_outbound_buffer_has_a_hard_limit(self):
        srv = self.h.start_stdio(mode='stall_stdin_after_list')
        out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
            {'action':'call','server':'local','tool':'echo','confirm':True,
             'args':{'text':'x'*(8*1024*1024)}},
        ], timeout=15)
        self.assertEqual(out['results'][0]['kind'],'error')
        self.assertIn('outbound buffer limit',out['results'][0]['message'])
        self.assertEqual(self.h.calls(srv['log']),[])
    def test_stdio_close_kills_server_that_ignores_term(self):
        srv = self.h.start_stdio(mode='ignore_term_no_init')
        try:
            out = self.h.run_host([stdio_cfg(server_env=srv['env'], startup_timeout_sec=1)], [
                {'action':'describe','server':'local','tool':'echo','name':'catalog'}, {'waitMs':1800},
            ], timeout=10)
            self.assertEqual(out['results'][0]['kind'],'error')
            starts = [e['pid'] for e in self.h.events(srv['events']) if e['event']=='server-start']
            self.assertEqual(len(starts),1)
            with self.assertRaises(ProcessLookupError): os.kill(starts[0],0)
        finally:
            self.h.kill_started(srv)
    def test_stdio_close_reaps_wrapped_server_descendant(self):
        srv = self.h.start_stdio(mode='ignore_term_after_eof')
        cfg = stdio_cfg(server_env=srv['env'],args=[str(HERE/'fake_mcp_wrapper.py')])
        try:
            out = self.h.run_host([cfg], [
                {'action':'call','server':'local','tool':'echo','args':{'text':'x'},'confirm':True},
                {'shutdown':True},{'waitMs':1800},
            ],timeout=10)
            self.assertEqual(out['results'][0]['kind'],'result',out)
            pids = [e['pid'] for e in self.h.events(srv['events']) if e['event']=='server-start']
            self.assertEqual(len(pids),1)
            with self.assertRaises(ProcessLookupError): os.kill(pids[0],0)
        finally:
            self.h.kill_started(srv)
    def test_stdio_exit_mid_call(self):
        srv = self.h.start_stdio(mode='die_after_init')
        out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'x'}},
        ])
        self.assertEqual(out['results'][0]['kind'], 'error')
    def test_required_server_init_failure_fails_receipt(self):
        # F11: a required stdio server that cannot start must flip the receipt.
        cfg = stdio_cfg(name='core', required=True, command='/definitely/missing/binary')
        out = self.h.run_host([cfg], [{'name': 'call', 'action': 'call', 'server': 'core',
                                       'tool': 'anything', 'args': {}}])
        self.assertEqual(out['receipt']['state'], 'failed')
        entry = next(s for s in out['receipt']['servers'] if s['name'] == 'core')
        self.assertEqual(entry['status'], 'failed')
        self.assertTrue(entry['required'])
        # The broken server is not callable either.
        self.assertEqual(out['results'][0]['kind'], 'error')
    def test_http_hang_bounded(self):
        srv = self.h.start_http(mode='headers_then_hang')
        cfg = self.http_cfg(srv, startup_timeout_sec=3, tool_timeout_sec=2)
        started = time.monotonic()
        out = self.h.run_host([cfg], [{'name': 'call', 'action': 'call', 'server': 'web',
                                       'tool': 'publish', 'args': {'body': 'x'}}], timeout=30)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 20)  # deadline bounds the whole exchange
        self.assertEqual(out['results'][0]['kind'], 'error')

    # ---- policy (F06) ----
    def test_confirmation_flow_and_child_overrides(self):
        srv = self.h.start_stdio()
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt',
                        tool_approval={'status': 'auto'})
        out = self.h.run_host([cfg], [
            {'name': 'denied', 'action': 'call', 'server': 'local', 'tool': 'delete_file', 'args': {'path': 'x'}},
            {'name': 'auto_tool', 'action': 'call', 'server': 'local', 'tool': 'status', 'args': {}},
            {'name': 'confirm_rejected', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'no'}, 'confirm': False},
            {'name': 'confirm_accepted', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'yes'}, 'confirm': True},
        ])
        by = {r['step']: r for r in out['results']}
        self.assertEqual(by['denied']['kind'], 'error')  # no allowlist -> readOnly only
        self.assertEqual(by['auto_tool']['kind'], 'result')  # per-tool auto needs no confirm
        self.assertIn('denied', by['confirm_rejected']['text'])
        self.assertEqual(by['confirm_accepted']['kind'], 'result')
        # delete_file was never sent; echo went out exactly once.
        calls = self.h.calls(srv['log'])
        self.assertNotIn('delete_file', ' '.join(calls))
        self.assertEqual([c for c in calls if c.startswith('echo:')], ['echo:{"text": "yes"}'])
    def test_confirm_all_cannot_be_reaxed_by_parent_auto(self):
        srv = self.h.start_stdio()
        cfg = stdio_cfg(server_env=srv['env'], approval_default='auto', tool_approval={'echo': 'auto'})
        cfg['confirm_all'] = True
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': False},
        ])
        # confirm_all forces the confirmation; the host refuses -> nothing sent.
        self.assertIn('denied', out['results'][0]['text'])
        self.assertEqual(self.h.calls(srv['log']), [])
    def test_allowlist_and_deny_shape_describe(self):
        srv = self.h.start_stdio(hide='status')
        cfg = stdio_cfg(server_env=srv['env'], allowed_tools=['echo'], disabled_tools=[])
        out = self.h.run_host([cfg], [
            {'name': 'describe_hidden', 'action': 'describe', 'server': 'local', 'tool': 'status'},
            {'name': 'describe_denied', 'action': 'describe', 'server': 'local', 'tool': 'delete_file'},
            {'name': 'describe_ok', 'action': 'describe', 'server': 'local', 'tool': 'echo'},
        ])
        by = {r['step']: r for r in out['results']}
        self.assertEqual(by['describe_hidden']['kind'], 'error')
        self.assertEqual(by['describe_denied']['kind'], 'error')  # not in allowlist
        self.assertEqual(by['describe_ok']['kind'], 'result')
    def test_recursion_refused_by_bridge(self):
        # F12 belt-and-braces: the bridge itself refuses the management binary.
        cfg = stdio_cfg(command=str(ROOT / 'bin' / 'subagent-pi'), args=['mcp'])
        out = self.h.run_host([cfg], [{'name': 'call', 'action': 'call', 'server': 'local',
                                       'tool': 'anything', 'args': {}}])
        self.assertEqual(out['results'][0]['kind'], 'error')
        self.assertIn('refusing to start the subagent-pi management server', out['results'][0]['message'])

class ReadChildPolicyTests(BridgeHostCase):
    """P1-B: the parent's enabled_tools is NOT child authorization. A read
    child never gets a write tool through an allowlist, per-tool auto, or any
    other parent-side setting; readOnly tools still require confirmation.
    Assertions use real server call counts and confirm counts, not strings."""
    prefix = 'bridge-policy-'

    def run_case(self, cfg_overrides, steps, access='read'):
        srv = self.h.start_stdio()
        out = self.h.run_host([stdio_cfg(server_env=srv['env'], **cfg_overrides)], steps, access=access)
        return srv, out

    def test_read_child_with_allowlist_and_auto_cannot_call_write_tool(self):
        srv, out = self.run_case({'allowed_tools': ['delete_file'], 'approval_default': 'auto'}, [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'delete_file', 'args': {'path': 'x'}},
        ])
        self.assertEqual(out['results'][0]['kind'], 'error')  # not callable at all
        self.assertEqual(out['confirm_count'], 0)             # not even a confirmation offer
        self.assertEqual(self.h.calls(srv['log']), [])        # zero server executions

    def test_read_child_per_tool_auto_without_readonly_hint(self):
        srv, out = self.run_case({'allowed_tools': ['unannounced'], 'approval_default': 'prompt',
                                  'tool_approval': {'unannounced': 'auto'}}, [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'unannounced', 'args': {}},
        ])
        self.assertEqual(out['results'][0]['kind'], 'error')
        self.assertEqual(self.h.calls(srv['log']), [])

    def test_read_child_without_allowlist_readonly_still_confirms(self):
        srv, out = self.run_case({'approval_default': 'auto'}, [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'x'}, 'confirm': False},
        ])
        self.assertIn('denied', out['results'][0]['text'])
        self.assertEqual(self.h.calls(srv['log']), [])

    def test_read_child_readonly_tool_requires_confirmation(self):
        srv, out = self.run_case({'allowed_tools': ['status'], 'approval_default': 'auto'}, [
            {'name': 'rejected', 'action': 'call', 'server': 'local', 'tool': 'status', 'args': {}, 'confirm': False},
            {'name': 'accepted', 'action': 'call', 'server': 'local', 'tool': 'status', 'args': {}, 'confirm': True},
        ])
        by = {r['step']: r for r in out['results']}
        self.assertIn('denied', by['rejected']['text'])
        self.assertEqual(by['accepted']['kind'], 'result')
        self.assertEqual(out['confirm_count'], 2)             # parent auto offered no waiver
        calls = [c for c in self.h.calls(srv['log']) if c.startswith('status')]
        self.assertEqual(len(calls), 1)                       # exactly the accepted one

    def test_read_child_deny_and_empty_allowlist(self):
        for policy, expected_names in (
            ({'allowed_tools': ['echo', 'status'], 'disabled_tools': ['status']}, ['echo']),
            ({'allowed_tools': []}, []),
        ):
            with self.subTest(policy=policy):
                srv, out = self.run_case(dict(policy, approval_default='auto'), [
                    {'name': 'list', 'action': 'list', 'server': 'local'},
                    {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'status', 'args': {}, 'confirm': True},
                ])
                listing = json.loads(next(r for r in out['results'] if r['step'] == 'list')['text'])
                self.assertEqual([t['name'] for t in listing['tools']], expected_names)
                self.assertEqual(out['results'][1]['kind'], 'error')
                self.assertEqual(self.h.calls(srv['log']), [])

    def test_write_child_keeps_per_tool_confirmation(self):
        srv, out = self.run_case({'approval_default': 'auto', 'tool_approval': {'echo': 'confirm'}}, [
            {'name': 'rejected', 'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'x'}, 'confirm': False},
            {'name': 'accepted', 'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'y'}, 'confirm': True},
        ], access='write')
        by = {r['step']: r for r in out['results']}
        self.assertIn('denied', by['rejected']['text'])
        self.assertEqual(by['accepted']['kind'], 'result')
        self.assertEqual(out['confirm_count'], 2)
        self.assertEqual(len([c for c in self.h.calls(srv['log']) if c.startswith('echo:')]), 1)

class DiscoveryFlowTests(BridgeHostCase):
    """P1-D: the model must discover tools without knowing their names:
    list (servers) -> list(server) -> describe -> call. The tool name below is
    generated by the fake server at startup and is never a test constant."""
    prefix = 'bridge-discovery-'

    def test_level1_list_does_not_connect(self):
        srv = self.h.start_stdio(dynamic=True)
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [{'name': 'servers', 'action': 'list'}], access='write')
        servers = json.loads(next(r for r in out['results'])['text'])
        self.assertEqual(servers['servers'][0]['server'], 'local')
        # Level 1 did not connect the server: no stage events exist at all.
        self.assertEqual(self.h.events(srv['events']), [])
        self.assertFalse(Path(srv['dyn_file']).exists())

    def test_dynamic_discovery_end_to_end(self):
        srv = self.h.start_stdio(dynamic=True)
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'servers', 'action': 'list'},
            {'name': 'catalog', 'action': 'list', 'server': 'local'},
        ], access='write')
        # Level 2 connected exactly this server; the dynamic name comes from the
        # catalog itself, not from a test constant.
        events = self.h.events(srv['events'])
        self.assertTrue(any(e['event'] == 'initialize-received' for e in events))
        catalog = json.loads(next(r for r in out['results'] if r['step'] == 'catalog')['text'])
        names = [t['name'] for t in catalog['tools']]
        self.assertFalse(catalog['truncated'])
        dyn = [n for n in names if n.startswith('dyn-')]
        self.assertEqual(len(dyn), 1)
        # Discovered name -> describe -> schema-driven call.
        with open(srv['dyn_file']) as f:
            server_side_name = f.read().strip()
        self.assertEqual(dyn[0], server_side_name)
        out2 = self.h.run_host([cfg], [
            {'name': 'describe', 'action': 'describe', 'server': 'local', 'tool': dyn[0]},
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': dyn[0],
             'args': {'text': 'hello'}, 'confirm': True},
        ], access='write')
        described = next(r for r in out2['results'] if r['step'] == 'describe')
        schema = described['details']['inputSchema']
        self.assertEqual(schema['required'], ['text'])  # params built from the discovered schema
        called = next(r for r in out2['results'] if r['step'] == 'call')
        self.assertEqual(called['kind'], 'result')
        self.assertIn('hello', called['text'])
        calls = self.h.calls(srv['log'])
        self.assertTrue(any(c.startswith(dyn[0] + ':') and 'hello' in c for c in calls),
                        f'discovered tool was not called: {calls}')

    def test_catalog_pagination_and_size_bound(self):
        srv_paged = self.h.start_stdio(paged=True)
        paged_cfg = stdio_cfg(server_env=srv_paged['env'], approval_default='prompt')
        out = self.h.run_host([paged_cfg], [{'name': 'catalog', 'action': 'list', 'server': 'local'}], access='write')
        catalog = json.loads(next(r for r in out['results'])['text'])
        self.assertEqual([t['name'] for t in catalog['tools']],
                         ['echo', 'delete_file', 'status', 'unannounced'])
        self.assertFalse(catalog['truncated'])  # 3 pages fit the page budget: a complete catalog
        # A paged catalog still serves tools from the LAST page.
        last_page_tool = catalog['tools'][-1]['name']
        out2 = self.h.run_host([paged_cfg], [
            {'name': 'describe', 'action': 'describe', 'server': 'local', 'tool': last_page_tool}], access='write')
        self.assertEqual(out2['results'][0]['kind'], 'result')
        # Size bound: 600+ tools cannot fully fit MAX_TOOLS; the report must say so.
        srv_many = self.h.start_stdio(many=True)
        many_cfg = stdio_cfg(server_env=srv_many['env'], approval_default='prompt')
        out3 = self.h.run_host([many_cfg], [{'name': 'catalog', 'action': 'list', 'server': 'local'}], access='write')
        big = json.loads(next(r for r in out3['results'])['text'])
        self.assertTrue(big['truncated'])
        self.assertLessEqual(len(big['tools']), 512)

    def test_catalog_limit_reports_unseen_pages(self):
        for size, page_size, expected_pages, truncated in (
            (513, 512, 1, True),
            (513, 256, 2, True),
            (513, 600, 1, True),
            (512, 512, 1, False),
        ):
            with self.subTest(size=size, page_size=page_size):
                srv = self.h.start_stdio(paged=True, extra={
                    'FAKE_MCP_CATALOG_SIZE': str(size),
                    'FAKE_MCP_PAGE_SIZE': str(page_size),
                })
                cfg = stdio_cfg(server_env=srv['env'])
                out = self.h.run_host([cfg], [{'action': 'list', 'server': 'local'}], access='write')
                catalog = json.loads(out['results'][0]['text'])
                self.assertEqual([t['name'] for t in catalog['tools']],
                                 [f'bulk_{i}' for i in range(min(size, 512))])
                self.assertEqual(catalog['truncated'], truncated)
                pages = [e for e in self.h.events(srv['events']) if e['event'] == 'tools-list-received']
                self.assertEqual(len(pages), expected_pages)

    def test_catalog_filters_deny_and_reader_and_handles_empty(self):
        srv = self.h.start_stdio(hide='unannounced')
        cfg = stdio_cfg(server_env=srv['env'], disabled_tools=['echo'])
        out = self.h.run_host([cfg], [{'name': 'catalog', 'action': 'list', 'server': 'local'}], access='read')
        catalog = json.loads(next(r for r in out['results'])['text'])
        names = [t['name'] for t in catalog['tools']]
        self.assertNotIn('echo', names)      # denied
        self.assertNotIn('delete_file', names)  # read child: not readOnly
        self.assertIn('status', names)       # readOnly + allowed
        srv_empty = self.h.start_stdio(hide='echo,delete_file,status,unannounced')
        empty_cfg = stdio_cfg(server_env=srv_empty['env'])
        out2 = self.h.run_host([empty_cfg], [{'name': 'catalog', 'action': 'list', 'server': 'local'}], access='write')
        empty = json.loads(next(r for r in out2['results'])['text'])
        self.assertEqual(empty['tools'], [])
        self.assertFalse(empty['truncated'])

    def test_catalog_invalidates_after_list_changed(self):
        srv = self.h.start_stdio(mutate=True)
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'before', 'action': 'list', 'server': 'local'},
            # Let the event loop deliver the server's list_changed notification
            # before the next read; the wait is bounded and only for scheduling.
            {'name': 'settle', 'waitMs': 300},
            {'name': 'after', 'action': 'list', 'server': 'local'},
        ], access='write')
        before = json.loads(next(r for r in out['results'] if r['step'] == 'before')['text'])
        after = json.loads(next(r for r in out['results'] if r['step'] == 'after')['text'])
        before_names = {t['name'] for t in before['tools']}
        after_names = {t['name'] for t in after['tools']}
        self.assertIn('delete_file', before_names)
        self.assertNotIn('transferred', before_names)
        self.assertIn('transferred', after_names)   # fresh fetch after the notification
        self.assertNotIn('delete_file', after_names)

    def test_single_server_failure_is_deterministic_and_isolated(self):
        broken = self.h.start_stdio()
        good = self.h.start_stdio()
        broken_cfg = stdio_cfg(name='broken', server_env=broken['env'], command='/definitely/missing/binary')
        good_cfg = stdio_cfg(name='good', server_env=good['env'], approval_default='prompt')
        out = self.h.run_host([broken_cfg, good_cfg], [
            {'name': 'broken_list', 'action': 'list', 'server': 'broken'},
            {'name': 'good_list', 'action': 'list', 'server': 'good'},
        ], access='write')
        by = {r['step']: r for r in out['results']}
        self.assertEqual(by['broken_list']['kind'], 'error')
        self.assertIn('failed to initialize', by['broken_list']['message'])
        self.assertEqual(by['good_list']['kind'], 'result')

    def test_same_tool_name_in_different_servers_is_not_a_conflict(self):
        """Inherited MCP is addressed by (server, tool): two servers offering the
        same tool name stay distinct in the catalog and dispatch to their own
        server. (This is the Codex side of the name question; Pi itself exposes
        no MCP server registry to deduplicate against.)"""
        alpha = self.h.start_stdio()
        beta = self.h.start_stdio()
        cfgs = [stdio_cfg(name='alpha', server_env=alpha['env'], approval_default='prompt'),
                stdio_cfg(name='beta', server_env=beta['env'], approval_default='prompt')]
        out = self.h.run_host(cfgs, [
            {'name': 'alpha_list', 'action': 'list', 'server': 'alpha'},
            {'name': 'beta_list', 'action': 'list', 'server': 'beta'},
            {'name': 'alpha_echo', 'action': 'call', 'server': 'alpha', 'tool': 'echo',
             'args': {'text': 'A', 'count': 1}, 'confirm': True},
            {'name': 'beta_echo', 'action': 'call', 'server': 'beta', 'tool': 'echo',
             'args': {'text': 'B', 'count': 1}, 'confirm': True},
        ], access='write')
        by = {r['step']: r for r in out['results']}
        for step in ('alpha_list', 'beta_list'):
            names = [x['name'] for x in json.loads(by[step]['text'])['tools']]
            self.assertIn('echo', names)
        self.assertEqual(self.h.calls(alpha['log']), ['echo:{"count": 1, "text": "A"}'])
        self.assertEqual(self.h.calls(beta['log']), ['echo:{"count": 1, "text": "B"}'])

class HttpExchangeLifecycleTests(BridgeHostCase):
    """P1-A: after the response HEADERS arrive, a hung body must still be ended
    by the deadline, the caller's cancellation and connection close. Every test
    proves the tools/call reached the server and headers were flushed first."""


    def assert_reached_body_phase(self, srv):
        events = self.h.events(srv['events'])
        kinds = [e['event'] for e in events]
        self.assertIn('call-received', kinds)   # the request actually arrived
        self.assertIn('headers-sent', kinds)    # and headers were flushed
        return kinds

    def test_json_body_hang_hits_deadline(self):
        srv = self.h.start_http(mode='hang_body_json')
        cfg = self.http_cfg(srv, tool_timeout_sec=1)
        started = time.monotonic()
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'web', 'tool': 'publish',
             'args': {'body': 'x'}, 'confirm': True}], access='write', timeout=30)
        elapsed = time.monotonic() - started
        self.assert_reached_body_phase(srv)
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertIn('timed out', err['message'])
        self.assertIn('outcome is unknown', err['message'])  # the call WAS sent
        self.assertLess(elapsed, 6)                # deadline bound, not the test timeout
        self.assertGreaterEqual(elapsed, 0.9)      # it really waited for the exchange
        self.assertEqual(len(self.h.calls(srv['log'])), 1)  # sent once, never retried

    def test_sse_body_hang_hits_deadline(self):
        srv = self.h.start_http(mode='hang_body_sse')
        cfg = self.http_cfg(srv, tool_timeout_sec=1)
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'web', 'tool': 'search',
             'args': {'query': 'x'}, 'confirm': True}], access='write', timeout=30)
        self.assert_reached_body_phase(srv)
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertIn('timed out', err['message'])
        self.assertEqual(len(self.h.calls(srv['log'])), 1)

    def test_http_json_requires_matching_rpc_response(self):
        for mode in ('wrong_tool_response_id','empty_tool_response'):
            with self.subTest(mode=mode):
                srv = self.h.start_http(mode=mode)
                out = self.h.run_host([self.http_cfg(srv,protocol_mode='legacy_2025_06_18')], [
                    {'action':'call','server':'web','tool':'search','args':{'query':'x'},'confirm':True},
                ],access='write')['results'][0]
                self.assertEqual(out['kind'],'error',out)
                self.assertIn('invalid JSON-RPC response',out['message'])
                self.assertEqual(len(self.h.calls(srv['log'])),1)

    def test_http_multiline_sse_event_returns_one_result(self):
        srv = self.h.start_http(mode='multiline_sse')
        out = self.h.run_host([self.http_cfg(srv,protocol_mode='legacy_2025_06_18')], [
            {'action':'call','server':'web','tool':'search','args':{'query':'x'},'confirm':True},
        ],access='write')['results'][0]
        self.assertEqual(out['kind'],'result',out)
        self.assertIn('handled search x',out['text'])
        self.assertEqual(len(self.h.calls(srv['log'])),1)

    def test_user_cancellation_ends_body_wait(self):
        srv = self.h.start_http(mode='hang_body_json')
        cfg = self.http_cfg(srv, tool_timeout_sec=10)
        started = time.monotonic()
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'web', 'tool': 'publish',
             'args': {'body': 'x'}, 'confirm': True, 'launch': True, 'abortAfterMs': 700},
            {'name': 'await', 'awaitPending': True},
        ], access='write', timeout=30)
        elapsed = time.monotonic() - started
        self.assert_reached_body_phase(srv)
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertEqual(err['name'], 'CancelledError')
        self.assertIn('outcome is unknown', err['message'])
        self.assertLess(elapsed, 5)
        self.assertEqual(len(self.h.calls(srv['log'])), 1)  # cancel is not a retry

    def test_connection_close_ends_body_wait_and_rejects_until_reconnect(self):
        srv = self.h.start_http(mode='hang_body_json')
        cfg = self.http_cfg(srv, tool_timeout_sec=10)
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'web', 'tool': 'publish',
             'args': {'body': 'x'}, 'confirm': True, 'launch': True, 'closeAfterMs': 600},
            {'name': 'await', 'awaitPending': True},
        ], access='write', timeout=30)
        self.assert_reached_body_phase(srv)
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertIn('connection was closed', err['message'])
        # Explicit lifecycle: a fresh exchange after close creates a NEW connection.
        out2 = self.h.run_host([cfg], [
            {'name': 'fresh', 'action': 'list', 'server': 'web'}], access='write')
        self.assertEqual(out2['results'][0]['kind'], 'result')

    def test_close_ends_inflight_exchanges_on_the_connection(self):
        # Since the proxy serializes calls, one in-flight exchange covers the
        # lifecycle: close during the hanging body phase must terminate the wait.
        srv = self.h.start_http(mode='hang_body_json')
        cfg = self.http_cfg(srv, tool_timeout_sec=15)
        out = self.h.run_host([cfg], [
            {'name': 'a', 'action': 'call', 'server': 'web', 'tool': 'publish',
             'args': {'body': 'a'}, 'confirm': True, 'launch': True, 'closeAfterMs': 700},
            {'name': 'await', 'awaitPending': True},
        ], access='write', timeout=30)
        by = {r['step']: r for r in out['results']}
        self.assertEqual(by['a']['kind'], 'error')
        self.assertIn('connection was closed', by['a']['message'])
        self.assertEqual(len(self.h.calls(srv['log'])), 1)  # the call reached the server once, never replayed
        kinds = [e['event'] for e in self.h.events(srv['events'])]
        self.assertIn('call-received', kinds)
        self.assertIn('headers-sent', kinds)  # the body phase was already hanging when close fired

    def test_concurrent_cancel_does_not_hurt_the_other_request(self):
        hanging = self.h.start_http(mode='hang_body_json')
        good = self.h.start_http()
        cfgs = [self.http_cfg(hanging, name='hang', tool_timeout_sec=10),
                self.http_cfg(good, name='good', tool_timeout_sec=10)]
        out = self.h.run_host(cfgs, [
            {'name': 'hang', 'action': 'call', 'server': 'hang', 'tool': 'publish', 'args': {'body': 'x'}, 'confirm': True, 'launch': True, 'abortAfterMs': 700},
            {'name': 'good', 'action': 'call', 'server': 'good', 'tool': 'search', 'args': {'query': 'q'}, 'confirm': True, 'launch': True},
            {'name': 'await', 'awaitPending': True},
        ], access='write', timeout=30)
        by = {r['step']: r for r in out['results'] if r['step'] in ('hang', 'good')}
        self.assertEqual(by['hang']['kind'], 'error')
        self.assertEqual(by['good']['kind'], 'result')
        self.assertIn('handled', by['good']['text'])

class StdioTransportFailureTests(BridgeHostCase):
    """P1-C: asynchronous stdin failures (EPIPE after the server closed its read
    end) must be lifecycle events, not host crashes. The host runs with strict
    unhandled-rejection behavior and must exit 0 with clean stderr."""
    prefix = 'bridge-epipe-'

    def assert_clean_host(self, out_text):
        pass  # run_host raises on nonzero rc; strict mode turns stray rejections into failures

    def test_stdin_closed_after_init_is_a_lifecycle_error_not_a_crash(self):
        # The notification+tools-list writes hit the closed pipe: the server
        # closes its read end immediately after flushing the initialize reply.
        srv = self.h.start_stdio(mode='close_stdin_after_init')
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': True},
        ], access='write', timeout=60)
        events = [e['event'] for e in self.h.events(srv['events'])]
        self.assertIn('initialize-received', events)   # handshake got this far
        self.assertIn('closing-stdin', events)         # the server really closed its read end
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')         # deterministic transport error
        self.assertTrue('transport broken' in err['message'] or 'failed to send' in err['message']
                        or 'exited' in err['message'], err['message'])
        self.assertEqual(self.h.calls(srv['log']), [])  # the tool call never reached the server

    def test_stdin_closed_after_catalog_makes_next_call_fail_deterministically(self):
        srv = self.h.start_stdio(mode='close_stdin_after_list')
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': True},
        ], access='write', timeout=60)
        events = [e['event'] for e in self.h.events(srv['events'])]
        self.assertIn('closing-stdin', events)         # closed BEFORE the call write
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertTrue('transport broken' in err['message'] or 'failed to send' in err['message'],
                        err['message'])
        self.assertEqual(self.h.calls(srv['log']), [])  # the call never reached the server

    def test_cancel_notification_epipe_stays_a_cancellation(self):
        # The server holds the call, closes its read end, and the client's
        # cancellation notice then hits EPIPE: it must neither crash the host
        # nor turn the cancellation into a success.
        srv = self.h.start_stdio(mode='no_answer', close_after_call=True)
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': True, 'launch': True, 'abortAfterMs': 1500},
            {'name': 'await', 'awaitPending': True},
        ], access='write', timeout=60)
        events = [e['event'] for e in self.h.events(srv['events'])]
        self.assertIn('call-received', events)         # the call WAS delivered
        self.assertIn('closing-stdin', events)         # read end closed before the cancel write
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertEqual(err['name'], 'CancelledError')
        self.assertIn('outcome is unknown', err['message'])

    def test_cancel_notification_reaches_server_and_stays_a_cancellation(self):
        srv = self.h.start_stdio(mode='no_answer')
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': True, 'launch': True, 'abortAfterMs': 600},
            {'name': 'await', 'awaitPending': True},
        ], access='write', timeout=60)
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertEqual(err['name'], 'CancelledError')
        self.assertIn('outcome is unknown', err['message'])  # not reported as success
        events = [e['event'] for e in self.h.events(srv['events'])]
        self.assertIn('cancelled-notification-received', events)  # best-effort notice arrived

    def test_server_exit_during_pending_call(self):
        srv = self.h.start_stdio(mode='die_during_call')
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': True},
        ], access='write', timeout=60)
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertIn('exited', err['message'])
        self.assertEqual(self.h.calls(srv['log']), [])  # business counter untouched by the crash

    def test_close_during_pending_request_is_idempotent(self):
        srv = self.h.start_stdio(mode='no_answer')
        cfg = stdio_cfg(server_env=srv['env'], approval_default='prompt')
        out = self.h.run_host([cfg], [
            {'name': 'call', 'action': 'call', 'server': 'local', 'tool': 'echo',
             'args': {'text': 'x'}, 'confirm': True, 'launch': True, 'closeAfterMs': 500},
            {'name': 'await', 'awaitPending': True},
        ], access='write', timeout=60)
        err = out['results'][0]
        self.assertEqual(err['kind'], 'error')
        self.assertIn('closed', err['message'])

class LegacySessionTests(BridgeHostCase):
    """2025-06-18 legacy HTTP lifecycle: negotiation, protocol header, session
    expiry (404) recovery — and proof that an expired-session call is never replayed."""
    prefix = 'legacy-sess-'
    def test_negotiates_version_and_sends_headers(self):
        srv = self.h.start_http('normal')
        res = self.h.run_host([self.http_cfg(srv, protocol_mode='legacy_2025_06_18')],
                              [{'action': 'list'}, {'action': 'list', 'server': 'web'}], access='write')['results']
        self.assertEqual([r['kind'] for r in res], ['result', 'result'])
        ev = self.h.events(srv['events'])
        inits = [e for e in ev if e['event'] == 'initialize-received']
        self.assertEqual(len(inits), 1)
        lists = [e for e in ev if e.get('method') == 'tools/list']
        self.assertTrue(lists)
        for e in lists:  # negotiated version travels on every later request, with the session id
            self.assertEqual(e['protocol_header'], '2025-06-18')
            self.assertTrue((e['session'] or '').startswith('sess-'))

    def test_session_404_marks_stale_never_replays_and_recovers(self):
        srv = self.h.start_http('normal', extra={'FAKE_MCP_SESSION_EXPIRE_AFTER': '2'})
        res = self.h.run_host([self.http_cfg(srv, protocol_mode='legacy_2025_06_18')],
                              [{'name': 'l1', 'action': 'list', 'server': 'web'},
                               {'name': 'c1', 'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'x'}},
                               {'name': 'l2', 'action': 'list', 'server': 'web'},
                               {'name': 'c2', 'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'y'}}],
                              access='write')['results']
        by = {r['step']: r for r in res}
        # the call that hit the expired session reports an error with an unknown outcome...
        self.assertEqual(by['c1']['kind'], 'error')
        self.assertIn('session expired', by['c1']['message'])
        self.assertIn('outcome is unknown', by['c1']['message'])
        # ...the server never executed it (the 404 happened before dispatch)
        self.assertEqual(self.h.calls(srv['log']), ['search:{"query": "y"}'])
        # the next explicit list re-initialized and the follow-up call succeeded
        self.assertEqual(by['l2']['kind'], 'result')
        self.assertEqual(by['c2']['kind'], 'result')
        ev = self.h.events(srv['events'])
        self.assertEqual(len([e for e in ev if e['event'] == 'session-404']), 1)
        self.assertEqual(len([e for e in ev if e['event'] == 'initialize-received']), 2)


class ModernProtocolTests(BridgeHostCase):
    """2026-07-28 modern lifecycle against a strict fixture that rejects requests
    missing MCP-Protocol-Version / Mcp-Method / Mcp-Name / modern _meta."""
    prefix = 'modern-mcp-'
    def test_strict_server_accepts_bridge_requests(self):
        srv = self.h.start_http('modern')
        res = self.h.run_host([self.http_cfg(srv)],
                              [{'action': 'list'}, {'action': 'list', 'server': 'web'},
                               {'action': 'describe', 'server': 'web', 'tool': 'search'},
                               {'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'x'}}],
                              access='write')['results']
        self.assertTrue(all(r['kind'] == 'result' for r in res), res)
        ev = self.h.events(srv['events'])
        self.assertEqual([e for e in ev if e['event'] == 'strict-rejected'], [])
        reqs = [e for e in ev if e.get('event') == 'request']
        for e in reqs:
            self.assertEqual(e['protocol_header'], '2026-07-28')
            self.assertEqual(e['mcp_method_header'], e['method'])
            self.assertTrue(e['has_modern_meta'])
        calls = [e for e in reqs if e['method'] == 'tools/call']
        self.assertEqual(calls[0]['mcp_name_header'], 'search')
        # no initialize handshake and no session id in modern mode
        self.assertEqual([e for e in ev if e['event'] == 'initialize-received'], [])
        self.assertTrue(all(not e['session'] for e in reqs))

    def test_auto_falls_back_to_legacy_only_on_proof(self):
        srv = self.h.start_http('legacy_only')  # server/discover -> 404: proof of legacy-only
        res = self.h.run_host([self.http_cfg(srv)],  # default protocol_mode = auto
                              [{'action': 'list', 'server': 'web'}], access='write')['results']
        self.assertEqual(res[0]['kind'], 'result')
        ev = self.h.events(srv['events'])
        self.assertEqual(len([e for e in ev if e['event'] == 'discover-404-legacy-only']), 1)
        self.assertEqual(len([e for e in ev if e['event'] == 'initialize-received']), 1)
        lists = [e for e in ev if e.get('method') == 'tools/list']
        self.assertTrue(lists and all(e['protocol_header'] == '2025-06-18' for e in lists))

    def test_auto_picks_modern_without_handshake(self):
        srv = self.h.start_http('modern')
        res = self.h.run_host([self.http_cfg(srv)], [{'action': 'list', 'server': 'web'}], access='write')['results']
        self.assertEqual(res[0]['kind'], 'result')
        ev = self.h.events(srv['events'])
        self.assertEqual(len([e for e in ev if e['event'] == 'initialize-received']), 0)
        self.assertEqual(len([e for e in ev if e.get('method') == 'server/discover']), 1)

    def test_legacy_client_cannot_talk_to_modern_server(self):
        srv = self.h.start_http('modern')
        res = self.h.run_host([self.http_cfg(srv, protocol_mode='legacy_2025_06_18')],
                              [{'action': 'list', 'server': 'web'}], access='write')['results']
        self.assertEqual(res[0]['kind'], 'error')
        self.assertIn('failed to initialize', res[0]['message'])
        self.assertTrue(any(e['event'] == 'strict-rejected' for e in self.h.events(srv['events'])))

    def test_modern_body_hang_hits_deadline_without_retry(self):
        srv = self.h.start_http('modern_hang_json')
        res = self.h.run_host([self.http_cfg(srv, tool_timeout_sec=1)],
                              [{'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'x'}}],
                              access='write', timeout=90)['results']
        self.assertEqual(res[0]['kind'], 'error')
        self.assertIn('outcome is unknown', res[0]['message'])
        kinds = [e['event'] for e in self.h.events(srv['events'])]
        self.assertIn('call-received', kinds)   # the request actually arrived
        self.assertIn('headers-sent', kinds)    # and headers were flushed
        self.assertEqual(len(self.h.calls(srv['log'])), 1)  # exactly one server-side execution

    def test_bare_x_mcp_header_argument_is_an_ordinary_body_param(self):
        srv = self.h.start_http('modern')
        res = self.h.run_host([self.http_cfg(srv)],
                              [{'action': 'call', 'server': 'web', 'tool': 'search',
                                'args': {'query': 'x', 'x-mcp-header': {'X-Injected': 'value'}}}],
                              access='write')['results']
        # arguments never become headers by themselves: only SCHEMA annotations mirror
        self.assertEqual(res[0]['kind'], 'result', res[0].get('message'))
        calls = [e for e in self.h.events(srv['events']) if e['event'] == 'call-received']
        self.assertEqual(calls[0]['param_headers'], {})

class XMcHeaderTests(BridgeHostCase):
    """x-mcp-header (MCP 2026-07-28) is a SCHEMA annotation on plain-typed
    properties; the bridge mirrors declared arguments as Mcp-Param-* headers on
    modern HTTP calls, keeps the body unchanged, and excludes tools with
    invalid annotations instead of failing the server."""
    prefix = 'x-mcp-hdr-'

    def test_declared_headers_mirror_only_present_arguments_and_keep_the_body(self):
        cases = (
            ({'trace_id': 'tr-1', 'count': 7, 'flag': True},
             {'mcp-param-trace-id': 'tr-1', 'mcp-param-count': '7', 'mcp-param-x-flag': 'true'}),
            ({'trace_id': 'only-trace'}, {'mcp-param-trace-id': 'only-trace'}),
        )
        for args, expected_headers in cases:
            with self.subTest(args=args):
                srv = self.h.start_http('modern')
                result = self.h.run_host([self.http_cfg(srv)], [
                    {'action': 'call', 'server': 'web', 'tool': 'hdr', 'args': args}], access='write')['results'][0]
                self.assertEqual(result['kind'], 'result', result.get('message'))
                calls = [e for e in self.h.events(srv['events']) if e['event'] == 'call-received' and e['tool'] == 'hdr']
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0]['param_headers'], expected_headers)
                self.assertEqual(calls[0]['args'], args)

    def test_invalid_annotations_exclude_the_tool_not_the_server(self):
        srv = self.h.start_http('modern', extra={'FAKE_MCP_HEADER_TOOLS': '1'})
        res = self.h.run_host([self.http_cfg(srv)], [
            {'name': 'l', 'action': 'list', 'server': 'web'},
            {'name': 'd', 'action': 'describe', 'server': 'web', 'tool': 'badhdr_array'},
            {'name': 'c', 'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'ok'}}],
            access='write')['results']
        by = {r['step']: r for r in res}
        names = [t['name'] for t in json.loads(by['l']['text'])['tools']]
        for bad in ('badhdr_array', 'badhdr_dup', 'badhdr_ctrl', 'badhdr_empty', 'badhdr_ref', 'badhdr_oneof'):
            self.assertNotIn(bad, names)
        self.assertIn('hdr', names); self.assertIn('search', names)
        self.assertEqual(by['d']['kind'], 'error')
        self.assertIn('x-mcp-header', by['d']['message'])
        self.assertEqual(by['c']['kind'], 'result')  # the server itself stays usable
        self.assertEqual([e for e in self.h.events(srv['events']) if e['event'] == 'strict-rejected'], [])

    def test_unsafe_integer_is_refused_and_control_value_is_encoded(self):
        srv = self.h.start_http('modern')
        res = self.h.run_host([self.http_cfg(srv)], [
            {'name': 'n', 'action': 'call', 'server': 'web', 'tool': 'hdr',
             'args': {'trace_id': 'x', 'count': 2 ** 53}},
            {'name': 's', 'action': 'call', 'server': 'web', 'tool': 'hdr',
             'args': {'trace_id': 'a\nb'}}], access='write')['results']
        by = {r['step']: r for r in res}
        self.assertEqual(by['n']['kind'], 'error'); self.assertIn('safe integer', by['n']['message'])
        self.assertEqual(self.h.calls(srv['log']), ['hdr:{"trace_id": "a\\nb"}'])  # only the encoded call was sent
        check = next(e for e in self.h.events(srv['events']) if e['event'] == 'hdr-check')
        self.assertTrue(check['match'])  # the newline value arrived as a decoded sentinel, body unchanged

    def test_legacy_connection_ignores_the_plan(self):
        srv = self.h.start_http('legacy_only')  # auto falls back to the legacy handshake
        res = self.h.run_host([self.http_cfg(srv)], [
            {'name': 'call', 'action': 'call', 'server': 'web', 'tool': 'hdr',
             'args': {'trace_id': 't'}}], access='write')['results']
        self.assertEqual(res[0]['kind'], 'result', res[0].get('message'))
        calls = [e for e in self.h.events(srv['events']) if e['event'] == 'call-received' and e['tool'] == 'hdr']
        self.assertEqual(calls[0]['param_headers'], {})  # mirroring is modern-only


class SequentialExecutionTests(BridgeHostCase):
    """P1-B: the proxy tool is registered sequential and serializes in memory;
    two calls submitted CONCURRENTLY must not overlap server-side."""
    prefix = 'seq-exec-'

    def test_concurrent_calls_are_serial_and_cancellation_does_not_poison_the_queue(self):
        for abort_first in (False, True):
            with self.subTest(abort_first=abort_first):
                srv = self.h.start_stdio(extra={'FAKE_MCP_SLOW_MUTATION_MS': '400'})
                first = {'name': 'c1', 'action': 'call', 'server': 'local', 'tool': 'echo',
                         'args': {'text': 'first'}, 'launch': True}
                if abort_first: first['abortAfterMs'] = 150
                out = self.h.run_host([stdio_cfg(server_env=srv['env'], approval_default='auto')], [first,
                    {'name': 'c2', 'action': 'call', 'server': 'local', 'tool': 'echo',
                     'args': {'text': 'second'}, 'launch': True},
                    {'action': 'awaitPending'}], access='write', timeout=90)
                by = {r['step']: r for r in out['results']}
                self.assertEqual(out['registered']['executionMode'], 'sequential')
                self.assertEqual(by['c1']['kind'], 'error' if abort_first else 'result')
                self.assertEqual(by['c2']['kind'], 'result', by['c2'].get('message'))
                self.assertIn('second', by['c2']['text'])
                sequence = [e['event'] for e in self.h.events(srv['events'])
                            if e['event'] in ('call-start', 'call-end')]
                self.assertEqual(sequence, ['call-start', 'call-end'] * 2)
                if not abort_first: self.assertIn('first', by['c1']['text'])


class StdioGenerationTests(BridgeHostCase):
    """P1-C: a StdioConnection maps to exactly ONE handshake generation. A
    process that dies during a pending confirmation kills the connection; the
    failed call is never replayed, and the next explicit operation builds a NEW
    process whose first RPC is initialize."""
    prefix = 'stdio-gen-'

    def _assert_every_process_rehandshakes(self, srv):
        ev = self.h.events(srv['events'])
        starts = [i for i, e in enumerate(ev) if e['event'] == 'server-start']
        self.assertEqual(len(starts), 2)
        for idx in starts:  # the first RPC of every new process is initialize (env-marker is not an RPC)
            self.assertEqual(next(e['event'] for e in ev[idx + 1:] if e['event'] != 'env-marker'),
                             'initialize-received')
        return ev

    def test_pending_confirmation_failure_rehandshakes_without_replay(self):
        cases = (
            ({'FAKE_MCP_DIE_AFTER_LIST_MS': '300'}, 'exited'),
            ({'FAKE_MCP_CLOSE_STDIN_ONCE_FILE': str(Path(self.tmp.name) / 'close-once.marker')}, 'transport broken'),
        )
        for extra, error in cases:
            with self.subTest(error=error):
                srv = self.h.start_stdio(extra=extra)
                out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
                    {'name': 'l1', 'action': 'list', 'server': 'local'},
                    {'name': 'c1', 'action': 'call', 'server': 'local', 'tool': 'delete_file',
                     'args': {'path': 'x'}, 'confirm': True, 'confirmDelayMs': 700, 'launch': True},
                    {'action': 'awaitPending'},
                    {'name': 'c2', 'action': 'call', 'server': 'local', 'tool': 'delete_file',
                     'args': {'path': 'y'}, 'confirm': True}], access='write', timeout=90)
                by = {r['step']: r for r in out['results']}
                self.assertEqual(by['l1']['kind'], 'result')
                self.assertEqual(by['c1']['kind'], 'error')
                self.assertIn(error, by['c1']['message'])
                self.assertEqual(by['c2']['kind'], 'result', by['c2'].get('message'))
                self.assertEqual(len(self.h.calls(srv['log'])), 1)
                events = self._assert_every_process_rehandshakes(srv)
                self.assertEqual([e['tool'] for e in events if e['event'] == 'call-received'], ['delete_file'])


class StdioEraTests(BridgeHostCase):
    """P1-A: the CODEX_MCP_PROTOCOL_VERSION marker selects the stdio era and is
    consumed client-side; the server process never sees it."""
    prefix = 'stdio-era-'

    def test_modern_discovery_classifies_errors_before_any_tool_call(self):
        cases = (
            # fixture options, outcome, legacy handshakes, server calls, error text
            ({}, 'result', 0, ['echo:{"text": "hi"}'], None),
            ({'FAKE_MCP_DISCOVER_ERROR_CODE': '-32601'}, 'result', 1, ['echo:{"text": "hi"}'], None),
            ({'FAKE_MCP_DISCOVER_ERROR_CODE': '-32022', 'FAKE_MCP_DISCOVER_SUPPORTED': '1999-01-01'},
             'error', 0, [], 'no common modern version'),
            ({'FAKE_MCP_DISCOVER_ERROR_CODE': '-32020'}, 'result', 0, ['echo:{"text": "hi"}'], None),
            ({'FAKE_MCP_DISCOVER_MALFORMED': '1'}, 'error', 0, [], 'malformed DiscoverResult'),
        )
        for extra, kind, handshakes, calls, message in cases:
            with self.subTest(extra=extra):
                srv = self.h.start_stdio(extra={'FAKE_MCP_STRICT_FIRST_DISCOVER': '1', **extra})
                result = self.h.run_host([stdio_cfg(server_env=srv['env'], protocol_mode='modern_2026_07_28')], [
                    {'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'hi'}, 'confirm': True},
                ], access='write')['results'][0]
                self.assertEqual(result['kind'], kind, result.get('message'))
                if message: self.assertIn(message, result['message'])
                events = self.h.events(srv['events'])
                names = [event['event'] for event in events]
                self.assertEqual(next(e['method'] for e in events if e['event'] == 'first-method'), 'server/discover')
                self.assertEqual(next(e['modern_meta'] for e in events if e['event'] == 'discover-received'), '2026-07-28')
                self.assertEqual(names.count('initialize-received'), handshakes)
                self.assertEqual(self.h.calls(srv['log']), calls)
                if kind == 'result': self.assertIn('tools-list-received', names)
                if extra.get('FAKE_MCP_DISCOVER_ERROR_CODE') == '-32601':
                    self.assertEqual(names[names.index('discover-received') + 1:][:3],
                                     ['initialize-received', 'initialized-received', 'tools-list-received'])
                if not extra:
                    self.assertEqual(next(e['modern_meta'] for e in events if e['event'] == 'tools-list-received'), '2026-07-28')
                    self.assertEqual(next(e['present'] for e in events if e['event'] == 'env-marker'), 'False')

    def test_strict_fixture_rejects_a_legacy_first_rpc(self):
        srv = self.h.start_stdio(extra={'FAKE_MCP_STRICT_FIRST_DISCOVER': '1'})
        out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [  # legacy cfg: first RPC is initialize
            {'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'hi'}, 'confirm': True},
        ], access='write')['results']
        self.assertEqual(out[0]['kind'], 'error')  # the fixture bit: the process exited
        self.assertEqual(next(e for e in self.h.events(srv['events'])
                              if e['event'] == 'first-method')['method'], 'initialize')

    def test_legacy_stdio_first_rpc_is_initialize_and_env_is_clean(self):
        srv = self.h.start_stdio()
        out = self.h.run_host([stdio_cfg(server_env=srv['env'])], [
            {'action': 'call', 'server': 'local', 'tool': 'echo', 'args': {'text': 'hi'}, 'confirm': True},
        ], access='write')['results']
        self.assertEqual(out[0]['kind'], 'result', out[0].get('message'))
        evs = self.h.events(srv['events'])
        first_method = next(e['event'] for e in evs
                            if e['event'] in ('initialize-received', 'tools-list-received'))
        self.assertEqual(first_method, 'initialize-received')
        self.assertEqual(next(e for e in evs if e['event'] == 'env-marker')['present'], 'False')


class HttpEraTests(BridgeHostCase):
    """P1-B: HTTP era classification reads the bounded JSON-RPC error body."""
    prefix = 'http-era-'

    def test_discover_error_classification_never_replays_a_tool_call(self):
        # Each case drives the real HTTP bridge and checks both handshake era
        # and the independent server-side business-call log.
        cases = (
            # reject, server mode, result kind, initialize count, HTTP status, calls, error text
            ('legacy400', 'normal', 'result', 1, 400, ['search:{"query": "x"}'], None),
            ('modern400', 'modern', 'result', 0, 400, ['publish:{"body": "b"}'], None),
            ('mismatch400', 'modern', 'result', 0, None, ['publish:{"body": "b"}'], None),
            ('capability400', 'modern', 'result', 0, None, ['publish:{"body": "b"}'], None),
            ('inband32020', 'modern', 'result', 0, None, ['publish:{"body": "b"}'], None),
            ('inband32601', 'normal', 'result', 1, None, ['search:{"query": "x"}'], None),
            ('modern400_nocommon', 'modern', 'error', 0, None, [], 'no common modern version'),
            *((status, 'modern', 'error', 0, int(status), [], f'HTTP {status}')
              for status in ('401', '403', '429', '503')),
        )
        for reject, mode, kind, init_count, status, calls, message in cases:
            with self.subTest(reject=reject):
                srv = self.h.start_http(mode, extra={'FAKE_MCP_DISCOVER_REJECT': reject})
                tool, args = ('search', {'query': 'x'}) if mode == 'normal' else ('publish', {'body': 'b'})
                action = {'action': 'call', 'server': 'web', 'tool': tool, 'args': args}
                if tool == 'publish': action['confirm'] = True
                result = self.h.run_host([self.http_cfg(srv)], [action], access='write')['results'][0]
                self.assertEqual(result['kind'], kind, result.get('message'))
                if message: self.assertIn(message, result['message'])
                events = self.h.events(srv['events'])
                self.assertEqual(sum(e['event'] == 'initialize-received' for e in events), init_count)
                if status is not None:
                    self.assertEqual([e['status'] for e in events if e['event'] == 'discover-rejected'], [status])
                self.assertEqual(self.h.calls(srv['log']), calls)

    def test_malformed_discover_result_is_a_protocol_error_not_a_fallback(self):
        srv = self.h.start_http('modern', extra={'FAKE_MCP_DISCOVER_MALFORMED': '1'})
        result = self.h.run_host([self.http_cfg(srv)], [
            {'action': 'call', 'server': 'web', 'tool': 'publish', 'args': {'body': 'b'}, 'confirm': True}],
            access='write')['results'][0]
        self.assertEqual(result['kind'], 'error')
        self.assertIn('malformed DiscoverResult', result['message'])
        self.assertNotIn('initialize-received', [e['event'] for e in self.h.events(srv['events'])])
        self.assertEqual(self.h.calls(srv['log']), [])


class HeaderE2eTests(BridgeHostCase):
    """P1-C: nested x-mcp-header paths, 2026-07-28 value encoding, Mcp-Name."""
    prefix = 'hdr-e2e-'

    def test_nested_header_path_reaches_the_server_and_body_is_unchanged(self):
        srv = self.h.start_http('modern')
        args = {'context': {'region': 'us-west1'}, 'extra': 'keep'}
        out = self.h.run_host([self.http_cfg(srv)], [
            {'action': 'call', 'server': 'web', 'tool': 'hdr_nested', 'args': args}], access='write')['results']
        self.assertEqual(out[0]['kind'], 'result', out[0].get('message'))
        evs = self.h.events(srv['events'])
        check = next(e for e in evs if e['event'] == 'hdr-check')
        self.assertEqual(check['header'], 'mcp-param-region')
        self.assertEqual(check['decoded'], 'us-west1')  # plain ASCII travels raw
        self.assertTrue(check['match'])
        call = next(e for e in evs if e['event'] == 'call-received')
        self.assertEqual(call['args'], args)  # the body keeps every argument unchanged

    def test_header_values_are_encoded_per_the_2026_spec(self):
        srv = self.h.start_http('modern')
        cases = [('trace_id', 'Hello, 世界'), ('trace_id', ' padded '), ('trace_id', 'line1\nline2'),
                 ('trace_id', '=?base64?literal?='), ('flag', True), ('count', -5)]
        steps = [{'name': f's{i}', 'action': 'call', 'server': 'web', 'tool': 'hdr',
                  'args': {k: v}} for i, (k, v) in enumerate(cases)]
        out = self.h.run_host([self.http_cfg(srv)], steps, access='write')['results']
        for i, r in enumerate(out):
            self.assertEqual(r['kind'], 'result', f'case {i}: {r.get("message")}')
        checks = [e for e in self.h.events(srv['events']) if e['event'] == 'hdr-check']
        self.assertEqual(len(checks), len(cases))
        for c in checks:
            self.assertTrue(c['match'], c)  # strict server decoded the sentinel and matched the body value
        non_plain = {c['decoded'] for c in checks} >= {'Hello, 世界', ' padded ', 'line1\nline2', '=?base64?literal?='}
        self.assertTrue(non_plain)

    def test_mcp_name_is_encoded_for_non_ascii_tool_names(self):
        srv = self.h.start_http('modern')
        out = self.h.run_host([self.http_cfg(srv)], [
            {'action': 'call', 'server': 'web', 'tool': '搜索', 'args': {}}], access='write')['results']
        self.assertEqual(out[0]['kind'], 'result', out[0].get('message'))
        req = next(e for e in self.h.events(srv['events'])
                   if e['event'] == 'request' and e['method'] == 'tools/call')
        self.assertEqual(req['mcp_name_header'],
                         '=?base64?' + base64.b64encode('搜索'.encode()).decode() + '?=')  # header is the sentinel
        call = next(e for e in self.h.events(srv['events']) if e['event'] == 'call-received')
        self.assertEqual(call['tool'], '搜索')  # the body keeps the raw name
        self.assertNotIn('strict-rejected', [e['event'] for e in self.h.events(srv['events'])])

    def test_runtime_type_mismatch_is_refused_before_sending(self):
        srv = self.h.start_http('modern')
        out = self.h.run_host([self.http_cfg(srv)], [
            {'name': 's', 'action': 'call', 'server': 'web', 'tool': 'hdr', 'args': {'trace_id': 123}},
            {'name': 'b', 'action': 'call', 'server': 'web', 'tool': 'hdr', 'args': {'trace_id': 'x', 'flag': 'yes'}}],
            access='write')['results']
        by = {r['step']: r for r in out}
        self.assertEqual(by['s']['kind'], 'error'); self.assertIn('is not a string', by['s']['message'])
        self.assertEqual(by['b']['kind'], 'error'); self.assertIn('is not a boolean', by['b']['message'])
        self.assertEqual(self.h.calls(srv['log']), [])  # neither mismatched call reached the server

    def test_annotation_under_items_excludes_only_that_tool(self):
        srv = self.h.start_http('modern', extra={'FAKE_MCP_HEADER_TOOLS': '1'})
        out = self.h.run_host([self.http_cfg(srv)], [
            {'name': 'l', 'action': 'list', 'server': 'web'},
            {'name': 'd', 'action': 'describe', 'server': 'web', 'tool': 'badhdr_items_nested'},
            {'name': 'c', 'action': 'call', 'server': 'web', 'tool': 'badhdr_items_nested', 'args': {}},
            {'name': 'ok', 'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'x'}}],
            access='write')['results']
        by = {r['step']: r for r in out}
        names = [t['name'] for t in json.loads(by['l']['text'])['tools']]
        self.assertNotIn('badhdr_items_nested', names)  # excluded from the catalog
        for step in ('d', 'c'):
            self.assertEqual(by[step]['kind'], 'error', step)
            self.assertIn('invalid x-mcp-header', by[step]['message'], step)
        self.assertEqual(by['ok']['kind'], 'result')  # the server and its other tools stay usable


class RedirectTests(BridgeHostCase):
    """P1-B: redirects are followed manually, same-origin only; no header or
    body is ever transmitted before the target origin is verified."""
    prefix = 'redirect-'

    def test_cross_origin_307_never_sends_secret_headers_or_tool_body(self):
        b = self.h.start_http('modern')
        a = self.h.start_http('modern', extra={'FAKE_MCP_REDIRECT_PLAN': f"307:{b['url']}"})
        out = self.h.run_host([
            self.http_cfg(a, headers={'X-API-Key': 'canary-secret'}),
        ], [{'action': 'call', 'server': 'web', 'tool': 'publish', 'args': {'body': 'canary-body'},
             'confirm': True}], access='write')['results']
        self.assertEqual(out[0]['kind'], 'error')
        self.assertIn('cross-origin redirect', out[0]['message'])
        self.assertIn('no headers or body were sent', out[0]['message'])
        self.assertEqual(self.h.events(b['events']), [])  # B received ZERO requests
        self.assertEqual(self.h.calls(b['log']), [])  # tool body canary never reached B
        self.assertEqual(self.h.calls(a['log']), [])  # A redirected before executing anything
        self.assertEqual([e for e in self.h.events(a['events']) if e['event'] == 'redirect-sent'][0]['status'], 307)

    def test_second_hop_cross_origin_is_rejected(self):
        b = self.h.start_http('modern')
        a = self.h.start_http('modern', extra={'FAKE_MCP_REDIRECT_PLAN': f"307:/mcp2|307:{b['url']}"})
        out = self.h.run_host([self.http_cfg(a)], [
            {'action': 'call', 'server': 'web', 'tool': 'publish', 'args': {'body': 'b'}, 'confirm': True}],
            access='write')['results']
        self.assertEqual(out[0]['kind'], 'error')
        self.assertIn('cross-origin redirect', out[0]['message'])
        self.assertEqual(self.h.events(b['events']), [])  # the second hop never happened
        self.assertEqual(self.h.calls(a['log']), [])

    def test_redirect_loop_is_detected(self):
        a = self.h.start_http('modern', extra={'FAKE_MCP_REDIRECT_PLAN': '307:/loop1|307:/loop2|307:/loop3|307:/loop4'})
        out = self.h.run_host([self.http_cfg(a)], [
            {'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'x'}}], access='write')['results']
        self.assertEqual(out[0]['kind'], 'error')
        self.assertIn('too many redirects', out[0]['message'])
        self.assertEqual(self.h.calls(a['log']), [])

    def test_303_becomes_a_bodyless_get(self):
        a = self.h.start_http('modern', extra={'FAKE_MCP_REDIRECT_PLAN': '303:/mcp2'})
        out = self.h.run_host([self.http_cfg(a)], [
            {'action': 'call', 'server': 'web', 'tool': 'publish', 'args': {'body': 'b'}, 'confirm': True}],
            access='write')['results']
        self.assertEqual(out[0]['kind'], 'error')  # the fixture answers the GET with an error
        evs = [e['event'] for e in self.h.events(a['events'])]
        self.assertIn('redirect-sent', evs)
        self.assertIn('get-received', evs)  # 303 was followed as GET
        self.assertEqual(self.h.calls(a['log']), [])  # the tool body was dropped, never executed

    def test_same_origin_307_redirect_completes_and_executes_once(self):
        a = self.h.start_http('modern', extra={'FAKE_MCP_REDIRECT_PLAN': '307:/mcp2'})
        out = self.h.run_host([self.http_cfg(a)], [
            {'action': 'call', 'server': 'web', 'tool': 'search', 'args': {'query': 'x'}}], access='write')['results']
        self.assertEqual(out[0]['kind'], 'result', out[0].get('message'))
        self.assertEqual(self.h.calls(a['log']), ['search:{"query": "x"}'])  # executed exactly once, not replayed
        self.assertEqual(len([e for e in self.h.events(a['events']) if e['event'] == 'redirect-sent']), 1)

    def test_redirect_with_unfinished_body_releases_each_socket(self):
        a = self.h.start_http('redirect_hanging_body')
        actions = [{'action':'call','server':'web','tool':'search','args':{'query':str(i)},
                    'name':f'call-{i}'} for i in range(4)]
        actions += [{'waitMs':200},{'socketCount':True,'name':'open-sockets'}]
        out = self.h.run_host([self.http_cfg(a,protocol_mode='legacy_2025_06_18')],actions,access='write')['results']
        self.assertEqual([r['kind'] for r in out[:4]],['result']*4)
        self.assertEqual(len(self.h.calls(a['log'])),4)
        self.assertLess(out[-1]['sockets'],3,'discarded redirect bodies retained live sockets')

    def test_deadline_covers_all_redirect_hops(self):
        # same-origin hop 1 (/mcp2), then hop 2 hangs: the exchange deadline must
        # span BOTH hops (one AbortController, never reset per hop)
        a = self.h.start_http('headers_then_hang', extra={'FAKE_MCP_REDIRECT_PLAN': '307:/mcp2'})
        out = self.h.run_host([self.http_cfg(a, protocol_mode='modern_2026_07_28', tool_timeout_sec=2)], [
            {'action': 'call', 'server': 'web', 'tool': 'publish', 'args': {'body': 'b'}, 'confirm': True}],
            access='write')['results']
        self.assertEqual(out[0]['kind'], 'error')
        self.assertIn('timed out', out[0]['message'])  # the shared deadline expired across the hop
        self.assertEqual(self.h.calls(a['log']), ['publish:{"body": "b"}'])  # executed once, never replayed
