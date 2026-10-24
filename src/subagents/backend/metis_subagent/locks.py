"""One non-blocking exclusive file lease (daemon start gate, session lease).

POSIX uses flock; Windows locks one byte with msvcrt, which gives the same
exclusive/non-blocking/unlock contract without opening a second owner channel.
"""
from __future__ import annotations

import sys

if sys.platform == "win32":
    import msvcrt
    import os

    def try_lock(fd):
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def unlock(fd):
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def try_lock(fd):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False

    def unlock(fd):
        fcntl.flock(fd, fcntl.LOCK_UN)
