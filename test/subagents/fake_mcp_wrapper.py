#!/usr/bin/env python3
"""Stdio fixture: an entry wrapper that exits on TERM but leaves its child."""
import os
import signal
import subprocess
import sys
from pathlib import Path

child = subprocess.Popen([sys.executable,str(Path(__file__).with_name('fake_mcp_stdio.py'))],
                         stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr,env=os.environ.copy())
signal.signal(signal.SIGTERM,lambda _sig,_frame: sys.exit(0))
signal.pause()
