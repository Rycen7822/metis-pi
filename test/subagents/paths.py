"""Locations shared by the imported behavioral fixtures."""
from pathlib import Path
import sys

TEST_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TEST_ROOT.parent.parent
ROOT = REPO_ROOT / "src/subagents/core"
sys.path.insert(0, str(ROOT))
