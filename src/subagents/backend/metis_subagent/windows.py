"""Narrow Windows OS boundary for the managed runtime.

Everything the POSIX modules get from the kernel is expressed once here:
a process identity that survives PID reuse, an owned job object that holds
every descendant, a private directory DACL, durable file replacement and the byte-mode local IPC
pipe.

No policy lives here: the daemon/guard still own state transitions.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes, get_last_error as _last_error
import os
from pathlib import Path
import time
import uuid

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TokenUser = 1
TokenOwner = 4

ERROR_FILE_NOT_FOUND = 2
ERROR_PATH_NOT_FOUND = 3
ERROR_INVALID_PARAMETER = 87
ERROR_ALREADY_EXISTS = 183
ERROR_PIPE_BUSY = 231
ERROR_MORE_DATA = 234

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JobObjectExtendedLimitInformation = 9
JobObjectBasicProcessIdList = 3
JOB_OBJECT_QUERY = 0x0004
JOB_OBJECT_TERMINATE = 0x0008

FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF

SE_FILE_OBJECT = 1
OWNER_SECURITY_INFORMATION = 1
DACL_SECURITY_INFORMATION = 4
PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
SDDL_REVISION = 1

PIPE_ACCESS_DUPLEX = 0x00000003
FILE_FLAG_OVERLAPPED = 0x40000000
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
PIPE_TYPE_BYTE = 0
PIPE_READMODE_BYTE = 0
PIPE_WAIT = 0
PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
PIPE_UNLIMITED_INSTANCES = 255
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
# A client connects with SECURITY_IDENTIFICATION, so a rogue server can identify
# it but never impersonate it or act with its credentials.
SECURITY_SQOS_PRESENT = 0x00100000
SECURITY_IDENTIFICATION = 0x00010000
_CLIENT_FLAGS = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION


class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", wintypes.BOOL),
    ]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]


def _prototype(function, restype, argtypes):
    function.restype, function.argtypes = restype, argtypes


_prototype(kernel32.OpenProcess, wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD])
_prototype(kernel32.CloseHandle, wintypes.BOOL, [wintypes.HANDLE])
_prototype(kernel32.GetCurrentProcess, wintypes.HANDLE, [])
_prototype(kernel32.GetProcessTimes, wintypes.BOOL, [wintypes.HANDLE] + [ctypes.POINTER(FILETIME)] * 4)
_prototype(kernel32.WaitForSingleObject, wintypes.DWORD, [wintypes.HANDLE, wintypes.DWORD])
_prototype(kernel32.CreateJobObjectW, wintypes.HANDLE, [ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.LPCWSTR])
_prototype(kernel32.OpenJobObjectW, wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR])
_prototype(kernel32.AssignProcessToJobObject, wintypes.BOOL, [wintypes.HANDLE, wintypes.HANDLE])
_prototype(kernel32.TerminateJobObject, wintypes.BOOL, [wintypes.HANDLE, wintypes.UINT])
_prototype(kernel32.QueryInformationJobObject, wintypes.BOOL,
           [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)])
_prototype(kernel32.SetInformationJobObject, wintypes.BOOL,
           [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD])
_prototype(kernel32.GetFileAttributesW, wintypes.DWORD, [wintypes.LPCWSTR])
_prototype(kernel32.CreateDirectoryW, wintypes.BOOL, [wintypes.LPCWSTR, ctypes.POINTER(SECURITY_ATTRIBUTES)])
_prototype(kernel32.CreateNamedPipeW, wintypes.HANDLE,
           [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
            wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(SECURITY_ATTRIBUTES)])
_prototype(kernel32.CreateFileW, wintypes.HANDLE,
           [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
            wintypes.DWORD, wintypes.HANDLE])
_prototype(kernel32.WaitNamedPipeW, wintypes.BOOL, [wintypes.LPCWSTR, wintypes.DWORD])
_prototype(kernel32.GetNamedPipeClientProcessId, wintypes.BOOL, [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)])
_prototype(kernel32.GetNamedPipeServerProcessId, wintypes.BOOL, [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)])
_prototype(advapi32.OpenProcessToken, wintypes.BOOL,
           [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)])
_prototype(advapi32.GetTokenInformation, wintypes.BOOL,
           [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)])
_prototype(advapi32.ConvertSidToStringSidW, wintypes.BOOL, [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)])
_prototype(advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW, wintypes.BOOL,
           [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD)])
_prototype(advapi32.GetSecurityDescriptorDacl, wintypes.BOOL,
           [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(wintypes.BOOL)])
_prototype(advapi32.GetNamedSecurityInfoW, wintypes.DWORD,
           [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p)])
_prototype(advapi32.SetNamedSecurityInfoW, wintypes.DWORD,
           [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_void_p])
_prototype(kernel32.LocalFree, wintypes.HANDLE, [wintypes.HANDLE])


class JobUnavailable(Exception):
    """The named job exists but its members cannot be read or terminated."""


def _valid(handle):
    return bool(handle) and handle != INVALID_HANDLE_VALUE


def _agent_error(code, message):
    from .common import AgentError

    return AgentError(code, message)


def raw_handle(handle):
    """Accept a ctypes HANDLE, a raw integer or a proactor PipeHandle."""
    if hasattr(handle, "fileno"):
        return wintypes.HANDLE(handle.fileno())
    return handle if isinstance(handle, wintypes.HANDLE) else wintypes.HANDLE(handle)


# --- Process identity ---------------------------------------------------------

def _open_process(pid, access=SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION):
    handle = kernel32.OpenProcess(access, False, int(pid))
    if handle:
        return handle
    error = _last_error()
    if error in (ERROR_INVALID_PARAMETER, ERROR_FILE_NOT_FOUND):
        return None
    raise OSError(0, f"Cannot open process {pid}", None, error)


def _creation_time(handle):
    created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
    if not kernel32.GetProcessTimes(raw_handle(handle), created, exited, kernel, user):
        return None
    return (created.dwHighDateTime << 32) | created.dwLowDateTime


def _exited(handle):
    """Liveness from the kernel signal, never from the exit-code sentinel."""
    return kernel32.WaitForSingleObject(raw_handle(handle), 0) == 0


def process_identity(pid):
    """Creation stamp: the real identity across PID reuse; None when no process."""
    if not pid:
        return None
    handle = _open_process(pid)
    if handle is None:
        return None
    try:
        return None if _exited(handle) else handle_identity(handle)
    finally:
        kernel32.CloseHandle(handle)


def handle_identity(handle):
    """Creation identity stays readable after exit while this handle is held."""
    if not handle:
        return None
    created = _creation_time(handle)
    return f"win:{created:016x}" if created else "unknown"


# --- Token SIDs ---------------------------------------------------------------

def _sid_string(sid):
    text = ctypes.c_wchar_p()
    if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        raise OSError(0, "Cannot format SID", None, _last_error())
    try:
        return text.value
    finally:
        kernel32.LocalFree(text)


def _token_sid(handle_process, kind):
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(raw_handle(handle_process), TOKEN_QUERY, ctypes.byref(token)):
        raise OSError(0, "Cannot open process token", None, _last_error())
    try:
        size = wintypes.DWORD(0)
        advapi32.GetTokenInformation(token, kind, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(max(size.value, 1))
        if not advapi32.GetTokenInformation(token, kind, buffer, len(buffer), ctypes.byref(size)):
            raise OSError(0, "Cannot read token information", None, _last_error())
        return _sid_string(ctypes.cast(buffer, ctypes.POINTER(SID_AND_ATTRIBUTES)).contents.Sid)
    finally:
        kernel32.CloseHandle(token)


def current_sids():
    """(token user, token owner): an elevated token may own files as Administrators."""
    process = kernel32.GetCurrentProcess()
    return _token_sid(process, TokenUser), _token_sid(process, TokenOwner)


def current_user_sid():
    return current_sids()[0]


def process_sid(pid):
    handle = _open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    if handle is None:
        raise ProcessLookupError(pid)
    try:
        return _token_sid(handle, TokenUser)
    finally:
        kernel32.CloseHandle(handle)


def owned_path_sid(path):
    """Owner SID of an existing file object, or None when it does not exist."""
    sid, descriptor = ctypes.c_void_p(), ctypes.c_void_p()
    status = advapi32.GetNamedSecurityInfoW(
        str(path), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, ctypes.byref(sid), None, None, None,
        ctypes.byref(descriptor),
    )
    if status in (ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND):
        return None
    if status:
        raise OSError(0, f"Cannot read owner of {path}", None, status)
    try:
        return _sid_string(sid)
    finally:
        kernel32.LocalFree(descriptor)


def _sddl_descriptor(sddl):
    """Self-relative descriptor from SDDL plus the allocations that own it."""
    descriptor = ctypes.c_void_p()
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, SDDL_REVISION, ctypes.byref(descriptor), None
    ):
        raise OSError(0, "Cannot build a security descriptor", None, _last_error())
    return descriptor


def _descriptor_dacl(descriptor):
    """The DACL inside a self-relative descriptor (SetNamedSecurityInfoW wants an
    ACL pointer, never the descriptor itself). The descriptor must stay alive."""
    present = wintypes.BOOL()
    dacl = ctypes.c_void_p()
    defaulted = wintypes.BOOL()
    if not advapi32.GetSecurityDescriptorDacl(
        descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)
    ) or not present.value:
        raise OSError(0, "Descriptor carries no DACL", None, _last_error())
    return dacl


def _private_sddl():
    """Only this user and SYSTEM, inherited by every child object."""
    user, _ = current_sids()
    return f"D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;{user})"


def private_security_attributes():
    """SECURITY_ATTRIBUTES for kernel objects only this user (and SYSTEM) can open."""
    descriptor = _sddl_descriptor(_private_sddl())
    attributes = SECURITY_ATTRIBUTES(
        nLength=ctypes.sizeof(SECURITY_ATTRIBUTES),
        lpSecurityDescriptor=descriptor,
        bInheritHandle=False,
    )
    return attributes, descriptor


# --- Files --------------------------------------------------------------------

def _create_private_directory(path):
    """Create ONE new directory with its final DACL already in place.

    path.mkdir() would first create an inheriting directory and only then let us
    rewrite the DACL, leaving a window in a shared writable parent. Also returns
    False when the directory already existed (that case must not be adopted).
    """
    attributes, descriptor = private_security_attributes()
    try:
        if kernel32.CreateDirectoryW(str(path), ctypes.byref(attributes)):
            return True
        error = _last_error()
    finally:
        kernel32.LocalFree(descriptor)
    if error == ERROR_ALREADY_EXISTS:
        return False
    raise _agent_error("unsafe_path", f"Cannot create private directory: {path}")


def private_dir(path: Path):
    """Own this directory privately: only this user (and SYSTEM) may access it.

    Missing directories are created atomically with that DACL. Existing ones are
    verified (owner, not a reparse point) and re-hardened, but an existing parent
    is never replaced or widened: only our own state tree is touched.
    """
    path = Path(path)
    missing = []
    current = path
    while owned_path_sid(current) is None:
        missing.append(current)
        parent = current.parent
        if parent == current:
            break
        current = parent
    for directory in reversed(missing):
        if not _create_private_directory(directory):
            break
    attributes = kernel32.GetFileAttributesW(str(path))
    if attributes == INVALID_FILE_ATTRIBUTES:
        raise _agent_error("unsafe_path", f"Cannot inspect directory: {path}")
    if not attributes & FILE_ATTRIBUTE_DIRECTORY:
        raise _agent_error("unsafe_path", f"Not a directory: {path}")
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT:
        raise _agent_error("unsafe_path", f"Directory must not be a reparse point: {path}")
    try:
        owner = owned_path_sid(path)
    except OSError as exc:
        raise _agent_error("unsafe_path", f"Cannot verify directory owner: {path}") from exc
    if owner not in set(current_sids()):
        raise _agent_error("unsafe_path", f"Not an owned directory: {path}")
    descriptor = _sddl_descriptor(_private_sddl())
    try:
        status = advapi32.SetNamedSecurityInfoW(
            str(path), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None, None, _descriptor_dacl(descriptor), None,
        )
    finally:
        kernel32.LocalFree(descriptor)
    if status:
        raise _agent_error("unsafe_path", f"Cannot protect directory: {path}")


def atomic_write(path: Path, data: bytes):
    """Replace a file durably. Windows has no directory fsync and may transiently
    refuse the rename; only that sharing violation is retried."""
    path = Path(path)
    private_dir(path.parent)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_BINARY, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        for attempt in range(40):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.025)
    finally:
        tmp.unlink(missing_ok=True)


# --- Job object ---------------------------------------------------------------

def job_name(pid):
    """Deterministic: the daemon resolves a guard's job from its PID alone."""
    return f"metis-subagent.{current_user_sid()}.{int(pid)}"


