"""Locations shared by the imported behavioral fixtures."""
from pathlib import Path
import sys
import os

TEST_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TEST_ROOT.parent.parent
ROOT = REPO_ROOT / "src/subagents/core"
# Offline legacy fixtures must never read the user's real global TOML.
os.environ['METIS_PI_CONFIG'] = str(REPO_ROOT / '.work/_absent_metis_test_config.toml')
sys.path.insert(0, str(ROOT))
