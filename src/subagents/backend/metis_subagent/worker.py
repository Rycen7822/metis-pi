"""One managed Pi child: its JSONL SDK transport and process-group
ownership. The Runtime owns state; this module owns the process-facing mechanics."""
from __future__ import annotations
import asyncio
import contextlib
from dataclasses import dataclass, field
import fcntl
import json
import os
import re
from pathlib import Path
import signal
import sys
import time

from .paths import SURFACE_EXTENSION, WORKER_DIR
from .common import (MAX_FRAME, AgentError, atomic_json, crop, dumps, group_members,
    live_identity, new_id, now, private_dir, read_frame)

RESULT_CAP = 1024 * 1024
# How long the built-in surface report may take after Pi answered get_state. The
# shipped extension writes it during session_start, so a missing report means it
# did not load or did not run; the boot then fails instead of claiming a
# built-in restriction that was never applied.
SURFACE_TIMEOUT_SECONDS = 10.0
SURFACE_PREFIX = 'metis-subagent-surface '
# Maintenance gets one finite window, at least the shipped 30-minute idle
# budget. Retries share that deadline rather than extending it.
MAINTENANCE_MIN_SECONDS = 1800.0

def message_text(message):
    content = message.get('content',[])
    if isinstance(content,str): return content
    if not isinstance(content,list): return ''
    return '\n'.join(str(p.get('text','')) for p in content if isinstance(p,dict) and p.get('type')=='text')

@dataclass
class RunProjection:
    """Task observations; Runtime decides when this projection starts and ends."""
    id: str | None = None
    last_text: str = ''
    thinking: bool = False
    error: str | None = None
    usage: dict = field(default_factory=dict)
    ui: dict = field(default_factory=dict)
    active_tools: dict = field(default_factory=dict)
    tool_uses: int = 0
    last_progress: float = field(default_factory=time.monotonic)
    cancelled: bool = False
    idle_timeout_seconds: int = 0
    # Summarization retry can be nested inside compaction; both share one window.
    maintenance_phases: set[str] = field(default_factory=set)
    maintenance_deadline: float = 0.0

    @property
    def current_tool(self):
        return next(iter(self.active_tools.values()), None)

    @property
    def maintenance(self):
        """The maintenance phase to report, or None when no window is open."""
        if "compaction" in self.maintenance_phases:
            return "compaction"
        return next(iter(self.maintenance_phases), None)

    def maintenance_window(self):
        return max(self.idle_timeout_seconds, MAINTENANCE_MIN_SECONDS)

    def observe_maintenance(self, phase, opening):
        """One deadline per window; only the last matching end restarts silence."""
        if opening:
            if not self.maintenance_phases:
                self.maintenance_deadline = time.monotonic() + self.maintenance_window()
            self.maintenance_phases.add(phase)
        elif phase in self.maintenance_phases:
            self.maintenance_phases.remove(phase)
            if not self.maintenance_phases:
                self.maintenance_deadline = 0.0
                self.last_progress = time.monotonic()

    def idle_seconds(self):
        # Tool execution, parent input and own maintenance work are owned waits,
        # not model silence. Maintenance has its own bounded watchdog.
        if not self.id or self.active_tools or self.ui or self.maintenance_phases:
            return None
        return max(0, time.monotonic() - self.last_progress)

    def watchdog(self):
        """The expired budget, or None; idle_seconds handles tool/UI exemptions."""
        if self.maintenance_phases:
            return "maintenance" if time.monotonic() >= self.maintenance_deadline else None
        idle = self.idle_seconds()
        if idle is not None and idle >= self.idle_timeout_seconds:
            return "silence"
        return None

    def finish(self):
        # Keep the settled task's output/usage for idle diagnostics, while no
        # question, active tool, cancellation flag or maintenance window can
        # carry into new work.
        self.id = None
        self.ui.clear()
        self.active_tools.clear()
        self.thinking = False
        self.cancelled = False
        self.maintenance_phases.clear()
        self.maintenance_deadline = 0.0


