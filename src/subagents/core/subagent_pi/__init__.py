"""Metis-owned durable Pi subagent runtime."""
import json
from hashlib import sha256
from pathlib import Path

__version__ = json.loads((Path(__file__).resolve().parents[4] / "package.json").read_text())["version"]
PROTOCOL_VERSION = 4

# Captured at import time: changing files on disk cannot update a resident daemon.
_root = Path(__file__).resolve().parent.parent
_digest = sha256()
for _file in [_root.parents[2] / 'metis-pi.toml', _root / 'bin/subagent-pi', *sorted((_root / 'subagent_pi').glob('*.py')),
              *sorted((_root / 'extensions').glob('*.ts')), *sorted((_root / 'runtime').glob('*.mjs'))]:
    _digest.update(str(_file.relative_to(_root.parents[2])).encode() + b'\0' + _file.read_bytes())
RUNTIME_REVISION = _digest.hexdigest()
