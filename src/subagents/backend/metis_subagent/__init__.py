"""Metis-owned durable Pi subagent runtime."""
import json
from hashlib import sha256
from .paths import ENTRYPOINT, MODULE_DIR, PACKAGE_DIR, WORKER_DIR

__version__ = json.loads((PACKAGE_DIR / "package.json").read_text())["version"]
PROTOCOL_VERSION = 4

# Captured at import time: changing files on disk cannot update a resident daemon.
_digest = sha256()
for _file in [PACKAGE_DIR / 'metis-pi.toml', PACKAGE_DIR / 'src' / 'extension-paths.ts', PACKAGE_DIR / 'src/presentation/tool-source.mjs', ENTRYPOINT, *sorted(MODULE_DIR.glob('*.py')),
              *sorted(WORKER_DIR.glob('*.ts')), *sorted(WORKER_DIR.glob('*.mjs'))]:
    _digest.update(str(_file.relative_to(PACKAGE_DIR)).encode() + b'\0' + _file.read_bytes())
RUNTIME_REVISION = _digest.hexdigest()
