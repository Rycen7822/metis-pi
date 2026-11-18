#!/usr/bin/env python3
"""Prepare the native subagent schema payload for the metis npm package."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent / "src/subagents/backend"
sys.dont_write_bytecode = True
sys.path.insert(0, str(root))
from metis_subagent.common import BASE_ENV_KEYS, IDENTIFIER_PATTERN, MAX_FRAME, MODEL_IDENTIFIER_PATTERN, PROXY_ENV_KEYS
from metis_subagent.schema import NATIVE_TOOLS


def model_schema(value):
    """Project ID patterns for model providers that cannot compile look-around."""
    if isinstance(value, list):
        return [model_schema(item) for item in value]
    if isinstance(value, dict):
        return {
            key: MODEL_IDENTIFIER_PATTERN if key == "pattern" and item == IDENTIFIER_PATTERN else model_schema(item)
            for key, item in value.items()
        }
    return value


(root / "tools.json").write_text(json.dumps({
    "hostProtocol": 1, "baseEnvKeys": BASE_ENV_KEYS,
    "scopeEnvKeys": BASE_ENV_KEYS + PROXY_ENV_KEYS,
    "maxFrame": MAX_FRAME, "tools": model_schema(NATIVE_TOOLS),
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
