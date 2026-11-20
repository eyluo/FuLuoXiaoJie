"""Run the complete offline FuLuoXiaoJie ETL pipeline and verify all DAG invariants."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from build_audio import build_audio
from build_examples import build_examples
from build_graph import build_graph
from build_strokes import build_strokes
from fetch_sources import fetch_all

SCRIPT_DIR = Path(__file__).resolve().parent


def main() -> None:
    print("=== [1/6] Fetching pinned sources ===")
    fetch_all()
    print("\n=== [2/6] Building Simplified Mandarin DAG (data/graph.json) ===")
    build_graph()
    print("\n=== [3/6] Building everyday example words (data/examples.json) ===")
    build_examples()
    print("\n=== [4/6] Extracting stroke-order JSONs (data/strokes/) ===")
    build_strokes()
    print("\n=== [5/6] Bundling offline syllable audio (data/audio/) ===")
    build_audio()
    print("\n=== [6/6] Running hard DAG & data invariant tests ===")
    res = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", str(SCRIPT_DIR), "-p", "test_*.py", "-v"],
        check=False,
    )
    if res.returncode != 0:
        sys.exit(res.returncode)
    print("\nAll data artifacts built and verified cleanly.")


if __name__ == "__main__":
    main()