class Worker:
    def __init__(self, agent, proc, stderr_path, rpc_timeout, idle_timeout,
                 spawn_task, on_event, on_failure, on_exit, on_retire):
        self.agent, self.proc = agent, proc
        self.stderr_path, self.rpc_timeout = stderr_path, rpc_timeout
        self.spawn_task, self.on_event = spawn_task, on_event
        self.on_failure, self.on_exit, self.on_retire = on_failure, on_exit, on_retire
        self.generation = agent['generation']
        self.pending = {}
        self.run = RunProjection(idle_timeout_seconds=idle_timeout)
        self.transport_error = None
        self.stopping = False
        self.closed = False
        self.last_activity = now()
        self.idle_since = None
        self.events_written = 0
        self.tasks = []
        self.write_lock = asyncio.Lock()
        self.surface = None          # parsed report from worker/managed-surface.ts
        self.surface_ready = asyncio.Event()
        self.surface_buf = b''
        # Set when the host starts work no daemon run owns (see Runtime.stop_unowned):
        # the worker is being stopped and none of its output may be absorbed.
        self.tainted = None
    def start(self):
        self.tasks = [self.spawn_task(self.read_stdout()),self.spawn_task(self.read_stderr()),self.spawn_task(self.watch_exit())]
        for task in self.tasks: task.add_done_callback(self.retire)
    def retire(self, _task):
        # Exit reconciliation can await the agent lock while a replacement boots.
        # Only release this generation after every reader and callback is done.
        if self.closed and all(task.done() for task in self.tasks):
            self.on_retire(self)
    async def rpc(self, kind, timeout=None, **params):
        if self.closed or self.proc.returncode is not None:
            raise AgentError('worker_unavailable','Pi process is not connected; inspect then respawn')
        rid = new_id('rpc_')
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        try:
            timeout = timeout or self.rpc_timeout
            async with asyncio.timeout(timeout):
                await self.raw({'id':rid,'type':kind,**params},timeout=timeout)
                response = await asyncio.shield(future)
            if not response.get('success'):
                raise AgentError('pi_rejected',crop(str(response.get('error','Pi rejected the command')),2000),command=kind)
            return response.get('data') or {}
        except asyncio.TimeoutError:
            raise AgentError('rpc_timeout','Pi command outcome is uncertain; do not blindly retry',command=kind)
        finally:
            self.pending.pop(rid,None)
            if not future.done(): future.cancel()
    async def raw(self, value, timeout=None):
        try:
            async with asyncio.timeout(timeout or self.rpc_timeout):
                async with self.write_lock:
                    # A timed-out write may still be buffered. Drain it before
                    # accepting more bytes so repeated timeouts cannot grow RAM.
                    await self.proc.stdin.drain()
                    self.proc.stdin.write((dumps(value)+'\n').encode()); await self.proc.stdin.drain()
        except asyncio.TimeoutError:
            raise AgentError('rpc_timeout','Pi command outcome is uncertain; do not blindly retry',command=value.get('type'))
        except (BrokenPipeError, ConnectionResetError):
            raise AgentError('worker_unavailable','Pi RPC channel closed')
    async def read_stdout(self):
        try:
            while True:
                try: e = await read_frame(self.proc.stdout)
                except json.JSONDecodeError:
                    self.on_event(self,{'type':'protocol_warning','message':'Non-JSON stdout line omitted'})
                    continue
                if e is None: break
                if not isinstance(e,dict): continue
                if e.get('type') == 'response':
                    f = self.pending.get(e.get('id'))
                    if f and not f.done(): f.set_result(e)
                else:
                    self.on_event(self,e)
        except asyncio.CancelledError: raise
        except Exception as exc:
            self.transport_error = f'RPC reader failed: {type(exc).__name__}: {exc}'
            with contextlib.suppress(Exception): self.on_event(self,{'type':'protocol_error','message':crop(self.transport_error,1000)})
            self.spawn_task(self.on_failure(self,self.transport_error))
    async def read_stderr(self):
        with self.stderr_path.open('ab') as f:
            total = f.tell()
            while True:
                chunk = await self.proc.stderr.read(4096)
                if not chunk: break
                if total < 512*1024:
                    data = chunk[:512*1024-total]; f.write(data); f.flush(); total += len(data)
                self.note_surface(chunk)
    def note_surface(self, chunk):
        """Collect the built-in surface report the shipped extension writes after
        reading Pi's live registry back. Only lines the daemon asked for (a
        profile that restricts the built-in surface) are meaningful; a no-plan
        line means the extension had nothing to apply."""
        parts = (self.surface_buf + chunk).split(b'\n')
        self.surface_buf = parts.pop()[-4096:]
        for raw in parts:
            line = raw.decode('utf-8','replace')
            if not line.startswith(SURFACE_PREFIX): continue
            words = line.split()
            if words[1:2] != ['applied']: continue
            self.surface = parse_surface_line(line)
            self.surface_ready.set()
    async def watch_exit(self):
        # asyncio.Process.wait() also waits for pipe EOF. A Pi descendant can
        # inherit stdout/stderr after the guard exits, so observe the reaped
        # leader directly and bound the final event drain.
        while self.proc.returncode is None:
            await asyncio.sleep(.05)
        code = self.proc.returncode
        readers = self.tasks[:2]
        _, pending = await asyncio.wait(readers,timeout=2)
        for task in pending: task.cancel()
        await asyncio.gather(*pending,return_exceptions=True)
        # Cancelling a StreamReader task alone leaves its pipe transport open.
        # No descendant may keep a retired Worker resident through that FD.
        for fd in (1,2):
            pipe = self.proc._transport.get_pipe_transport(fd)
            if pipe: pipe.close()
        for future in list(self.pending.values()):
            if not future.done(): future.set_exception(AgentError('worker_exited',f'Pi guard exited ({code})'))
        # A dead process is not yet available for replacement: finish its runs
        # and queue under the agent lock before publishing this handoff flag.
        await self.on_exit(self,code)
        self.closed = True

