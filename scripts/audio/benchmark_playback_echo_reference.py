from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCENARIO_ROOT = PROJECT_ROOT / "services" / "speech-input" / "tests"
sys.path.insert(0, str(SCENARIO_ROOT))

from echo_reference_scenarios import run_benchmark  # noqa: E402


if __name__ == "__main__":
    print(run_benchmark().to_json())
