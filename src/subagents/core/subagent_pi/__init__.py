"""Metis-owned durable Pi subagent runtime."""
import json
from pathlib import Path

__version__ = json.loads((Path(__file__).resolve().parents[4] / "package.json").read_text())["version"]
PROTOCOL_VERSION = 3