def parse_surface_line(text):
    """Parse one `metis-subagent-surface applied ...` evidence line into fields."""
    fields = {}
    for part in text.split()[2:]:
        key,_,value = part.partition('=')
        fields[key] = value
    fields['ok'] = fields.get('ok') == 'true'
    return fields

async def surface_report(w, timeout=SURFACE_TIMEOUT_SECONDS):
    """Wait for Pi's built-in surface report before a restricted profile boots.

    The applied set is read back from Pi's live registry inside the child, so the
    daemon learns whether the profile's built-in surface really took effect (and
    which built-ins the child ended up with) instead of trusting argv. A missing
    or not-ok report fails the launch: a read-only worker is never handed a
    write-capable built-in that this plugin could not confirm it removed."""
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(w.surface_ready.wait(), timeout)
    return w.surface


def check_surface(report):
    if report is None:
        raise AgentError(
            "tool_surface_unavailable",
            "Managed Pi never reported its built-in tool surface; check that the shipped extension loads (see the agent stderr log)",
        )
    if not report["ok"]:
        raise AgentError(
            "tool_surface_unapplied",
            (
                "Managed Pi did not apply the profile's built-in tool surface (applied="
                f"{report.get('builtins', '')}"
                " expected="
                f"{report.get('expected', '')}"
                ")"
            ),
        )


