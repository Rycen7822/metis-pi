from __future__ import annotations
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time
import uuid

MAX_FRAME = 8 * 1024 * 1024
DEFAULT_WAIT_SECONDS = 600
MAX_WAIT_SECONDS = 3_600
TEXT_MAX_BYTES = 65_536
LABEL_MAX_CHARS = 128
# The final lookahead requires absolute end in both Python and JSON Schema regexes.
IDENTIFIER_PATTERN = r'^[A-Za-z0-9_.:-]+(?![\s\S])'
# Agent states in which a worker may still hold processes or work behind it; the
# workspace exclusion and crash reconciliation both use exactly this set.
RESIDENT_AGENT_STATES = ('starting', 'running', 'needs_input', 'idle', 'stopping', 'orphaned')
TERMINAL = {"completed", "failed", "interrupted", "crashed", "cancelled", "timed_out"}
# Canonical base environment for a managed worker: enough to find an interpreter,
# a home, a locale and its own Pi configuration directory, and nothing that
# carries credentials. PI_CODING_AGENT_DIR is a non-secret LOCATION the child Pi
# resolves itself (like HOME), so it is forwarded; CODEX_HOME is captured by the
# scope snapshot too but stays out of this set because the daemon resolves that
# source itself. The scope snapshot captures these plus CODEX_HOME.
BASE_ENV_KEYS = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'USER',
                 'LOGNAME', 'PI_CODING_AGENT_DIR')

class AgentError(Exception):
    def __init__(self, code: str, message: str, **details):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details
    def as_dict(self):
        return {"code": self.code, "message": self.message, **self.details}

async def close_writer(writer):
    """Flush a one-shot IPC connection briefly, then release it even on cancel."""
    try:
        with contextlib.suppress(OSError,TimeoutError):
            writer.close()
            async with asyncio.timeout(1): await writer.wait_closed()
    finally:
        writer.transport.abort()

def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def now() -> float:
    return time.time()

def new_id(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:20]

def text(value, field="message", maximum=TEXT_MAX_BYTES) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise AgentError("invalid_argument", f"{field} must be nonempty text without NUL")
    if len(value.encode("utf-8")) > maximum:
        raise AgentError("invalid_argument", f"{field} exceeds {maximum} UTF-8 bytes")
    return value

def label(value, field='name') -> str:
    value = text(value, field, LABEL_MAX_CHARS * 4)
    if len(value) > LABEL_MAX_CHARS:
        raise AgentError('invalid_argument', f'{field} exceeds {LABEL_MAX_CHARS} characters')
    return value

def identifier(value, field="id") -> str:
    value = text(value, field, LABEL_MAX_CHARS)
    if not re.fullmatch(IDENTIFIER_PATTERN, value):
        raise AgentError("invalid_argument", f"Invalid {field}")
    return value

def integer(value, field, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise AgentError("invalid_argument", f"{field} must be an integer in [{low}, {high}]")
    return value

def crop(value: str, limit: int) -> str:
    raw = value.encode("utf-8")
    return raw[:limit].decode("utf-8", "ignore")

def bounded(value, budget=4096):
    """Bound public events; never repeatedly serialize Pi's growing partial object."""
    if isinstance(value, str):
        return crop(value, budget)
    if isinstance(value, dict):
        out = {}
        remaining = budget
        for k, v in value.items():
            if k in {"partial", "thinking", "thinkingSignature", "signature"}:
                continue
            if remaining < 80:
                out["_truncated"] = True
                break
            item = bounded(v, min(remaining, 2048))
            out[str(k)] = item
            remaining -= len(dumps({str(k): item}).encode())
        return out
    if isinstance(value, list):
        out = []
        for v in value[:12]:
            item = bounded(v, max(80, budget // min(len(value), 12)))
            out.append(item)
        if len(value) > 12:
            out.append({"_omitted": len(value)-12})
        return out
    return value

def private_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid():
        raise AgentError("unsafe_path", f"Not an owned directory: {path}")
    os.chmod(path, 0o700)

def atomic_write(path: Path, data: bytes):
    private_dir(path.parent)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)

def atomic_json(path: Path, value):
    atomic_write(path, dumps(value).encode())

def state_home() -> Path:
    return Path(os.environ.get("PI_AGENTS_HOME", str(Path(os.environ.get("XDG_STATE_HOME", Path.home()/".local/state"))/"subagent-pi"))).expanduser().resolve()

def socket_path(home: Path) -> Path:
    """Use a short private runtime path; AF_UNIX addresses have a small limit."""
    base = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / f"subagent-pi-{os.getuid()}"
    private_dir(base)
    return base / (hashlib.sha256(str(home).encode()).hexdigest()[:20] + ".sock")

def check_peer(writer):
    sock = writer.get_extra_info("socket")
    if hasattr(socket, "SO_PEERCRED"):
        _, uid, _ = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid():
            raise AgentError("permission_denied", "IPC peer belongs to another user")

def process_identity(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        rest = raw[raw.rfind(")")+2:].split()
        if rest[0] == "Z": return None
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return boot + ":" + rest[19]
    except (FileNotFoundError, ProcessLookupError):
        return None
    except (OSError, IndexError):
        return "unknown"

def live_identity(pid, identity) -> bool | None:
    if not pid: return False
    current = process_identity(int(pid))
    if current is None: return False
    if current == "unknown" or not identity: return None
    return current == identity

def group_members(pgid: int):
    found = []
    for item in Path("/proc").iterdir():
        if not item.name.isdigit(): continue
        try:
            if item.stat().st_uid != os.getuid(): continue
            raw = (item / "stat").read_text()
            fields = raw[raw.rfind(")")+2:].split()
            if fields[0] != "Z" and int(fields[2]) == pgid:
                found.append(int(item.name))
        except (OSError, ValueError, IndexError):
            continue
    return found

async def read_frame(reader):
    try: line = await reader.readline()
    except (ValueError, asyncio.LimitOverrunError):
        raise AgentError("frame_too_large", "JSONL record exceeds transport limit")
    if not line: return None
    if len(line) > MAX_FRAME:
        raise AgentError("frame_too_large", "JSONL record exceeds transport limit")
    return json.loads(line)
