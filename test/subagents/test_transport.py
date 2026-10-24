from __future__ import annotations
import asyncio
import contextlib
import array
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from paths import ROOT, TEST_ROOT, REPO_ROOT, WORKER_ROOT
from metis_subagent import ipc
from metis_subagent.client import request as ipc_request
from metis_subagent import PROTOCOL_VERSION, RUNTIME_REVISION
from metis_subagent.common import (AgentError, BASE_ENV_KEYS, TERMINAL, dumps, group_members,
    python_executable, read_frame)

# The non-secret Windows OS locations Python/Node need to start at all.
WINDOWS_BASE_ENV = tuple(k for k in BASE_ENV_KEYS if k.upper() in {
    'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH',
    'APPDATA','LOCALAPPDATA','TEMP','TMP'})
from metis_subagent.config import launch_spec as native_launch_spec
from metis_subagent import locks

WINDOWS = sys.platform == 'win32'
# A POSIX-only probe owns these; skipping keeps its Linux protection intact.
posix_only = unittest.skipIf(WINDOWS, 'POSIX process-group/signal semantics')
if not WINDOWS:
    import fcntl
    import signal
    import termios


def force_kill(pid):
    """Terminate one process we spawned: SIGKILL on POSIX, TerminateProcess here."""
    if WINDOWS:
        subprocess.run(['taskkill', '/F', '/PID', str(pid)], capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        os.kill(pid, signal.SIGKILL)


def fixture_launch(command):
    """Patch only this fixture interpreter, after constructing the native launch."""
    def launch(*args, **kwargs):
        spec = native_launch_spec(*args, **kwargs)
        spec['argv'] = [*command, *spec['argv'][2:]]
        spec.pop('sdk_path', None)
        spec['host'] = 'fixture'
        return spec
    return mock.patch('metis_subagent.runtime.launch_spec', side_effect=launch)


async def fixture_daemon(home, command):
    from metis_subagent.daemon import serve
    with fixture_launch(command):
        await serve(home)


class IpcHarness:
    """Fresh native state + real IPC/autostart/locking, fake child only in fixture.

    `request` leaves attention unconsumed. `call` models a successful native
    frontend delivery and explicitly commits its Pi receipt after reading it.
    """
    use_fake = True

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='metis-subagent-ipc-')
        self.root = Path(self.tmp.name)
        self.home = self.root/'state'; self.home.mkdir()
        self.workspace = self.root/'workspace'; self.workspace.mkdir()
        self.config_path = self.root/'metis-pi.toml'
        self.config_path.write_text('[subagents]\nrpcTimeoutSeconds=8\nstartupTimeoutSeconds=10\n')
        self.enterContext(mock.patch.dict(os.environ, {'METIS_PI_CONFIG':str(self.config_path)}))
        self.command = [python_executable(), str(TEST_ROOT/'fake_pi.py')]
        self.source = {'env':{'PATH':os.environ['PATH'], 'HOME':str(self.root)}, 'parent':{
            'kind':'pi', 'session_id':'fixture', 'agent_dir':str(self.root), 'session_file':'',
            'sdk_path':str(self.root/'dist/index.js'), 'node_path':sys.executable,
            'lease':'fixture_parent', 'model':{'provider':'offline','id':'fixture'}}}
        self.scope = None
        self.reqid = 0
        self.daemons = []
        popen = subprocess.Popen
        expected = [python_executable(), str(ROOT/'main.py'), '--home', str(self.home), 'daemon']
        def owned_daemon(command, *args, **kwargs):
            if command == expected:
                if self.use_fake:
                    command = [python_executable(), str(TEST_ROOT/'test_transport.py'), '--fixture-daemon',
                               str(self.home), json.dumps(self.command)]
                proc = popen(command, *args, **kwargs)
                self.daemons.append(proc)
                return proc
            return popen(command, *args, **kwargs)
        self.enterContext(mock.patch('metis_subagent.client.subprocess.Popen', side_effect=owned_daemon))

    async def asyncTearDown(self):
        with contextlib.suppress(AgentError):
            await self.request('shutdown', {'force':True}, timeout=5, autostart=False)
        # Shutdown acknowledges the request before workers are reaped; wait for
        # the daemon to finish cleanup before falling back to a forced kill.
        for proc in self.daemons:
            try:
                await asyncio.to_thread(proc.wait, 45)
            except subprocess.TimeoutExpired:
                proc.kill()
                await asyncio.to_thread(proc.wait)
                self.tmp._finalizer.detach()
                self.fail(f'Owned daemon {proc.pid} did not shut down; state retained at {self.home}')
        # A killed daemon may still be closing its SQLite/lease handles; Windows
        # cannot remove files that are open, so retry the tree briefly.
        for attempt in range(40):
            try:
                self.tmp.cleanup()
                break
            except PermissionError:
                if attempt == 39:
                    self.tmp._finalizer.detach()
                    self.fail(f'State remained locked at {self.home}')
                await asyncio.sleep(0.05)

    async def request(self, op, params, **kwargs):
        kwargs.setdefault('source', self.source)
        return await ipc_request(self.home, op, params, **kwargs)

    async def call(self, op, params, *, consume=True):
        params = dict(params)
        if op == 'scope_open':
            params.setdefault('cwd', str(self.workspace))
            result = await self.request(op, params)
            self.scope = result['scope']
            return result
        params.setdefault('scope', self.scope)
        async def delivered(_value):
            pass
        value = await self.request(op, params, on_result=delivered if consume else None)
        ticket = value.pop('_pi_delivery', None)
        if ticket:
            for receipt in ticket['receipts']:
                await self.request('pi_observe', {'scope':params['scope'], 'receipt':receipt})
        return value

    async def initialize(self):
        return await self.call('scope_open', {})

    async def open_scope(self):
        return (await self.request('scope_open', {'cwd':str(self.workspace)}))['scope']

    async def spawn(self, sid, task='delay=0.2|transport'):
        self.reqid += 1
        return await self.request('spawn', {'scope':sid, 'request_id':f'spawn-{self.reqid}',
            'cwd':str(self.workspace), 'task':task, 'access':'read'})

    async def finished_runs(self, run_ids, scope=None, timeout_seconds=8):
        remaining = list(run_ids)
        finished = {}
        async with asyncio.timeout(timeout_seconds + 1):
            while remaining:
                args = {'run_ids':remaining, 'timeout_seconds':timeout_seconds}
                if scope:
                    args['scope'] = scope
                page = await self.call('wait', args)
                self.assertFalse(page['timed_out'], page)
                self.assertFalse(page['questions'], page)
                ready = [row for row in page['runs'] if row['state'] in TERMINAL]
                self.assertTrue(ready, page)
                finished.update((row['id'], row) for row in ready)
                remaining = [rid for rid in remaining if rid not in finished]
        return {**page, 'runs':[finished[rid] for rid in run_ids]}