def create_job(pid):
    """Create this guard's job, join it and prove the membership before use.

    Descendants inherit the job and may not break away (no limit flag permits
    it), so KILL_ON_JOB_CLOSE is a real backstop. An existing name is refused:
    the object is never shared with another owner.
    """
    name = job_name(pid)
    attributes, descriptor = private_security_attributes()
    handle = kernel32.CreateJobObjectW(ctypes.byref(attributes), name)
    error = _last_error()
    kernel32.LocalFree(descriptor)
    if not handle:
        raise OSError(0, "Cannot create managed child job", None, error)
    if error == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        raise RuntimeError(f"Managed child job already exists: {name}")
    try:
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            handle, JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            raise OSError(0, "Cannot configure managed child job", None, _last_error())
        if not kernel32.AssignProcessToJobObject(handle, kernel32.GetCurrentProcess()):
            raise OSError(0, "Cannot join the managed child job", None, _last_error())
        if os.getpid() not in _members(handle):
            raise RuntimeError("Managed child job does not contain its own guard")
        return handle
    except BaseException:
        kernel32.CloseHandle(handle)
        raise


def _members(handle):
    size = 16 + 8 * 4096
    while True:
        buffer = ctypes.create_string_buffer(size)
        written = wintypes.DWORD(0)
        if kernel32.QueryInformationJobObject(
            raw_handle(handle), JobObjectBasicProcessIdList, buffer, size, ctypes.byref(written)
        ):
            count = min(wintypes.DWORD.from_buffer(buffer, 4).value, 4096)
            return [int(pid) for pid in (ctypes.c_size_t * count).from_buffer(buffer, 8)]
        error = _last_error()
        if error == ERROR_MORE_DATA:
            size *= 2
            continue
        raise OSError(0, "Cannot read managed child job membership", None, error)


