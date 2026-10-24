"""Locations shared by the imported behavioral fixtures."""
from pathlib import Path
import sys
import os
import tempfile

# Windows runner TEMP can be an 8.3 alias; fixture paths model resolved CLI roots.
if sys.platform == 'win32':
    tempfile.tempdir = str(Path(tempfile.gettempdir()).resolve())

TEST_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TEST_ROOT.parent.parent
ROOT = REPO_ROOT / "src/subagents/backend"
WORKER_ROOT = REPO_ROOT / "src/subagents/worker"
# Respect the runner's disposable native TOML; never fall back to user config.
os.environ.setdefault('METIS_PI_CONFIG', str(REPO_ROOT / '.work/_absent_metis_test_config.toml'))
sys.path.insert(0, str(ROOT))