class NativeHostOutputTests(unittest.IsolatedAsyncioTestCase):
    """The original stdio framing controls, with native host and controlled IPC.

    A large backend result fills the actual host stdout pipe. This substitute
    never launches a daemon/SDK; shared Stdio still owns output/cancellation.
    """
    READ_TIMEOUT = 8

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='metis-native-output-')
        self.home = Path(self.tmp.name)
        self.peers = set()
        async def handle(reader, writer):
            self.peers.add(writer)
            try:
                frame = await read_frame(reader)
                op = frame['op']
                if op == 'ping':
                    value = {'pi_host':1, 'runtime_revision':RUNTIME_REVISION}
                elif op == 'scope_open':
                    value = {'scope':'scope_output', 'cwd':str(self.home)}
                elif op == 'list':
                    value = {'blob':'x'*30000}
                else:
                    value = {}
                writer.write((dumps({'ok':True, 'result':value})+'\n').encode())
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                self.peers.discard(writer)
        self.server = await ipc.serve(handle, self.home)
        env = {**os.environ, 'METIS_PI_CONFIG':str(self.home/'metis-pi.toml')}
        self.host = await asyncio.create_subprocess_exec(python_executable(), str(ROOT/'main.py'),
            '--home', str(self.home), 'pi-host', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
            limit=8*1024*1024)
        self.stderr = asyncio.create_task(self.host.stderr.read())
        self.reqid = 0
        source = {'env':{}, 'parent':{'kind':'pi','session_id':'output',
            'agent_dir':str(self.home),'session_file':'','sdk_path':str(self.home/'index.js'),
            'node_path':sys.executable,'lease':'output_parent','model':{'provider':'offline','id':'mock'}}}
        await self.send('initialize', {'cwd':str(self.home)}, source=source)
        self.assertTrue((await self.receive())['ok'])

    async def asyncTearDown(self):
        if self.host.returncode is None:
            self.host.stdin.close()
            try:
                await asyncio.wait_for(self.host.wait(), 3)
            except asyncio.TimeoutError:
                self.host.kill(); await self.host.wait()
        await self.stderr
        self.server.close(); await self.server.wait_closed()
        for writer in list(self.peers):
            writer.transport.abort()
        self.tmp.cleanup()

    async def send(self, operation, params=None, rid=None, **extra):
        self.reqid += 1
        rid = rid or str(self.reqid)
        self.host.stdin.write((dumps({'id':rid, 'operation':operation, 'params':params or {}, **extra})+'\n').encode())
        await self.host.stdin.drain()
        return rid

    async def receive(self):
        return json.loads(await asyncio.wait_for(self.host.stdout.readline(), self.READ_TIMEOUT))

    async def rpc(self, operation, params=None):
        rid = await self.send(operation, params)
        response = await self.receive()
        self.assertEqual(response['id'], rid)
        return response

    async def test_stdout_backpressure_does_not_block_stdin_eof(self):
        output=self.host.stdout._transport
        output.pause_reading()
        try:
            for _ in range(40): await self.send('subagents_list_agents')
            # A separate file marker is unnecessary: the parent keeps the output
            # paused through EOF. The child must exit even when no bytes drain.
            self.host.stdin.close()
            end=asyncio.get_running_loop().time()+3
            while self.host.returncode is None and asyncio.get_running_loop().time()<end:
                await asyncio.sleep(.02)
            self.assertEqual(self.host.returncode,0,'native host blocked writing stdout after stdin EOF')
        finally:
            output.resume_reading()
            await self.host.stdout.read()


    @unittest.skipIf(WINDOWS, 'pipe capacity/occupancy probes need fcntl/termios')
    async def fill_stdout_pipe(self):
        output=self.host.stdout._transport
        fd=output.get_extra_info('pipe').fileno()
        capacity=fcntl.fcntl(fd,fcntl.F_SETPIPE_SZ,4096)
        output.pause_reading()
        rid=await self.send('subagents_list_agents')
        size=array.array('i',[0]); end=asyncio.get_running_loop().time()+3
        while asyncio.get_running_loop().time()<end:
            fcntl.ioctl(fd,termios.FIONREAD,size,True)
            if size[0]==capacity: return output,rid
            await asyncio.sleep(.01)
        output.resume_reading()
        self.fail('stdout pipe did not fill')


    async def test_cancel_partial_response_closes_connection_without_another_frame(self):
        output,rid=await self.fill_stdout_pipe()
        try:
            self.host.stdin.write((dumps({'cancel':rid})+'\n').encode()); await self.host.stdin.drain()
            await self.send('subagents_inspect_agent', {'agent_id':'a'},rid='must-not-append')
            end=asyncio.get_running_loop().time()+3
            while self.host.returncode is None and asyncio.get_running_loop().time()<end:
                await asyncio.sleep(.01)
            self.assertEqual(self.host.returncode,0,'native host could not process cancellation with stdout full')
        finally:
            output.resume_reading()
            self.host.stdin.close()
            remaining=await self.host.stdout.read()
        self.assertNotIn(b'must-not-append',remaining)
        self.assertFalse(remaining.endswith(b'\n'),'cancelled partial output unexpectedly got a second frame')


    async def test_cancel_waiting_output_leaves_current_frame_and_connection_intact(self):
        output,rid=await self.fill_stdout_pipe()
        try:
            pending=await self.send('subagents_inspect_agent', {'agent_id':'a'})
            self.host.stdin.write((dumps({'cancel':pending})+'\n').encode()); await self.host.stdin.drain()
            last=await self.send('subagents_inspect_agent', {'agent_id':'a'})
        finally: output.resume_reading()
        self.assertEqual((await self.receive())['id'],rid)
        self.assertEqual((await self.receive())['id'],last)
        self.assertEqual((await self.rpc('subagents_inspect_agent', {'agent_id':'a'}))['result'],{})



