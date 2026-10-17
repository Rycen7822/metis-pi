"""Locations shared by the imported behavioral fixtures."""
from pathlib import Path
import sys
import os

TEST_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TEST_ROOT.parent.parent
ROOT = REPO_ROOT / "src/subagents/core"
# Respect the runner's disposable native TOML; never fall back to user config.
os.environ.setdefault('METIS_PI_CONFIG', str(REPO_ROOT / '.work/_absent_metis_test_config.toml'))
sys.path.insert(0, str(ROOT))
