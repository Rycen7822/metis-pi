"""Packaged code locations only; never infer or discover user state here."""
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = MODULE_DIR.parent
SUBAGENTS_DIR = BACKEND_DIR.parent
PACKAGE_DIR = SUBAGENTS_DIR.parent.parent
WORKER_DIR = SUBAGENTS_DIR / "worker"
SURFACE_EXTENSION = WORKER_DIR / "managed-surface.ts"
ENTRYPOINT = BACKEND_DIR / "main.py"