def managed_command(argv, sdk_path=None):
    """Locate the SDK beside the chosen Pi executable; never edit that install.

    Admit exactly the supported stable SDK release (1.4.0), matching the exact npm
    peer range: older releases lack the event and hook contracts this build uses,
    prereleases are not supported, and future majors are not admitted implicitly.
    Build metadata is tolerated because it does not change the release.
    Explicit non-Pi commands are protocol implementations (principally the offline
    fake in tests). Boot verifies the plugin protocol before accepting either.
    """
    if sdk_path:
        sdk=Path(sdk_path)
        try: package=json.loads((sdk.parent.parent/'package.json').read_text())
        except (OSError,ValueError): raise AgentError('sdk_unavailable','The parent Pi SDK is unavailable') from None
        version=package.get('version','') if isinstance(package,dict) else None
        supported=isinstance(version,str) and re.fullmatch(r'1\.4\.0(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?',version)
        if not supported or package.get('name')!='@earendil-works/pi-coding-agent':
            raise AgentError('unsupported_pi_version','Native Pi subagents require exactly the host SDK 1.4.0')
        if not sdk.is_file() or not Path(argv[0]).is_file() or not os.access(argv[0],os.X_OK):
            raise AgentError('sdk_unavailable','Parent SDK and Node executable must still exist')
        return [argv[0],str(WORKER_DIR/'pi-sdk.mjs'),str(sdk),*argv[2:]]
    return argv

def session_argv(home, a, spec):
    directory=home/'agents'/a['id']
    private_dir(directory)
    session=Path(a['session_file'])
    if session.is_symlink(): raise AgentError('unsafe_session','Managed session path must not be a symlink')
    if a['generation'] and (not session.exists() or session.stat().st_size==0):
        raise AgentError('session_unavailable','Previous Pi session is missing or empty; use subagents_spawn_agent to create a new agent explicitly')
    argv=list(spec['argv'])
    if spec.get('surface'):
        # launch_spec owns the first extension slot. Rebind only that asset when
        # resuming saved argv after package moves; never rewrite profile paths.
        try:
            argv[argv.index('--extension')+1]=str(SURFACE_EXTENSION)
        except (ValueError, IndexError):
            raise AgentError('invalid_config','Managed launch is missing its built-in surface extension') from None
    if not a['generation']:
        private_dir(directory/'sessions')
        argv += ['--session-dir',str(directory/'sessions')]
    else: argv += ['--session',str(session)]
    return directory,argv

def write_launch(directory, spec, argv, generation):
    atomic_json(directory/'launch.json',{**spec,'argv':managed_command(argv,spec.get('sdk_path')),'generation':generation})