class TransportTests(IpcHarness, unittest.IsolatedAsyncioTestCase):
    @posix_only
    async def check_blocked_stdin_cleanup(self,by_idle):
        config=self.config_path
        config.write_text(config.read_text().replace('rpcTimeoutSeconds=8','rpcTimeoutSeconds=1'))
        sid=await self.open_scope()
        run=await self.request('spawn',{'scope':sid,'request_id':'blocked','task':'model=silent|delay=120|work' if by_idle else 'UI_CONFIRM',
            'access':'read','idle_timeout_seconds':8 if by_idle else 60})
        if not by_idle:
            result=await self.request('wait',{'scope':sid,'run_ids':[run['run_id']],'timeout_seconds':4})
            self.assertEqual(result['reason'],'needs_input')
        owner=json.loads((self.home/'agents'/run['agent_id']/'owner.json').read_text())
        pgid=owner['guard_pid']; os.killpg(pgid,signal.SIGSTOP)
        try:
            # Three valid frames exceed the pipe + asyncio write-buffer capacity.
            for i in range(3):
                params={'scope':sid,'agent_id':run['agent_id'],'request_id':f'blocked-{i}',
                        'message':'x'*60000}
                with self.assertRaises(AgentError) as error:
                    await self.request('message',params,timeout=3)
                self.assertEqual(error.exception.code,'rpc_timeout')
            # UI replies use raw(), so they need the same bounded write guarantee.
            if not by_idle:
                with self.assertRaises(AgentError) as error:
                    await self.request('answer',{'scope':sid,'agent_id':run['agent_id'],'request_id':'answer',
                        'ui_request_id':'ui-1','answer':True},timeout=3)
                self.assertEqual(error.exception.code,'rpc_timeout')
            if by_idle:
                # A pending question makes wait return immediately; the loop below
                # observes terminal state, rather than pretending a question is done.
                until=asyncio.get_running_loop().time()+8
                while asyncio.get_running_loop().time()<until:
                    state=(await self.request('list',{'scope':sid}))['agents'][0]['state']
                    if state=='dormant': break
                    await asyncio.sleep(.05)
                self.assertEqual(state,'dormant')
            else:
                closed=await self.request('close',{'scope':sid,'agent_id':run['agent_id'],
                                                       'request_id':'close'},timeout=5)
                self.assertEqual(closed['cleanup'],'verified')
            done=await self.request('wait',{'scope':sid,'run_ids':[run['run_id']],'timeout_seconds':0})
            self.assertEqual(done['runs'][0]['state'],'timed_out' if by_idle else 'interrupted')
            self.assertEqual(group_members(pgid),[])
            # Retrying an uncertain mutation must read its stored error, not send it again.
            with self.assertRaises(AgentError) as replay:
                await self.request('message',params,timeout=3)
            self.assertEqual(replay.exception.code,'rpc_timeout')
        finally:
            with contextlib.suppress(ProcessLookupError): os.killpg(pgid,signal.SIGCONT)


    @posix_only
    async def test_backpressured_child_can_be_closed_after_rpc_timeout(self):
        await self.check_blocked_stdin_cleanup(False)


    @posix_only
    async def test_backpressured_model_is_stopped_by_inactivity(self):
        await self.check_blocked_stdin_cleanup(True)


    async def test_ipc_autostart_single_daemon(self):
        a, b = await asyncio.gather(self.request( "ping", {}), self.request( "ping", {}))
        self.assertEqual(a["pid"], b["pid"])


    async def test_wait_returns_completion_while_another_run_is_gated(self):
        await self.initialize()
        await self.call("scope_open", {"cwd": str(self.workspace)})
        gate = self.root / "release-slow"
        slow = await self.call("spawn", {"task": f"gate={gate}|slow", "access": "read", "request_id": "slow"})
        fast = await self.call("spawn", {"task": "fast", "access": "read", "request_id": "fast"})
        try:
            done = await self.call(
                "wait", {"run_ids": [slow["run_id"], fast["run_id"]], "timeout_seconds": 3600}
            )
            self.assertEqual(done["reason"], "completed")
            self.assertFalse(done["timed_out"])
            states = {r["id"]: r["state"] for r in done["runs"]}
            self.assertEqual(states, {slow["run_id"]: "running", fast["run_id"]: "completed"})
            result = await self.call("result", {"run_id": fast["run_id"]})
            gate.touch()
            remainder = await self.call("wait", {"run_ids": [slow["run_id"]], "timeout_seconds": 4})
            self.assertEqual(remainder["runs"][0]["state"], "completed")
        finally:
            gate.touch()


    async def test_wait_all_requires_every_terminal_run_even_after_failure_or_stop(self):
        await self.initialize()
        await self.call("scope_open", {"cwd": str(self.workspace)})
        for stopped in (False, True):
            with self.subTest(stopped=stopped):
                gate = self.root / f"release-all-{stopped}"
                pending = await self.call(
                    "spawn",
                    {"task": f"gate={gate}|pending", "access": "read", "request_id": f"all-pending-{stopped}"},
                )
                task = f'gate={self.root / "never-release"}|stopped' if stopped else "CRASH"
                terminal = await self.call(
                    "spawn", {"task": task, "access": "read", "request_id": f"all-terminal-{stopped}"}
                )
                try:
                    if stopped:
                        await self.call(
                            "soft_interrupt", {"agent_id": terminal["agent_id"], "request_id": "all-interrupt"}
                        )
                    ids = [terminal["run_id"], pending["run_id"]]
                    early = await self.call("wait", {"run_ids": ids, "timeout_seconds": 4})
                    self.assertEqual(early["reason"], "failed_or_stopped")
                    self.assertEqual(early["runs"][0]["state"], "interrupted" if stopped else "crashed")
                    blocked = await self.call("wait", {"run_ids": ids, "mode": "all", "timeout_seconds": 1})
                    self.assertTrue(blocked["timed_out"], blocked)
                    self.assertEqual(blocked["runs"][1]["state"], "running")
                    gate.touch()
                    complete = await self.call("wait", {"run_ids": ids, "mode": "all", "timeout_seconds": 4})
                    self.assertFalse(complete["timed_out"], complete)
                    self.assertEqual(complete["reason"], "failed_or_stopped")
                    self.assertEqual(complete["runs"][1]["state"], "completed")
                    self.assertTrue(all(r.get("result") for r in complete["runs"]))
                finally:
                    gate.touch()


    async def test_wait_returns_every_ready_result_in_the_selected_snapshot(self):
        await self.initialize()
        await self.call("scope_open", {"cwd": str(self.workspace)})
        gate = self.root / "release-pending"
        pending = await self.call(
            "spawn", {"task": f"gate={gate}|pending", "access": "read", "request_id": "pending"}
        )
        ready = []
        try:
            for i in range(2):
                run = await self.call(
                    "spawn", {"task": f"ready-{i}", "access": "read", "request_id": f"ready-{i}"}
                )
                await self.call("wait", {"run_ids": [run["run_id"]], "timeout_seconds": 4})
                ready.append(run["run_id"])
            page = await self.call("wait", {"run_ids": [pending["run_id"], *ready], "timeout_seconds": 3600})
            self.assertFalse(page["timed_out"])
            self.assertEqual(page["runs"][0]["state"], "running")
            self.assertEqual([r["id"] for r in page["runs"] if r.get("result")], ready)
            for rid in ready:
                self.assertTrue((await self.call("result", {"run_id": rid}))["result_sha256"])
        finally:
            gate.touch()


    async def test_named_agents_keep_labels_across_runs_and_results(self):
        await self.initialize()
        scope = await self.call("scope_open", {"cwd": str(self.workspace)})
        agents = []
        for index, name in enumerate(("git-stats-fix", "测试审查")):
            spawned = await self.call(
                "spawn", {"name": name, "task": name, "access": "read", "request_id": f"named-{index}"}
            )
            self.assertEqual(spawned["name"], name)
            agents.append(spawned)
        expected = {a["agent_id"]: a["name"] for a in agents}
        done = await self.finished_runs([a["run_id"] for a in agents], timeout_seconds=4)
        self.assertEqual({r["agent_id"]: r["name"] for r in done["runs"]}, expected)
        for a in agents:
            result = await self.call("result", {"run_id": a["run_id"]})
            self.assertEqual(result["run"]["name"], a["name"])
        listing = await self.call("list", {})
        self.assertEqual({r["id"]: r["name"] for r in listing["agents"]}, expected)
        self.assertEqual(listing["outstanding"]["total"], 0)
        resumed = await self.call("scope_open", {"cwd": str(self.workspace), "scope": scope["scope"]})
        self.assertEqual(resumed["outstanding"]["total"], 0)
        with self.assertRaises(AgentError) as conflict:
            await self.call('spawn', {'name':agents[0]['name'], 'task':'duplicate',
                'access':'read', 'request_id':'duplicate'})
        self.assertEqual(conflict.exception.code, 'name_conflict')
        follow = await self.call(
            "followup",
            {"agent_id": agents[0]["agent_id"], "message": "follow-up", "request_id": "next"},
        )
        self.assertEqual(follow["name"], agents[0]["name"])
        self.assertNotIn("execution", follow)
        next_result = await self.call("wait", {"run_ids": [follow["run_id"]], "timeout_seconds": 4})
        self.assertNotEqual(follow["run_id"], agents[0]["run_id"])
        self.assertEqual(next_result["runs"][0]["name"], agents[0]["name"])


    async def test_wait_returns_questions_and_stops_without_waiting_for_other_work(self):
        await self.initialize()
        await self.call("scope_open", {"cwd": str(self.workspace)})
        slow = await self.call("spawn", {"task": "delay=30|slow", "access": "read", "request_id": "slow"})
        asking = await self.call(
            "spawn", {"name": "permission-check", "task": "UI_CONFIRM", "access": "read", "request_id": "ask"}
        )
        remaining = await self.call(
            "spawn", {"task": "delay=30|remaining", "access": "read", "request_id": "remaining"}
        )
        ids = [slow["run_id"], asking["run_id"], remaining["run_id"]]
        alert = await self.call("wait", {"run_ids": ids, "timeout_seconds": 3600})
        self.assertEqual(alert["reason"], "needs_input")
        self.assertFalse(alert["timed_out"])
        question = alert["questions"][0]
        self.assertEqual(question["agent_id"], asking["agent_id"])
        self.assertEqual(question["method"], "confirm")
        all_alert = await self.call("wait", {"run_ids": ids, "mode": "all", "timeout_seconds": 3600})
        self.assertEqual(all_alert["reason"], "needs_input")
        self.assertEqual(all_alert["questions"][0]["id"], question["id"])
        self.assertEqual(question["name"], "permission-check")
        await self.call(
            "answer",
            {"agent_id": asking["agent_id"], "ui_request_id": question["id"], "answer": False, "request_id": "answer"},
        )
        await self.call("wait", {"run_ids": [asking["run_id"]], "timeout_seconds": 4})
        stopped = await self.call("close", {"agent_id": slow["agent_id"], "request_id": "stop"})
        self.assertEqual(stopped["cleanup"], "verified")
        alert = await self.call("wait", {"run_ids": ids, "timeout_seconds": 3600})
        self.assertEqual(alert["reason"], "failed_or_stopped")
        self.assertIn(alert["runs"][0]["state"], ("cancelled", "interrupted"))
        self.assertEqual(alert["runs"][2]["state"], "running")


    async def test_durable_unseen_result_after_daemon_restart(self):
        sid = await self.open_scope()
        a = await self.spawn(sid)
        await self.request( "wait", {"scope": sid, "run_ids": [a["run_id"]], "timeout_seconds": 4})
        first = await self.request( "result", {"scope": sid, "run_id": a["run_id"]})
        await self.request( "shutdown", {"force": True})
        until = asyncio.get_running_loop().time() + 8
        while ipc.exists(self.home) and asyncio.get_running_loop().time() < until:
            await asyncio.sleep(0.05)
        second = await self.request( "result", {"scope": sid, "run_id": a["run_id"]})
        self.assertEqual(first["result_sha256"], second["result_sha256"])
        listing = await self.request( "list", {"scope": sid})
        self.assertEqual(listing["outstanding"]["total"], 1)


    async def test_ipc_disconnected_mutation_still_has_idempotent_result(self):
        from metis_subagent.common import dumps

        sid = await self.open_scope()
        reader, writer = await ipc.connect(self.home)
        params = {
            "scope": sid,
            "request_id": "lost-reply",
            "cwd": str(self.workspace),
            "task": "hello",
            "access": "read",
        }
        writer.write((dumps({"v": PROTOCOL_VERSION, "op": "spawn", "params": params, "source":self.source}) + "\n").encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        await asyncio.sleep(0.5)
        result = await self.request( "spawn", params)
        self.assertTrue(result["replayed"])
        self.assertEqual((await self.request( "list", {"scope": sid}))["total"], 1)


    async def test_live_orphan_requires_close_before_respawn(self):
        self.command.append('--hold-eof')
        sid = await self.open_scope()
        a = await self.spawn(sid, "delay=30|orphan")
        pid = (await self.request( "ping", {}))["pid"]
        force_kill(pid)
        await asyncio.sleep(0.3)
        listing = await self.request( "list", {"scope": sid})
        self.assertEqual(listing["agents"][0]["state"], "orphaned")
        with self.assertRaises(AgentError) as cm:
            await self.request(
                "respawn", {"scope": sid, "agent_id": a["agent_id"], "request_id": "unsafe-respawn"}
            )
        self.assertEqual(cm.exception.code, "orphaned_worker")
        closed = await self.request( "close", {"scope": sid, "agent_id": a["agent_id"], "request_id": "reap"})
        self.assertEqual(closed["cleanup"], "verified")
        revived = await self.request(
            "respawn",
            {"scope": sid, "agent_id": a["agent_id"], "request_id": "revive", "message": "recovered"},
        )
        self.assertEqual(revived["generation"], 2)
        result = await self.request( "wait", {"scope": sid, "run_ids": [revived["run_id"]], "timeout_seconds": 4})
        self.assertEqual(result["runs"][0]["state"], "completed")


    async def test_long_wait_wakes_on_later_completion_or_question(self):
        await self.initialize()
        for task, reason in [('done','completed'), ('UI_CONFIRM','needs_input')]:
            with self.subTest(task=task):
                run = await self.call('spawn', {'task':'delay=0.5|'+task, 'access':'read','request_id':task})
                waiting = asyncio.create_task(self.call('wait', {'run_ids':[run['run_id']], 'timeout_seconds':3600}))
                self.assertIn('pid', await self.request('ping', {}))
                result = await asyncio.wait_for(waiting, 8)
                self.assertEqual(result['reason'], reason)
                self.assertFalse(result['timed_out'])
                if task == 'UI_CONFIRM':
                    self.assertEqual(result['questions'][0]['method'], 'confirm')
                else:
                    self.assertIn('Completed: done', result['runs'][0]['result']['text'])
                await self.call('close', {'agent_id':run['agent_id'], 'request_id':'close-'+task})

    async def test_continuation_receipt_is_not_a_consumption_guarantee(self):
        await self.initialize()
        agent = await self.call('spawn', {'name':'reviewer', 'task':'delay=1|NO_CONSUME',
            'access':'read', 'request_id':'spawn'})
        args = {'agent_id':agent['agent_id'], 'message':'Inspect only', 'request_id':'correction'}
        receipt = await self.call('message', args)
        self.assertEqual(receipt['name'], 'reviewer')
        self.assertEqual(receipt['run_id'], agent['run_id'])
        self.assertEqual(receipt['delivery'], 'queued')
        replay = await self.call('message', args)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt_id'], receipt['receipt_id'])
        await self.finished_runs([agent['run_id']], timeout_seconds=4)
        inspected = await self.call('inspect', {'agent_id':agent['agent_id']})
        matching = [r for r in inspected['receipts'] if r['id'] == receipt['receipt_id']]
        self.assertEqual([r['state'] for r in matching], ['not_consumed'])
        follow = await self.call('followup', {'agent_id':agent['agent_id'], 'message':'Next task', 'request_id':'next'})
        self.assertNotEqual(follow['run_id'], agent['run_id'])
        await self.finished_runs([follow['run_id']], timeout_seconds=4)

    async def test_cancelled_wait_does_not_kill_agent(self):
        await self.initialize()
        a = await self.call('spawn', {'task':'delay=1|keep-running', 'access':'read', 'request_id':'cancel-spawn'})
        waiting = asyncio.create_task(self.call('wait', {'run_ids':[a['run_id']], 'timeout_seconds':3600}))
        await asyncio.sleep(.05)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertEqual((await self.call('list', {}))['agents'][0]['state'], 'running')
        done = await self.call('wait', {'run_ids':[a['run_id']], 'timeout_seconds':4})
        self.assertEqual(done['runs'][0]['state'], 'completed')

    async def test_native_helper_exit_does_not_stop_worker(self):
        # The production pi-host really exits; the daemon and child are separate
        # owned processes and must finish the already-admitted work.
        env = os.environ.copy()
        host = await asyncio.create_subprocess_exec(python_executable(), str(ROOT/'main.py'),
            '--home', str(self.home), 'pi-host', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
        await self.request('ping', {})  # retain the daemon's owned Popen handle
        async def host_call(rid, operation, params, **extra):
            host.stdin.write((dumps({'id':rid, 'operation':operation, 'params':params, **extra})+'\n').encode())
            await host.stdin.drain()
            value = json.loads(await asyncio.wait_for(host.stdout.readline(), 8))
            self.assertTrue(value['ok'], value)
            return value['result']
        try:
            opened = await host_call('init','initialize', {'cwd':str(self.workspace)}, source=self.source)
            a = await host_call('spawn','subagents_spawn_agent', {'task':'delay=0.4|survive-helper',
                'access':'read', 'request_id':'survive'})
            host.stdin.close()
            await asyncio.wait_for(host.wait(), 5)
            self.assertEqual(host.returncode, 0, (await host.stderr.read()).decode())
            # Detach replaced the frontend lease; a fresh native scope-open is
            # required before receiving the eventual completion.
            await self.request('scope_open', {'scope':opened['scope'], 'cwd':str(self.workspace)})
            done = await self.request('wait', {'scope':opened['scope'], 'run_ids':[a['run_id']], 'timeout_seconds':4})
            self.assertEqual(done['runs'][0]['state'], 'completed')
        finally:
            if host.returncode is None:
                host.kill()
            await host.communicate()

    async def test_base_env_survives_daemon_restart(self):
        env_file = self.root/'child-env.json'
        # The probe program must be startable on both platforms (whoami is a
        # console executable there and a coreutils binary on Linux).
        self.config_path.write_text('[subagents]\nrpcTimeoutSeconds=8\nstartupTimeoutSeconds=15\n'
            '[subagents.profiles.reader.env]\nPI_TEST_PROBE_FILE='+json.dumps(str(env_file))+'\nPI_TEST_PROBE_CMD="whoami"\n')
        sid = await self.open_scope()
        a = await self.spawn(sid, 'warm')
        first = json.loads(env_file.read_text())
        self.assertTrue(first['path'])
        self.assertEqual(first['rc'], 0)
        await self.request('close', {'scope':sid, 'agent_id':a['agent_id'], 'request_id':'env-close'})
        await self.request('shutdown', {'force':True})
        await asyncio.to_thread(self.daemons[-1].wait, 10)
        env_file.unlink()
        # No re-open/env rebind: only durable non-secret base values can supply PATH.
        empty = {**self.source, 'env':{}}
        revived = await self.request('respawn', {'scope':sid, 'agent_id':a['agent_id'], 'request_id':'env-wake'}, source=empty)
        second = json.loads(env_file.read_text())
        self.assertTrue(second['path'])
        self.assertEqual(second['rc'], 0)
        self.assertEqual(revived['generation'], 2)

    async def test_restart_persists_base_env_but_never_secrets(self):
        self.config_path.write_text('[subagents]\nchildEnv=["SECRET_CANARY"]\n')
        self.source['env']['SECRET_CANARY'] = 'sk-do-not-persist'
        sid = await self.open_scope()
        await self.request('shutdown', {'force':True})
        await asyncio.to_thread(self.daemons[-1].wait, 10)
        import sqlite3
        # Close explicitly: the context manager keeps the connection (and the
        # file handle) open, which blocks the temp-tree cleanup on Windows.
        db = sqlite3.connect(self.home/'registry.sqlite')
        try:
            stored = json.loads(db.execute('SELECT base_env FROM scopes WHERE id=?', (sid,)).fetchone()[0])
        finally:
            db.close()
        self.assertIn('PATH', stored)
        self.assertNotIn('SECRET_CANARY', stored)
        self.assertNotIn(b'sk-do-not-persist', (self.home/'registry.sqlite').read_bytes())

class LivePiLifecycleTests(IpcHarness, unittest.IsolatedAsyncioTestCase):
    """Opt-in real SDK + isolated offline provider; never the user's app/config."""
    use_fake = False

    async def asyncSetUp(self):
        if os.environ.get('SUBAGENT_PI_LIVE_PI') != '1':
            raise unittest.SkipTest('set SUBAGENT_PI_LIVE_PI=1 for the isolated offline real-SDK lifecycle checks')
        self.sdk = (REPO_ROOT/'node_modules/@earendil-works/pi-coding-agent/dist/index.js').resolve()
        self.node = shutil.which('node')
        if not self.sdk.is_file():
            # A shallow clone may keep only the sibling runtime's installed tree;
            # the parent CI has node_modules in place.
            sibling = REPO_ROOT.parent/'runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
            self.sdk = sibling.resolve() if sibling.is_file() else self.sdk
        if not self.sdk.is_file() or not self.node:
            self.skipTest('local Pi SDK and Node are required')
        # The SDK resolves its own dependencies (undici, ...) from its install tree.
        self.node_modules = self.sdk.parents[2]
        await super().asyncSetUp()
        self.pi_home = self.root/'userhome'; self.pi_home.mkdir()
        self.pi_agent = self.root/'agent'; self.pi_agent.mkdir()
        # All profiles need the fixture provider, including write/default and
        # profiles that add their own extensions. This is disposable ambient
        # Pi configuration, not a production executable/extension override.
        (self.pi_agent/'settings.json').write_text(json.dumps({
            'extensions':[str(TEST_ROOT/'pi_mock_provider.ts')],
            'compaction':{'enabled':False}, 'retry':{'enabled':False}}))
        self.source['env']['HOME'] = str(self.pi_home)
        self.source['parent'].update(agent_dir=str(self.pi_agent), sdk_path=str(self.sdk), node_path=self.node,
            model={'provider':'pi-mock-offline','id':'mock'})

    def write_config(self, **profile_env):
        knobs = {'PI_OFFLINE':'"1"', 'PI_SKIP_VERSION_CHECK':'"1"', 'PI_TELEMETRY':'"0"', **profile_env}
        # Runtime selects reader for read access and default for write access.
        # Both must receive the scenario knobs; model identity comes from the
        # native parent, and provider registration from its isolated agent dir.
        env = ''.join(f'{k}={v}\n' for k,v in knobs.items())
        self.config_path.write_text('[subagents]\nrpcTimeoutSeconds=20\nstartupTimeoutSeconds=60\n'
            + ''.join(f'[subagents.profiles.{profile}.env]\n{env}' for profile in ('default','reader')))

    async def lifecycle(self, first_event=False):
        await self.initialize()
        scope = self.scope
        a = await self.call('spawn', {'access':'read', 'task':'offline first', 'request_id':'live-spawn'})
        # A native busy follow-up joins its current run. Two distinct tasks must
        # settle the first before starting the second, unlike the retired queue.
        await self.call('wait', {'run_ids':[a['run_id']], 'timeout_seconds':8})
        q = await self.call('followup', {'agent_id':a['agent_id'], 'message':'offline second', 'request_id':'live-follow'})
        if first_event:
            done = await self.call('wait', {'run_ids':[a['run_id'], q['run_id']], 'timeout_seconds':8})
        else:
            done = await self.finished_runs([a['run_id'], q['run_id']], scope=scope, timeout_seconds=8)
        stderr = (self.home/'agents'/a['agent_id']/'stderr.log').read_text()
        return scope, a, q, done, stderr

    async def results(self,scope,runs):
        return [(await self.call('result',{'scope':scope,'run_id':r['id']}))['text'] for r in runs]


    async def payloads(self,scope,runs):
        return [await self.call('result',{'scope':scope,'run_id':r['id']}) for r in runs]


    async def wait_marker(self,path,text,count=1,timeout=15.0):
        """Bounded handshake on a child-side marker; never a fixed sleep."""
        loop=asyncio.get_running_loop(); end=loop.time()+timeout
        while loop.time()<end:
            if path.exists() and path.read_text().count(text)>=count: return path.read_text()
            await asyncio.sleep(.05)
        raise AssertionError(f'{text!r} x{count} not observed in {path} within {timeout}s')


    async def test_model_question_reaches_wait_and_answer_returns_to_the_same_task(self):
        self.write_config(PI_MOCK_ASK_PARENT='"1"',PI_MOCK_CONTEXT='"1"')
        await self.initialize(); await self.call('scope_open',{'cwd':str(self.workspace)})
        spawned=await self.call('spawn',{'task':'ask before proceeding','request_id':'ask','access':'read'})
        alert=await self.call('wait', {'run_ids': [spawned['run_id']], 'timeout_seconds': 8})
        self.assertEqual(alert['reason'],'needs_input',alert)
        question=alert['questions'][0]
        self.assertEqual(question['title'],'Which branch should I use?')
        self.assertEqual(question['run_id'],spawned['run_id'])
        await self.call('answer',{'agent_id':spawned['agent_id'],'request_id':'answer',
            'ui_request_id':question['id'],'answer':'Use feature/parent-answer'})
        done=await self.call('wait',{'run_ids':[spawned['run_id']],'timeout_seconds':8})
        self.assertEqual(done['reason'],'completed'); self.assertEqual(done['runs'][0]['result']['text'],'MOCK_REPLY_2')
        trace=(self.home/'agents'/spawned['agent_id']/'stderr.log').read_text()
        self.assertIn('Use feature/parent-answer',trace)


    async def test_provider_failure_returns_to_parent_wait(self):
        self.write_config(PI_MOCK_FAIL='"1"')
        await self.initialize(); await self.call('scope_open',{'cwd':str(self.workspace)})
        spawned=await self.call('spawn',{'task':'fail offline','request_id':'fail','access':'read'})
        done=await self.call('wait', {'run_ids': [spawned['run_id']], 'timeout_seconds': 8})
        self.assertEqual(done['reason'],'failed_or_stopped'); self.assertFalse(done['timed_out'])
        self.assertEqual(done['runs'][0]['state'],'failed'); self.assertIn('Mock provider failed',done['runs'][0]['error'])


    async def test_thinking_uses_model_capabilities_defaults_and_respawn(self):
        self.write_config(PI_MOCK_THINKING='"1"')
        settings=self.pi_agent/'settings.json'
        settings.write_text(json.dumps({**json.loads(settings.read_text()),
            'compaction':{'enabled':False},'defaultThinkingLevel':'low'}))
        before=settings.read_bytes()
        await self.initialize(); await self.call('scope_open',{'cwd':str(self.workspace)})
        with self.assertRaises(AgentError) as unsupported:
            await self.call('spawn', {'task':'must never call model','access':'read',
                'request_id':'bad-thinking','thinking':'medium'})
        self.assertEqual(unsupported.exception.code,'unsupported_thinking')
        self.assertIn('available:',unsupported.exception.message)
        for path in (self.home/'agents').glob('*/stderr.log'):
            self.assertNotIn('PI_MOCK_REPLY',path.read_text())
        for requested in (None,'max'):
            params={'task':'thinking check','access':'read','request_id':f'thinking-{requested}'}
            if requested: params['thinking']=requested
            spawned=await self.call('spawn',params)
            self.assertEqual(spawned['thinking'],requested or 'low')
            self.assertEqual(spawned['available_thinking'],['low','high','max'])
            done=await self.call('wait',{'run_ids':[spawned['run_id']],'timeout_seconds':8})
            self.assertEqual(done['runs'][0]['result']['text'],'MOCK_REPLY_1')
            await self.call('close',{'agent_id':spawned['agent_id'],'request_id':f'stop-{requested}'})
            await self.call('respawn',{'agent_id':spawned['agent_id'],'request_id':f'respawn-{requested}'})
            state=await self.call('inspect',{'agent_id':spawned['agent_id']})
            self.assertEqual(state['agent']['thinking'],requested or 'low')
        self.assertEqual(settings.read_bytes(),before)


    async def test_stock_sdk_completion_and_follow_up(self):
        self.write_config()
        scope,a,q,done,_=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_1','MOCK_REPLY_2'])
        close=await self.call('close',{'scope':scope,'agent_id':a['agent_id'],'request_id':'close'})
        self.assertEqual(close['cleanup'],'verified')


    async def test_sdk_thinking_and_silent_tool_outlive_idle_limit(self):
        self.write_config(PI_MOCK_PROGRESS='"thinking"',PI_MOCK_STREAM_MS='"2200"',PI_MOCK_TOOL_MS='"2200"')
        await self.initialize()
        scope=(await self.call('scope_open',{'cwd':str(self.workspace)}))['scope']
        a=await self.call('spawn',{'scope':scope,'access':'write','task':'offline work',
            'idle_timeout_seconds':1,'request_id':'idle-live'})
        done=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':15})
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(done['runs'][0]['state'],'completed',done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_2'])
        trace=(self.home/'agents'/a['agent_id']/'stderr.log').read_text()
        self.assertIn('PI_MOCK_TOOL_END',trace)
        state=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']})
        self.assertEqual(state['agent']['active_tools'],[])
        self.assertIsNone(state['agent']['idle_seconds'])


    async def test_sdk_silent_model_is_stopped(self):
        self.write_config(PI_MOCK_STREAM_MS='"30000"')
        await self.initialize()
        scope=(await self.call('scope_open',{'cwd':str(self.workspace)}))['scope']
        a=await self.call('spawn',{'scope':scope,'access':'read','task':'offline silence',
            'idle_timeout_seconds':1,'request_id':'idle-stall'})
        done=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        self.assertEqual(done['runs'][0]['state'],'timed_out',done)
        state=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']})
        self.assertEqual(state['agent']['cleanup'],'verified')


    async def test_sdk_ui_timeout_releases_the_watchdog_pause(self):
        self.write_config(PI_MOCK_CONFIRM='"1"',PI_MOCK_CONFIRM_TIMEOUT='"100"',PI_MOCK_AFTER_CONFIRM_MS='"30000"')
        await self.initialize()
        scope=(await self.call('scope_open',{'cwd':str(self.workspace)}))['scope']
        a=await self.call('spawn',{'scope':scope,'access':'read','task':'ASK offline',
            'idle_timeout_seconds':1,'request_id':'ui-expire'})
        path=self.home/'agents'/a['agent_id']/'stderr.log'
        await self.wait_marker(path,'PI_MOCK_CONFIRM_ANSWER false')
        done=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        self.assertEqual(done['runs'][0]['state'],'timed_out',done)
        self.assertEqual(done.get('questions',[]),[])


    async def test_startup_commands_finish_before_tasks_without_model_calls(self):
        self.write_config(PI_MOCK_STARTUP_COMMANDS='"1"')
        scope,a,q,done,trace=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_1','MOCK_REPLY_2'])
        self.assertLess(trace.index('MOCK_COMMAND_CAPTURED'),trace.index('MOCK_COMMAND_NESTED'))
        self.assertLess(trace.index('MOCK_COMMAND_NESTED'),trace.index('PI_MOCK_REPLY 1'))
        report=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id'],'limit':100,'max_bytes':16384})
        self.assertFalse([e for e in report['events'] if e['type']=='extension_error'])


    async def test_startup_commands_do_not_admit_unowned_prompts(self):
        self.write_config(PI_MOCK_STARTUP_COMMANDS='"reject"',PI_MOCK_CONTEXT='"1"')
        scope,a,q,done,trace=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_1','MOCK_REPLY_2'])
        self.assertNotIn('UNOWNED_STARTUP_INPUT',trace)
        self.assertEqual(trace.count('MOCK_COMMAND_NESTED'),1)
        report=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id'],'limit':100,'max_bytes':16384})
        errors=[e for e in report['events'] if e['type']=='extension_error']
        self.assertEqual(len(errors),3,errors)
        self.assertTrue(all('Input rejected' in e['data']['error'] for e in errors))


    async def test_extension_stdout_cannot_corrupt_protocol_events(self):
        self.write_config(PI_MOCK_STDOUT='"1"')
        scope,a,q,done,trace=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_1','MOCK_REPLY_2'])
        self.assertIn('MOCK_EXTENSION_LOG',trace)
        self.assertEqual(trace.count('\x1b]777;notify;pi;MOCK_NOTIFY\x07'),2)
        report=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id'],'limit':100,'max_bytes':16384})
        kinds=[e['type'] for e in report['events']]
        self.assertNotIn('protocol_warning',kinds)
        self.assertEqual(kinds.count('agent_end'),2)
        self.assertEqual(kinds.count('run_terminal'),2)


    async def sdk_output_backpressure(self,critical):
        release=self.root/'release-tool'; report=self.root/'output-buffer.json'
        self.write_config(PI_MOCK_TOOL_MS='"10"',PI_MOCK_TOOL_RELEASE=json.dumps(str(release)),
            PI_MOCK_TOOL_REPORT=json.dumps(str(report)),**({'PI_MOCK_TOOL_CRITICAL':'"1"'} if critical else {}))
        scope,a,trace=await self.start_case()
        await self.wait_marker(trace,'PI_MOCK_TOOL_START')
        # SO_PEERCRED identifies only this harness's private daemon. Pause its
        # reader without touching global Pi/Codex or creating paid model calls.
        _,writer=await ipc.connect(self.home)
        pid,_,_=struct.unpack('3i',writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        writer.close(); await writer.wait_closed()
        owner=json.loads((self.home/'agents'/a['agent_id']/'owner.json').read_text())
        os.kill(pid,signal.SIGSTOP)
        try:
            release.touch()
            if critical:
                node=Path('/proc')/str(owner['pi_pid'])
                end=asyncio.get_running_loop().time()+10
                while node.exists() and asyncio.get_running_loop().time()<end: await asyncio.sleep(.02)
                self.assertFalse(node.exists(),'critical output overload did not stop the owned SDK child')
                self.assertFalse(report.exists(),'critical output was silently buffered or discarded')
            else:
                await self.wait_marker(report,'after')
                metrics=json.loads(report.read_text())
                self.assertLess(metrics['after']['bytes'],8*1024*1024,'SDK stdout buffer exceeded its cap')
        finally: os.kill(pid,signal.SIGCONT)
        alert=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        if critical:
            self.assertEqual(alert['runs'][0]['state'],'crashed')
            self.assertIn('capacity exceeded',trace.read_text())
        else:
            self.assertEqual(alert['reason'],'needs_input')
            question=alert['questions'][0]
            self.assertEqual(question['title'],'After progress')
            await self.call('answer',{'scope':scope,'agent_id':a['agent_id'],
                'ui_request_id':question['id'],'answer':True,'request_id':'answer'})
            await self.call('wait', {'scope':scope, 'run_ids':[a['run_id']], 'timeout_seconds':8})
            queued=await self.call('followup', {'scope':scope, 'agent_id':a['agent_id'], 'message':'NEXT', 'request_id':'follow'})
            result=await self.finished_runs([a['run_id'], queued['run_id']], scope=scope, timeout_seconds=8)
            self.assertFalse(result['timed_out'])
            self.assertEqual(await self.results(scope,result['runs']),['MOCK_REPLY_2','MOCK_REPLY_3'])
        closed=await self.call('close',{'scope':scope,'agent_id':a['agent_id'],'request_id':'close'})
        self.assertEqual(closed['cleanup'],'verified')


    @posix_only
    async def test_sdk_output_backpressure_keeps_questions_results_and_followups(self):
        await self.sdk_output_backpressure(False)


    @posix_only
    async def test_sdk_critical_output_overflow_is_a_crash_not_a_completion(self):
        await self.sdk_output_backpressure(True)


    async def test_sdk_extension_input_overflow_crashes_without_false_completion(self):
        release=self.root/'queue-release'
        self.write_config(PI_MOCK_TOOL_MS='"1"',PI_MOCK_QUEUE_FLOOD='"1"',
                          PI_MOCK_TOOL_RELEASE=json.dumps(str(release)))
        await self.initialize()
        scope=(await self.call('scope_open',{'cwd':str(self.workspace)}))['scope']
        a=await self.call('spawn',{'scope':scope,'task':'offline first',
            'access':'write','request_id':'queue-flood-spawn'})
        release.touch()
        done=await self.finished_runs([a['run_id']], scope=scope, timeout_seconds=8)
        self.assertFalse(done['timed_out'],done)
        self.assertEqual([r['state'] for r in done['runs']],['crashed'])
        stderr=(self.home/'agents'/a['agent_id']/'stderr.log').read_text()
        self.assertIn('input queue capacity exceeded',stderr)
        close=await self.call('close',{'scope':scope,'agent_id':a['agent_id'],
            'request_id':'queue-flood-close'})
        self.assertEqual(close['cleanup'],'verified')


    async def test_before_settle_work_and_native_continuation(self):
        self.write_config(PI_MOCK_CONTINUE='"1"',PI_MOCK_SETTLE_MS='"100"')
        scope,a,q,done,trace=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertIn('PI_MOCK_BEFORE_SETTLE',trace)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_2','MOCK_REPLY_3'])


    async def test_multiple_nested_extension_inputs_remain_in_the_original_task(self):
        self.write_config(PI_MOCK_SETTLED_SEND='"ONE"',PI_MOCK_SETTLED_SIBLING='"TWO"',
                          PI_MOCK_SETTLED_NESTED='"THREE"',PI_MOCK_SETTLED_INPUT_MS='"150"',PI_MOCK_CONTEXT='"1"')
        scope,a,q,done,trace=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_4','MOCK_REPLY_5'])
        entered=re.findall(r'PI_MOCK_SETTLED_INPUT_TEXT (.+)',trace)
        self.assertEqual(entered,['ONE','TWO','THREE'])
        before=await self.payloads(scope,done['runs'])
        after=await self.payloads(scope,done['runs'])
        self.assertEqual([r['result_sha256'] for r in before],[r['result_sha256'] for r in after])


    async def test_handled_extension_continuation_drains_without_an_extra_run(self):
        self.write_config(PI_MOCK_SETTLED_SEND='"HANDLED"',PI_MOCK_SETTLED_INPUT='"handled"',
                          PI_MOCK_SETTLED_INPUT_MS='"150"')
        scope,a,q,done,trace=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_1','MOCK_REPLY_2'])
        self.assertIn('PI_MOCK_SETTLED_INPUT_MODE handled',trace)


    async def test_handled_primary_fails_and_the_next_task_runs(self):
        self.write_config(PI_MOCK_BLOCK_INPUT='"offline first"',PI_MOCK_BLOCK_MS='"150"',
                          PI_MOCK_BLOCK_RESULT='"handled"')
        scope,a,q,done,trace=await self.lifecycle(first_event=True)
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(done['reason'],'failed_or_stopped')
        self.assertEqual(done['runs'][0]['state'],'failed')
        following=await self.call('wait',{'scope':scope,'run_ids':[q['run_id']],'timeout_seconds':8})
        self.assertEqual(following['runs'][0]['state'],'completed')
        done['runs'][1]=following['runs'][0]
        self.assertEqual(await self.results(scope,done['runs']),['','MOCK_REPLY_1'])
        first=(await self.payloads(scope,done['runs']))[0]
        self.assertIn('without producing',first['run']['error'])


    async def test_v2_native_input_reaches_the_next_tool_loop(self):
        self.write_config(PI_MOCK_TOOL_MS='"1000"',PI_MOCK_WIRE='"1"')
        scope,a,path=await self.start_case()
        await self.wait_marker(path,'PI_MOCK_TOOL_START')
        sent=await self.call('followup',{'scope':scope,'agent_id':a['name'],
            'message':'NATIVE_TEXT','request_id':'native'})
        self.assertEqual(sent['run_id'],a['run_id'])
        done=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        self.assertEqual(done['runs'][0]['state'],'completed',done)
        wires=[json.loads(line.split(' ',2)[2]) for line in path.read_text().splitlines() if line.startswith('PI_MOCK_WIRE ')]
        self.assertNotIn('NATIVE_TEXT',wires[0]['texts']); self.assertIn('NATIVE_TEXT',wires[1]['texts'])
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_2'])


    async def test_v2_cooperative_interrupt_retains_pid_and_accepts_new_task(self):
        self.write_config(PI_MOCK_STREAM_MS='"10000"',PI_MOCK_SLOW_FIRST='"1"',PI_MOCK_ABORT_SIGNAL='"1"')
        scope,a,path=await self.start_case()
        await self.wait_marker(path,'PI_MOCK_REPLY 1')
        before=(await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']}))['agent']
        owner_path=self.home/'agents'/a['agent_id']/'owner.json'
        pid=json.loads(owner_path.read_text())['pi_pid']
        stopped=await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'stop'})
        self.assertTrue(stopped['runtime_retained'],stopped)
        after=(await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']}))['agent']
        self.assertEqual((pid,before['generation']),(json.loads(owner_path.read_text())['pi_pid'],after['generation']))
        b=await self.call('followup',{'scope':scope,'agent_id':a['agent_id'],'message':'NEW_TASK','request_id':'next'})
        old=await self.call('result',{'scope':scope,'run_id':a['run_id']})
        self.assertEqual(old['run']['state'],'interrupted')
        done=await self.call('wait',{'scope':scope,'run_ids':[b['run_id']],'timeout_seconds':8})
        self.assertEqual(done['runs'][0]['state'],'completed',done)


    async def test_v2_idle_message_persists_across_unload_without_a_model_turn(self):
        self.write_config(PI_MOCK_WIRE='"1"',PI_MOCK_THINKING='"1"')
        scope,a,path=await self.start_case()
        await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        before=(await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']}))['agent']
        sent=await self.call('message',{'scope':scope,'agent_id':a['agent_id'],
            'message':'IDLE_HISTORY','request_id':'store'})
        self.assertEqual((sent['run_id'],sent['delivery']),(None,'stored'))
        self.assertEqual(path.read_text().count('PI_MOCK_REPLY'),1)
        await self.call('close',{'scope':scope,'agent_id':a['agent_id'],'request_id':'unload'})
        b=await self.call('followup',{'scope':scope,'agent_id':a['agent_id'],
            'message':'READ_HISTORY','request_id':'wake'})
        done=await self.call('wait',{'scope':scope,'run_ids':[b['run_id']],'timeout_seconds':8})
        self.assertEqual(done['runs'][0]['state'],'completed',done)
        after=(await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']}))['agent']
        self.assertEqual((before['resolved_model'],before['thinking']),(after['resolved_model'],after['thinking']))
        wire=json.loads([line for line in path.read_text().splitlines() if line.startswith('PI_MOCK_WIRE ')][-1].split(' ',2)[2])
        self.assertIn('IDLE_HISTORY',wire['texts'])


    async def test_v2_parent_question_interrupt_retains_runtime_and_rejects_old_answer(self):
        self.write_config(PI_MOCK_ASK_PARENT='"1"')
        scope,a,path=await self.start_case()
        waiting=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        self.assertEqual(waiting['reason'],'needs_input')
        stopped=await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'stop'})
        self.assertTrue(stopped['runtime_retained'],stopped)
        with self.assertRaises(AgentError):
            await self.call('answer', {'scope':scope,'agent_id':a['agent_id'],'request_id':'answer',
                'ui_request_id':waiting['questions'][0]['id'],'answer':'late'})
        state=(await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']}))['agent']
        self.assertEqual(state['state'],'idle'); self.assertNotIn('pending_input',state)


    async def test_v2_finite_primary_preflight_cannot_start_work_after_interrupt(self):
        self.write_config(PI_MOCK_BLOCK_INPUT='"BLOCK"',PI_MOCK_BLOCK_MS='"900"')
        scope,a,path=await self.start_case('BLOCK')
        await self.wait_marker(path,'PI_MOCK_INPUT_BLOCKED_START')
        stopped=await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'stop'})
        self.assertEqual((stopped['runtime_retained'],stopped['forced']),(False,True))
        self.assertNotIn('PI_MOCK_REPLY',path.read_text())
        state=(await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']}))['agent']
        self.assertEqual(state['cleanup'],'verified')


    async def test_v2_finite_native_preflight_cannot_repopulate_cancelled_sdk_queue(self):
        self.write_config(PI_MOCK_STREAM_MS='"10000"',PI_MOCK_SLOW_FIRST='"1"',PI_MOCK_ABORT_SIGNAL='"1"',
                          PI_MOCK_BLOCK_INPUT='"BLOCK_NATIVE"',PI_MOCK_BLOCK_MS='"900"')
        scope,a,path=await self.start_case()
        await self.wait_marker(path,'PI_MOCK_REPLY 1')
        await self.call('message',{'scope':scope,'agent_id':a['agent_id'],
            'message':'BLOCK_NATIVE','request_id':'native'})
        await self.wait_marker(path,'PI_MOCK_INPUT_BLOCKED_START')
        stopped=await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'stop'})
        self.assertEqual((stopped['runtime_retained'],stopped['forced']),(False,True))
        self.assertEqual(path.read_text().count('PI_MOCK_REPLY'),1)
        b=await self.call('followup',{'scope':scope,'agent_id':a['agent_id'],
            'message':'REPLACEMENT','request_id':'wake'})
        # The restored mock's first call is slow; confirm the old native input was never replayed, then stop it.
        await self.wait_marker(path,'PI_MOCK_REPLY 1',count=2)
        await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'stop-next'})
        result=await self.call('result',{'scope':scope,'run_id':b['run_id']})
        self.assertEqual(result['run']['state'],'interrupted')
        self.assertEqual(path.read_text().count('PI_MOCK_INPUT_BLOCKED_START'),1)


    async def test_v2_late_cancelled_owner_cannot_add_custom_history_or_question(self):
        release=self.root/'release-late-ui'
        self.write_config(PI_MOCK_STREAM_MS='"10000"',PI_MOCK_ABORT_SIGNAL='"1"',
                          PI_MOCK_LATE_UI_RELEASE=json.dumps(str(release)))
        scope,a,path=await self.start_case()
        await self.wait_marker(path,'PI_MOCK_REPLY 1')
        stopped=await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'stop'})
        self.assertTrue(stopped['runtime_retained'])
        release.touch(); await self.wait_marker(path,'PI_MOCK_LATE_UI_FINISHED')
        state=(await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']}))['agent']
        self.assertEqual(state['state'],'idle'); self.assertNotIn('pending_input',state)
        sessions=list((self.home/'agents'/a['agent_id']/'sessions').glob('*.jsonl'))
        self.assertTrue(sessions); self.assertNotIn('STALE_CUSTOM',sessions[0].read_text())


    async def test_v2_queued_nextturn_custom_input_is_not_retained_after_cancel(self):
        once=self.root/'nextturn-once'
        self.write_config(PI_MOCK_STREAM_MS='"10000"',PI_MOCK_ABORT_SIGNAL='"1"',PI_MOCK_WIRE='"1"',
                          PI_MOCK_NEXTTURN='"CANCELLED_NEXTTURN_SENTINEL"',PI_MOCK_NEXTTURN_ONCE_FILE=json.dumps(str(once)))
        scope,a,path=await self.start_case()
        await self.wait_marker(path,'PI_MOCK_NEXTTURN_QUEUED'); await self.wait_marker(path,'PI_MOCK_REPLY 1')
        stopped=await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'stop'})
        self.assertEqual((stopped['runtime_retained'],stopped['forced']),(False,True))
        await self.call('followup',{'scope':scope,'agent_id':a['agent_id'],
            'message':'CLEAN_REPLACEMENT','request_id':'wake'})
        await self.wait_marker(path,'PI_MOCK_REPLY 1',count=2)
        wire=json.loads([line for line in path.read_text().splitlines() if line.startswith('PI_MOCK_WIRE ')][-1].split(' ',2)[2])
        self.assertNotIn('CANCELLED_NEXTTURN_SENTINEL',wire['texts']); self.assertIn('CLEAN_REPLACEMENT',wire['texts'])


    async def test_native_preflight_finishes_before_extension_continuation(self):
        self.write_config(PI_MOCK_STREAM_MS='"200"',PI_MOCK_EXT_FOLLOWUP='"EXTENSION_CONTINUATION"',PI_MOCK_WIRE='"1"',
                          PI_MOCK_BLOCK_INPUT='"NATIVE"',PI_MOCK_BLOCK_MS='"800"')
        scope,a,path=await self.start_case()
        await self.wait_marker(path,'PI_MOCK_REPLY 1')
        sent=await self.call('message',{'scope':scope,'agent_id':a['agent_id'],
            'message':'NATIVE','request_id':'native'})
        await self.wait_marker(path,'PI_MOCK_INPUT_BLOCKED_START')
        done=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        self.assertEqual(done['runs'][0]['state'],'completed',done)
        wires=[json.loads(line.split(' ',2)[2]) for line in path.read_text().splitlines() if line.startswith('PI_MOCK_WIRE ')]
        self.assertIn('NATIVE',wires[1]['texts']); self.assertNotIn('EXTENSION_CONTINUATION',wires[1]['texts'])
        self.assertIn('EXTENSION_CONTINUATION',wires[2]['texts'])
        inspected=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id'],'limit':100,'max_bytes':16384})
        self.assertEqual([r['state'] for r in inspected['receipts'] if r['id']==sent['receipt_id']],['consumed'])


    async def start_case(self,task='FIRST'):
        await self.initialize()
        scope=(await self.call('scope_open',{'cwd':str(self.workspace)}))['scope']
        a=await self.call('spawn',{'scope':scope,'cwd':str(self.workspace),'access':'write',
            'task':task,'request_id':'spawn'})
        return scope,a,self.home/'agents'/a['agent_id']/'stderr.log'


    async def follow_and_wait(self,scope,a):
        await self.call('wait', {'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        q=await self.call('followup', {'scope':scope,'agent_id':a['agent_id'],
            'message':'NEXT_TASK','request_id':'follow'})
        done=await self.finished_runs([a['run_id'], q['run_id']], scope=scope, timeout_seconds=8)
        self.assertFalse(done['timed_out'],done)
        self.assertEqual([r['state'] for r in done['runs']],['completed','completed'])
        return done


    async def test_concurrent_extension_submissions_have_serial_preflights_and_preserve_forced_prompt(self):
        release=self.root/'release'; release.mkdir()
        self.write_config(PI_MOCK_EXT_FOLLOWUP='"ONE,TWO"',PI_MOCK_BLOCK_INPUT='"ONE,TWO"',
                          PI_MOCK_BLOCK_MS='"60000"',PI_MOCK_BLOCK_RELEASE_DIR=json.dumps(str(release)),
                          PI_MOCK_FORCE_PROMPT='"KEEP_FORCED_PROMPT"',PI_MOCK_WIRE='"1"')
        scope,a,path=await self.start_case()
        await self.wait_marker(path,'PI_MOCK_INPUT_BLOCKED_START 1 ONE')
        # Both inputs were accepted in agent_start. The second preflight cannot
        # run ahead, even if its release is already available.
        (release/'2').touch()
        self.assertNotIn('PI_MOCK_INPUT_BLOCKED_START 2',path.read_text())
        (release/'1').touch()
        done=await self.follow_and_wait(scope,a)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_3','MOCK_REPLY_4'])
        trace=path.read_text()
        self.assertLess(trace.index('PI_MOCK_INPUT_BLOCKED_END 1'),trace.index('PI_MOCK_INPUT_BLOCKED_START 2'))
        wires=[json.loads(line.split(' ',2)[2]) for line in trace.splitlines() if line.startswith('PI_MOCK_WIRE ')]
        self.assertEqual([w['forced'] for w in wires],['KEEP_FORCED_PROMPT']*4)
        self.assertIn('ONE',wires[1]['texts']); self.assertIn('TWO',wires[2]['texts'])
        self.assertNotIn('NEXT_TASK',wires[2]['texts'])


    async def test_interrupt_stops_a_primary_input_hook_and_preserves_the_session(self):
        release=self.root/'release'
        self.write_config(PI_MOCK_BLOCK_INPUT='"BLOCK"',PI_MOCK_BLOCK_MS='"60000"',
                          PI_MOCK_RELEASE_FILE=json.dumps(str(release)))
        config=self.config_path; config.write_text(config.read_text().replace('rpcTimeoutSeconds=20','rpcTimeoutSeconds=1'))
        scope,a,path=await self.start_case('BLOCK')
        await self.wait_marker(path,'PI_MOCK_INPUT_BLOCKED_START')
        stop=await self.call('soft_interrupt',{'scope':scope,'agent_id':a['agent_id'],'request_id':'interrupt'})
        self.assertEqual((stop['runtime_retained'],stop['forced']),(False,True))
        state=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']})
        self.assertEqual((state['agent']['state'],state['agent']['cleanup']),('dormant','verified'))
        release.touch()
        self.assertNotIn('PI_MOCK_REPLY',path.read_text())
        done=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':1})
        self.assertEqual([r['state'] for r in done['runs']],['interrupted'])


    async def test_native_parent_model_and_settings_remain_unchanged(self):
        self.write_config()
        settings=self.pi_agent/'settings.json'
        settings.write_text(json.dumps({**json.loads(settings.read_text()),
            'defaultProvider':'pi-mock-offline','defaultModel':'mock',
            'compaction':{'enabled':False},'retry':{'enabled':False}}))
        before=settings.read_bytes()
        scope,a,q,done,_=await self.lifecycle()
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_1','MOCK_REPLY_2'])
        self.assertEqual(settings.read_bytes(),before)


    async def test_old_extension_timer_cannot_attach_to_the_next_task(self):
        release=self.root/'late'
        self.write_config(PI_MOCK_LATE_RELEASE=json.dumps(str(release)),PI_MOCK_STREAM_MS='"400"',PI_MOCK_CONTEXT='"1"')
        scope,a,path=await self.start_case()
        await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        second=await self.call('followup',{'scope':scope,'agent_id':a['agent_id'],
            'message':'SECOND','request_id':'second'})
        await self.wait_marker(path,'PI_MOCK_REPLY 2')
        release.touch()
        await self.wait_marker(path,'PI_MOCK_LATE_ATTEMPTED')
        done=await self.call('wait',{'scope':scope,'run_ids':[second['run_id']],'timeout_seconds':8})
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_2'])
        self.assertNotIn('STALE_TIMER_INPUT',path.read_text())
        self.assertNotIn('PI_MOCK_REPLY 3',path.read_text())


    async def test_extension_confirmation_requires_explicit_native_answer(self):
        self.write_config(PI_MOCK_CONFIRM='"1"')
        scope,a,path=await self.start_case('ASK')
        await self.wait_marker(path,'PI_MOCK_CONFIRM_WAIT')
        state=await self.call('inspect',{'scope':scope,'agent_id':a['agent_id']})
        question=state['agent']['pending_input'][0]
        self.assertEqual(question['method'],'confirm')
        self.assertNotIn('PI_MOCK_REPLY',path.read_text())
        await self.call('answer',{'scope':scope,'agent_id':a['agent_id'],
            'ui_request_id':question['id'],'answer':True,'request_id':'answer'})
        done=await self.call('wait',{'scope':scope,'run_ids':[a['run_id']],'timeout_seconds':8})
        self.assertFalse(done['timed_out'],done)
        self.assertEqual(await self.results(scope,done['runs']),['MOCK_REPLY_1'])


    def make_skill(self, base, name):
        directory = base/name
        directory.mkdir(parents=True)
        (directory/'SKILL.md').write_text(f'---\nname: {name}\ndescription: native skill {name}\n---\n\nBody.\n')
        return directory

    def write_probe_extension(self, override=()):
        # Migrated from the real resource-boundary fixture: report the SDK's
        # registry/source identity, independently of the surface evidence line.
        path = self.pi_agent/'extensions/probe.ts'
        path.parent.mkdir(parents=True, exist_ok=True)
        registered = ''.join(
            "  pi.registerTool({name:%r,label:%r,description:'override',parameters:{type:'object',properties:{}},"
            "async execute(){return {content:[{type:'text',text:'override'}]}}});\n" % (name,name)
            for name in override)
        path.write_text('export default function(pi){\n'+registered+
            "pi.on('session_start',()=>process.stderr.write('PROBE_TOOLS '+JSON.stringify({active:pi.getActiveTools(),"
            "all:pi.getAllTools().map(t=>({name:t.name,path:t.sourceInfo&&t.sourceInfo.path}))})+'\\n'));\n}\n")
        return path

    def latest_tool_probe(self, text):
        lines = [line for line in text.splitlines() if line.startswith('PROBE_TOOLS ')]
        self.assertTrue(lines,text)
        return json.loads(lines[-1].removeprefix('PROBE_TOOLS '))

    def tool_path(self, probe, name):
        return next((tool.get('path') for tool in probe['all'] if tool['name']==name), None)

    def plain_sdk_probe(self):
        # Same isolated SDK/resources, with no managed surface plan and no model
        # prompt: a real baseline for an extension overriding a builtin name.
        # Node cannot initialize its crypto provider without the OS locations;
        # they are pure paths, not credentials, and the production base-env set
        # forwards the same names to managed children.
        env = {**{k: os.environ[k] for k in WINDOWS_BASE_ENV if k in os.environ},
            'PATH':os.environ['PATH'],'HOME':str(self.pi_home),'PI_CODING_AGENT_DIR':str(self.pi_agent),
            'METIS_PI_CONFIG':str(self.config_path),'PI_OFFLINE':'1','PI_SKIP_VERSION_CHECK':'1'}
        proc = subprocess.Popen([self.node,str(WORKER_ROOT/'pi-sdk.mjs'),str(self.sdk),
            '--offline','--provider','pi-mock-offline','--model','mock'], cwd=self.workspace, env=env,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            _, stderr = proc.communicate('{"id":"probe","type":"get_state"}\n',timeout=25)
            self.assertEqual(proc.returncode,0,stderr)
            self.assertNotIn('PI_MOCK_REPLY',stderr)
            return self.latest_tool_probe(stderr)
        finally:
            if proc.poll() is None:
                proc.kill(); proc.communicate()

    async def test_client_bound_directory_wins_over_the_default_home_directory(self):
        self.make_skill(self.pi_agent/'skills','pi-only')
        self.make_skill(self.pi_home/'.pi/agent/skills','fallback-only')
        self.write_config(PI_MOCK_WIRE='"1"')
        # The trusted parent locator, not a profile/env override or HOME default,
        # selects the resource tree in a native child.
        self.source['env']['PI_CODING_AGENT_DIR'] = str(self.root/'wrong-agent')
        await self.initialize()
        a = await self.call('spawn',{'task':'native resources','access':'read','request_id':'resources'})
        await self.call('wait',{'run_ids':[a['run_id']],'timeout_seconds':8})
        text = (self.home/'agents'/a['agent_id']/'stderr.log').read_text()
        wire = json.loads(next(line.split(' ',2)[2] for line in text.splitlines() if line.startswith('PI_MOCK_WIRE ')))
        self.assertIn('pi-only',wire['forced'])
        self.assertNotIn('fallback-only',wire['forced'])

    async def test_extension_tool_shadowing_a_builtin_survives_in_both_sdks(self):
        extension = self.write_probe_extension(override=('bash',))
        self.write_config()
        baseline = await asyncio.to_thread(self.plain_sdk_probe)
        self.assertIn('bash',baseline['active'])
        self.assertEqual(self.tool_path(baseline,'bash'),str(extension))
        await self.initialize()
        a = await self.call('spawn',{'task':'source identity','access':'read','request_id':'source'})
        await self.call('wait',{'run_ids':[a['run_id']],'timeout_seconds':8})
        text = (self.home/'agents'/a['agent_id']/'stderr.log').read_text()
        probe = self.latest_tool_probe(text)
        self.assertIn('bash',probe['active'])
        self.assertEqual(self.tool_path(probe,'bash'),str(extension))
        for name in ('edit','write'):
            self.assertEqual(self.tool_path(probe,name),'builtin:'+name)
            self.assertNotIn(name,probe['active'])
        self.assertIn('metis-subagent-surface applied ok=true',text)

    async def test_reader_without_an_override_restricts_every_write_builtin(self):
        self.write_probe_extension()
        self.write_config()
        await self.initialize()
        a = await self.call('spawn',{'task':'reader surface','access':'read','request_id':'reader'})
        await self.call('wait',{'run_ids':[a['run_id']],'timeout_seconds':8})
        text = (self.home/'agents'/a['agent_id']/'stderr.log').read_text()
        probe = self.latest_tool_probe(text)
        for name in ('bash','edit','write','powershell'):
            self.assertEqual(self.tool_path(probe,name),'builtin:'+name)
            self.assertNotIn(name,probe['active'])
        for name in ('read','grep','find','ls'):
            self.assertIn(name,probe['active'])
        self.assertIn('ask_parent',probe['active'])
        self.assertIn('metis-subagent-surface applied ok=true',text)

if __name__ == '__main__' and len(sys.argv) == 4 and sys.argv[1] == '--fixture-daemon':
    asyncio.run(fixture_daemon(Path(sys.argv[2]), json.loads(sys.argv[3])))