def _open_job(pid):
    handle = kernel32.OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, False, job_name(pid))
    if handle:
        return handle
    error = _last_error()
    if error == ERROR_FILE_NOT_FOUND:
        return None
    raise JobUnavailable(f"Cannot open managed child job: {error}")


def job_members(pid):
    """Members of the job named for this guard PID.

    [] means the job does not exist, so no member can have survived. A job that
    exists but cannot be read raises instead of being reported as empty.
    """
    handle = _open_job(pid)
    if handle is None:
        return []
    try:
        return _members(handle)
    finally:
        kernel32.CloseHandle(handle)


def terminate_job(pid, exit_code):
    """Terminate every member of a job whose owner identity the caller proved."""
    handle = _open_job(pid)
    if handle is None:
        return False
    try:
        if not kernel32.TerminateJobObject(handle, int(exit_code) & 0xFFFFFFFF):
            error = _last_error()
            raise JobUnavailable(f"Cannot terminate managed child job: {error}")
        return True
    finally:
        kernel32.CloseHandle(handle)


# --- Local IPC pipe -----------------------------------------------------------

def pipe_handle(raw):
    """The handle type the Windows proactor can register and close itself."""
    from asyncio import windows_utils

    return windows_utils.PipeHandle(raw)


def create_pipe_instance(name, first):
    """One server instance of a private byte-mode pipe, overlapped for the proactor."""
    flags = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED
    if first:
        flags |= FILE_FLAG_FIRST_PIPE_INSTANCE
    attributes, descriptor = private_security_attributes()
    handle = kernel32.CreateNamedPipeW(
        name, flags, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_UNLIMITED_INSTANCES, 64 * 1024, 64 * 1024, 0, ctypes.byref(attributes),
    )
    error = _last_error()
    kernel32.LocalFree(descriptor)
    if not _valid(handle):
        raise OSError(0, f"Cannot create IPC pipe {name}", None, error)
    return pipe_handle(handle)