async def start_guard(directory, spec, guard_env, before_spawn):
    before_spawn()
    return await asyncio.create_subprocess_exec(sys.executable,str(Path(__file__).with_name('worker_guard.py')),
        str(directory/'launch.json'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,start_new_session=True,limit=MAX_FRAME,cwd=spec['cwd'],env=guard_env)

def ownership(directory: Path, a, *, descendants_confirmed=False) -> dict:
    """The one owner-record verdict for reaping, reconciliation and terminate:
    'gone' | 'live' | 'unknown'. A missing or unreadable record proves nothing
    about the old writer, so only a positively dead leader with no surviving
    process group is gone, and only positively matched identities are live."""
    try:
        record = json.loads((directory / "owner.json").read_text())
    except FileNotFoundError:
        record = None
    except (ValueError, OSError):
        record = {"spawning": True}
    if record is None:
        if not a.get("pid"):
            if a.get("cleanup") != "pending":
                return {"status": "gone", "reason": "No child was ever launched for this agent", "record": None}
            return {
                "status": "unknown",
                "reason": "Owner record missing and the launch may have forked; manual process inspection required",
                "record": None,
            }
        if live_identity(a["pid"], a.get("identity")) is False and not group_members(a["pid"]):
            return {"status": "gone", "reason": "Verified leader is dead and no process group remains", "record": None}
        return {
            "status": "unknown",
            "reason": "Owner record missing; manual process inspection required",
            "record": None,
        }
    matches = {k: live_identity(record.get(k + "_pid"), record.get(k + "_identity")) for k in ("guard", "pi")}
    if record.get("spawning") or any(v is None for v in matches.values()):
        return {"status": "unknown", "reason": "Cannot safely prove orphan process identity", "record": record}
    if any(matches.values()):
        return {"status": "live", "reason": "A verified session owner is still running", "record": record}
    if record.get("guard_pid") and group_members(record["guard_pid"]):
        return {
            "status": "unknown",
            "reason": "A process group remains but its leaders cannot be verified; manual inspection required",
            "record": record,
        }
    if not descendants_confirmed and record.get("descendants_cleanup", "verified") != "verified":
        return {
            "status": "unknown",
            "reason": "Guard exited without confirming descendant cleanup; manual inspection required",
            "record": record,
        }
    return {"status": "gone", "reason": "Verified leaders are dead and no process group remains", "record": record}


async def stop_group(pgid, graceful_guard=False):
    """Signal and verify a group whose ownership the caller has already proved."""
    for sig, wait in ((signal.SIGTERM, 1.5), (signal.SIGKILL, 1.0)):
        if not await asyncio.to_thread(group_members, pgid):
            break
        # A current guard forwards TERM and reaps tools; avoid sending Pi a
        # duplicate signal while its once-only shutdown handler is disposing.
        with contextlib.suppress(ProcessLookupError):
            if graceful_guard and sig == signal.SIGTERM:
                os.kill(pgid, signal.SIGCONT)
            (os.kill if graceful_guard and sig == signal.SIGTERM else os.killpg)(pgid, sig)
        until = time.monotonic() + wait
        while time.monotonic() < until and await asyncio.to_thread(group_members, pgid):
            await asyncio.sleep(0.025)
    return "unknown" if await asyncio.to_thread(group_members, pgid) else "verified"


async def stop_owned_process(directory, agent, proc):
    """A just-spawned guard still needs identity proof before group signalling."""
    pgid = proc.pid
    owned = live_identity(pgid, agent.get("identity")) is True
    if not owned:
        owned = ownership(directory, agent)["status"] == "live"
    if not owned and group_members(pgid):
        return "unknown", False
    record = ownership(directory, agent)["record"] or {}
    guarded = (
        record.get("guard_pid") == pgid
        and "descendants_cleanup" in record
        and live_identity(pgid, record.get("guard_identity")) is True
    )
    cleanup = await stop_group(pgid, graceful_guard=guarded)
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(proc.wait(), 2)
    if cleanup == "verified" and ownership(directory, agent)["status"] != "gone":
        cleanup = "unknown"
    return cleanup, True


async def terminate(directory, w):
    w.stopping = True
    cleanup, attempted = await stop_owned_process(directory, w.agent, w.proc)
    if attempted:
        w.closed = True
    return cleanup


def confirm_cleanup(directory, a, generation):
    """Record an operator's descendant inspection for exactly one dead owner."""
    if generation != a["generation"]:
        raise AgentError(
            "ownership_unknown", "Cleanup confirmation belongs to a different generation; inspect the current owner"
        )
    fd = os.open(directory / "session.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AgentError("ownership_unknown", "Session lease is still owned; cleanup cannot be confirmed")
        verdict = ownership(directory, a, descendants_confirmed=True)
        record = verdict["record"]
        if verdict["status"] != "gone" or not record or record.get("generation") != generation:
            raise AgentError(
                "ownership_unknown",
                "Current owner must be identified and dead, with no original process group, before confirming inspected descendants",
            )
        atomic_json(
            directory / "owner.json",
            {
                **record,
                "descendants_cleanup": "verified",
                "cleanup_confirmation": {"generation": generation, "by": "operator", "at": time.time()},
            },
        )
    finally:
        os.close(fd)
    return "verified"


async def reap_orphan(directory, a):
    verdict = ownership(directory, a)
    if verdict["status"] == "gone":
        return "verified"
    if verdict["status"] == "unknown":
        raise AgentError("ownership_unknown", verdict["reason"])
    pgid = verdict["record"].get("guard_pid")
    if not pgid:
        raise AgentError("ownership_unknown", "No verified process group")
    record = verdict["record"]
    guarded = "descendants_cleanup" in record and live_identity(pgid, record.get("guard_identity")) is True
    cleanup = await stop_group(pgid, graceful_guard=guarded)
    return cleanup if ownership(directory, a)["status"] == "gone" else "unknown"
