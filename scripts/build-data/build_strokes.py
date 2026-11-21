"""Extract per-character Hanzi Writer stroke JSONs from Make Me a Hanzi graphics.txt."""

from __future__ import annotations

import json
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT_DIR / ".cache" / "sources"
DATA_DIR = ROOT_DIR / "data"


def build_strokes() -> int:
    graph_path = DATA_DIR / "graph.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    target_chars = {n["id"] for n in graph["nodes"]}

    strokes_dir = DATA_DIR / "strokes"
    strokes_dir.mkdir(parents=True, exist_ok=True)

    written: set[str] = set()
    with open(CACHE_DIR / "mmh_graphics.txt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            ch = obj.get("character")
            if ch not in target_chars:
                continue
            strokes = obj.get("strokes")
            medians = obj.get("medians")
            if not isinstance(strokes, list) or not isinstance(medians, list) or not strokes:
                continue
            payload = {"strokes": strokes, "medians": medians}
            fname = f"u{ord(ch):04x}.json"
            (strokes_dir / fname).write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            written.add(ch)

    # Sync exact hasStrokes / strokeFile flags in graph.json
    updated = False
    for node in graph["nodes"]:
        has_s = node["id"] in written
        s_file = f"u{ord(node['id']):04x}.json" if has_s else None
        if node.get("hasStrokes") != has_s or node.get("strokeFile") != s_file:
            node["hasStrokes"] = has_s
            node["strokeFile"] = s_file
            updated = True

    if updated:
        graph_path.write_text(
            json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )

    print(f"Wrote {len(written)} stroke JSON files into {strokes_dir}.")
    return len(written)


if __name__ == "__main__":
    build_strokes()