def pipe_exists(name):
    """WaitNamedPipe(0) observes an instance without consuming a connection."""
    if kernel32.WaitNamedPipeW(name, 0):
        return True
    return _last_error() != ERROR_FILE_NOT_FOUND


def connect_pipe(name):
    """Client handle for one private byte-mode pipe."""
    def attempt():
        handle = kernel32.CreateFileW(
            name, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, _CLIENT_FLAGS, None
        )
        return handle if _valid(handle) else None

    deadline = time.monotonic() + 5
    while True:
        handle = attempt()
        if handle is not None:
            return pipe_handle(handle)
        error = _last_error()
        remaining = int((deadline - time.monotonic()) * 1000)
        if error == ERROR_PIPE_BUSY and remaining > 0:
            # WaitNamedPipe signals availability, but does not reserve an instance.
            kernel32.WaitNamedPipeW(name, remaining)
            continue
        if error in (ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER):
            raise FileNotFoundError(2, "No daemon is listening", name)
        raise OSError(0, f"Cannot connect to IPC pipe {name}", None, error)


def _pipe_pid(handle, client):
    pid = wintypes.ULONG(0)
    query = kernel32.GetNamedPipeClientProcessId if client else kernel32.GetNamedPipeServerProcessId
    if not query(raw_handle(handle), ctypes.byref(pid)):
        return None
    return int(pid.value) or None


def named_pipe_client_pid(handle):
    return _pipe_pid(handle, True)


def named_pipe_server_pid(handle):
    return _pipe_pid(handle, False)
