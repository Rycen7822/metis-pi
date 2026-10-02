#!/usr/bin/env python3
"""Prepare the native subagent schema payload for the metis npm package."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent / "src/subagents/core"
sys.dont_write_bytecode = True
sys.path.insert(0, str(root))
from subagent_pi.common import BASE_ENV_KEYS, MAX_FRAME
from subagent_pi.schema import TOOLS

(root / "tools.json").write_text(json.dumps({
    "hostProtocol": 1, "baseEnvKeys": BASE_ENV_KEYS,
    "maxFrame": MAX_FRAME, "tools": TOOLS,
}, ensure_ascii=False, indent=2) + "\n")
