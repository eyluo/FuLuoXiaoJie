"""Build the verified Simplified Mandarin character + primitive DAG (data/graph.json)."""

from __future__ import annotations

import csv
import datetime
import json
import re
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any

from pinyin_utils import (
    cedict_pinyin_to_numbered,
    is_valid_mandarin_syllable,
    numbered_to_toned,
    toned_to_numbered,
)

ROOT_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT_DIR / ".cache" / "sources"
DATA_DIR = ROOT_DIR / "data"
SCRIPT_DIR = Path(__file__).resolve().parent

# Ideographic Description Characters (U+2FF0..U+2FFF) + fullwidth question mark
IDC_CHARS = set(chr(cp) for cp in range(0x2FF0, 0x3000))
SKIP_IDS_TOKENS = IDC_CHARS | {"？", "?", " ", "\t", "\n", "\r"}

TOP_SUBTLEX_LIMIT = 3500
TOP_JUNDA_LIMIT = 3500


def is_cjk_glyph(ch: str) -> bool:
    if len(ch) != 1:
        return False
    cp = ord(ch)
    return (
        0x2E80 <= cp <= 0x2EFF  # CJK Radicals Supplement
        or 0x2F00 <= cp <= 0x2FDF  # Kangxi Radicals
        or 0x31C0 <= cp <= 0x31EF  # CJK Strokes
        or 0x3400 <= cp <= 0x4DBF  # CJK Ext A
        or 0x4E00 <= cp <= 0x9FFF  # CJK Unified Ideographs
        or 0xF900 <= cp <= 0xFAFF  # CJK Compatibility Ideographs
        or 0x20000 <= cp <= 0x2EBEF  # CJK Ext B-F
    )


def clean_text(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def load_mmh_dictionary() -> dict[str, dict]:
    result: dict[str, dict] = {}
    with open(CACHE_DIR / "mmh_dictionary.txt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            ch = obj.get("character")
            if ch:
                result[ch] = obj
    return result


def load_mmh_stroke_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    with open(CACHE_DIR / "mmh_graphics.txt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            ch = obj.get("character")
            strokes = obj.get("strokes")
            if ch and isinstance(strokes, list):
                counts[ch] = len(strokes)
    return counts


def load_cjkvi_ids() -> dict[str, str]:
    """Load CJKVI IDS preferring Mainland Simplified [G] sequence when tagged."""
    ids_map: dict[str, str] = {}
    with open(CACHE_DIR / "cjkvi_ids.txt", encoding="utf-8") as f:
        for line in f:
            if not line or line.startswith("#") or line.startswith(";"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            ch = parts[1].strip()
            if len(ch) != 1:
                continue
            candidates = parts[2:]
            chosen: str | None = None
            for cand in candidates:
                m = re.match(r"^([^\[]+)(?:\[([^\]]+)\])?$", cand.strip())
                if not m:
                    continue
                seq, tags = m.group(1).strip(), m.group(2) or ""
                if "&" in seq or seq == ch:
                    continue
                if "G" in tags:
                    chosen = seq
                    break
                if chosen is None:
                    chosen = seq
            if chosen:
                ids_map[ch] = chosen
    return ids_map


def load_subtlex_chr() -> tuple[dict[str, tuple[int, int, float]], int]:
    """Return {char: (count, rank_1based, share)} and total_count."""
    rows: list[tuple[str, int]] = []
    total = 0
    with open(CACHE_DIR / "subtlex_chr.tsv", encoding="gb18030", errors="replace") as f:
        for idx, line in enumerate(f):
            if idx < 3:
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            ch = parts[0].strip()
            if not is_cjk_glyph(ch):
                continue
            try:
                cnt = int(parts[1].strip())
            except ValueError:
                continue
            if cnt <= 0:
                continue
            rows.append((ch, cnt))
            total += cnt

    rows.sort(key=lambda x: (-x[1], x[0]))
    out: dict[str, tuple[int, int, float]] = {}
    for rank, (ch, cnt) in enumerate(rows, start=1):
        out[ch] = (cnt, rank, cnt / total if total else 0.0)
    return out, total


def load_junda() -> tuple[dict[str, tuple[int, int, float]], dict[str, list[str]], int]:
    """Parse frequencyjunda.txt.js -> ({char: (count, rank, share)}, {char: [numbered_pinyins]}, total_count)."""
    raw = (CACHE_DIR / "junda_freq.js").read_text(encoding="utf-8")
    m = re.search(r"`([\s\S]+)`", raw)
    body = m.group(1) if m else raw
    rows: list[tuple[str, int]] = []
    junda_pinyins: dict[str, list[str]] = {}
    total = 0
    for line in body.splitlines():
        parts = line.strip().split("\t")
        if len(parts) < 3:
            continue
        ch = parts[1].strip()
        if not is_cjk_glyph(ch):
            continue
        try:
            cnt = int(parts[2].strip())
        except ValueError:
            continue
        if cnt <= 0:
            continue
        rows.append((ch, cnt))
        total += cnt
        if len(parts) >= 5 and parts[4].strip():
            syls: list[str] = []
            for tok in parts[4].strip().split("/"):
                s = toned_to_numbered(tok)
                if s and is_valid_mandarin_syllable(s) and s not in syls:
                    syls.append(s)
            if syls:
                junda_pinyins[ch] = syls

    rows.sort(key=lambda x: (-x[1], x[0]))
    out: dict[str, tuple[int, int, float]] = {}
    for rank, (ch, cnt) in enumerate(rows, start=1):
        out[ch] = (cnt, rank, cnt / total if total else 0.0)
    return out, junda_pinyins, total


def load_hsk30() -> dict[str, int]:
    """Return {simplified_char: band_int (1..7 where 7 = Band 7-9)}."""
    out: dict[str, int] = {}
    with open(CACHE_DIR / "hsk30_chars.csv", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ch = (row.get("Hanzi") or "").strip()
            lvl_raw = (row.get("Level") or "").strip()
            if not is_cjk_glyph(ch) or not lvl_raw:
                continue
            if lvl_raw.startswith("7"):
                lvl = 7
            else:
                try:
                    lvl = int(lvl_raw)
                except ValueError:
                    continue
            if ch not in out or lvl < out[ch]:
                out[ch] = lvl
    return out


def load_radical_meanings() -> dict[str, str]:
    raw = (CACHE_DIR / "radical_meanings.js").read_text(encoding="utf-8")
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
        return {k: clean_text(str(v)) for k, v in data.items() if isinstance(k, str)}
    except json.JSONDecodeError:
        out: dict[str, str] = {}
        for km in re.finditer(r'"([^"]+)"\s*:\s*"([^"]+)"', m.group(0)):
            out[km.group(1)] = clean_text(km.group(2))
        return out


def load_cedict_single_chars() -> tuple[dict[str, list[tuple[str, str, bool]]], set[str]]:
    """Return ({simp_char: [(numbered_pinyin, definition, is_minor)]}, traditional_only_chars)."""
    pattern = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+/(.+)/\s*$")
    entries: dict[str, list[tuple[str, str, bool]]] = defaultdict(list)
    seen_as_simp: set[str] = set()
    seen_as_trad_diff: set[str] = set()

    with open(CACHE_DIR / "cedict_ts.u8", encoding="utf-8") as f:
        for line in f:
            if not line or line.startswith("#"):
                continue
            m = pattern.match(line.strip())
            if not m:
                continue
            trad, simp, pinyin_raw, defs_raw = m.groups()
            if len(simp) == 1 and is_cjk_glyph(simp):
                seen_as_simp.add(simp)
                if len(trad) == 1 and trad != simp and is_cjk_glyph(trad):
                    seen_as_trad_diff.add(trad)
            else:
                continue

            is_capitalized_proper = any(p[:1].isupper() for p in pinyin_raw.split())
            numbered = cedict_pinyin_to_numbered(pinyin_raw)
            if not numbered or " " in numbered:
                continue
            defs = [clean_text(d) for d in defs_raw.split("/") if d.strip()]
            if not defs:
                continue
            is_minor = is_capitalized_proper or all(
                d.startswith(
                    (
                        "surname ",
                        "variant of ",
                        "old variant of ",
                        "abbr. for ",
                        "see ",
                        "Taiwan pr.",
                    )
                )
                for d in defs
            )
            good_defs = [
                d
                for d in defs
                if not d.startswith(("CL:", "old variant of ", "variant of ", "Taiwan pr."))
            ]
            gloss = "; ".join((good_defs or defs)[:3])
            entries[simp].append((numbered, gloss, is_minor))

    trad_only = seen_as_trad_diff - seen_as_simp
    return entries, trad_only


def load_subtlex_word_pinyin_weights(cedict_words_path: Path) -> dict[tuple[str, str], int]:
    """Weight readings strictly from multi-character (len>=2) non-proper words, deduplicated per (simp, syls)."""
    wf: dict[str, int] = {}
    with open(CACHE_DIR / "subtlex_wf.tsv", encoding="gb18030", errors="replace") as f:
        for idx, line in enumerate(f):
            if idx < 3:
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            w = parts[0].strip()
            if len(w) < 2:
                continue
            try:
                wf[w] = int(parts[1].strip())
            except ValueError:
                continue

    pattern = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+/(.+)/\s*$")
    seen_word_readings: set[tuple[str, tuple[str, ...]]] = set()
    char_reading_weight: dict[tuple[str, str], int] = defaultdict(int)

    with open(cedict_words_path, encoding="utf-8") as f:
        for line in f:
            if not line or line.startswith("#"):
                continue
            m = pattern.match(line.strip())
            if not m:
                continue
            _trad, simp, pinyin_raw, _defs = m.groups()
            if len(simp) < 2:
                continue
            if any(p[:1].isupper() for p in pinyin_raw.split()):
                continue
            freq = wf.get(simp, 0)
            if freq <= 0:
                continue
            syls = tuple(cedict_pinyin_to_numbered(pinyin_raw).split())
            if len(syls) != len(simp):
                continue
            key = (simp, syls)
            if key in seen_word_readings:
                continue
            seen_word_readings.add(key)
            for ch, syl in zip(simp, syls, strict=True):
                char_reading_weight[(ch, syl)] += freq
    return char_reading_weight


def parse_ids_components(ids_str: str, char: str) -> Counter[str]:
    """Extract direct graphical components and multiplicities from an IDS string."""
    counts: Counter[str] = Counter()
    if not ids_str or ids_str.startswith("？"):
        return counts
    for ch in ids_str:
        if ch in SKIP_IDS_TOKENS or ch == char:
            continue
        if is_cjk_glyph(ch):
            counts[ch] += 1
    return counts


def kahn_topo_sort(node_ids: set[str], edges: list[tuple[str, str]]) -> tuple[list[str], set[str]]:
    """Run Kahn's topological sort. Returns (ordered_ids, remaining_nodes_after_forward_kahn)."""
    indeg: dict[str, int] = {n: 0 for n in node_ids}
    adj: dict[str, list[str]] = defaultdict(list)
    for src, dst in edges:
        if src not in node_ids or dst not in node_ids or src == dst:
            continue
        adj[src].append(dst)
        indeg[dst] += 1

    ready = deque(sorted(n for n, d in indeg.items() if d == 0))
    order: list[str] = []
    while ready:
        u = ready.popleft()
        order.append(u)
        newly_ready: list[str] = []
        for v in adj.get(u, []):
            indeg[v] -= 1
            if indeg[v] == 0:
                newly_ready.append(v)
        if newly_ready:
            for v in sorted(newly_ready):
                ready.append(v)

    remaining = node_ids - set(order)
    return order, remaining


def find_core_cycle_edges(
    cycle_superset: set[str], edges: list[tuple[str, str]]
) -> list[tuple[str, str]]:
    """Prune 0-outdegree descendants via reverse Kahn so only genuine cycle-bearing edges remain."""
    sub_nodes = set(cycle_superset)
    outdeg: dict[str, int] = {n: 0 for n in sub_nodes}
    rev_adj: dict[str, list[str]] = defaultdict(list)
    sub_edges = [(u, v) for (u, v) in edges if u in sub_nodes and v in sub_nodes and u != v]
    for u, v in sub_edges:
        outdeg[u] += 1
        rev_adj[v].append(u)

    q = deque(sorted(n for n, d in outdeg.items() if d == 0))
    pruned: set[str] = set()
    while q:
        v = q.popleft()
        pruned.add(v)
        for u in rev_adj[v]:
            outdeg[u] -= 1
            if outdeg[u] == 0:
                q.append(u)

    core_nodes = sub_nodes - pruned
    return sorted((u, v) for (u, v) in sub_edges if u in core_nodes and v in core_nodes)


# Standalone high-frequency modal/grammatical particle readings where MMH uses non-neutral citation tone
PRIMARY_READING_OVERRIDES: dict[str, str] = {
    "吧": "ba5",
    "呢": "ne5",
    "吗": "ma5",
    "了": "le5",
    "的": "de5",
}


def rank_character_readings(
    ch: str,
    mmh: dict,
    junda_pinyins: dict[str, list[str]],
    cedict_list: list[tuple[str, str, bool]],
    reading_weights: dict[tuple[str, str], int],
) -> list[str]:
    """Produce ordered unique numbered Mandarin readings for a character (primary learner reading first)."""
    mmh_list = [
        toned_to_numbered(p)
        for p in (mmh.get("pinyin") or [])
        if is_valid_mandarin_syllable(toned_to_numbered(p))
    ]
    junda_list = junda_pinyins.get(ch, [])
    cedict_major = [
        syl for syl, _g, minor in cedict_list if not minor and is_valid_mandarin_syllable(syl)
    ]
    cedict_all = [syl for syl, _g, _minor in cedict_list if is_valid_mandarin_syllable(syl)]

    candidates: list[str] = []
    for src_list in (mmh_list, cedict_major, junda_list, cedict_all):
        for s in src_list:
            if s and s not in candidates:
                candidates.append(s)

    if not candidates:
        return []

    mmh_primary = mmh_list[0] if mmh_list else None
    override_primary = PRIMARY_READING_OVERRIDES.get(ch)

    def score_reading(syl: str) -> tuple[int, int, int, int, int]:
        is_erhua_r5 = 1 if (ch == "儿" and syl == "r5") else 0
        is_override = 1 if (override_primary is not None and syl == override_primary) else 0
        # Make Me a Hanzi primary reading is learner-curated (whereas Jun Da col 5 is often tone/alphabetically ordered)
        is_mmh_first = 1 if (mmh_primary is not None and syl == mmh_primary) else 0
        is_major_cedict = 1 if syl in cedict_major else 0
        w_multi = reading_weights.get((ch, syl), 0)
        return (-is_erhua_r5, is_override, is_mmh_first, is_major_cedict, w_multi)

    ordered = sorted(candidates, key=score_reading, reverse=True)
    return ordered[:5]


def build_graph() -> dict:
    variants_cfg = json.loads((SCRIPT_DIR / "variants.json").read_text(encoding="utf-8"))
    raw_variant_map: dict[str, str] = variants_cfg["variant_to_canonical"]
    primitive_glosses: dict[str, str] = variants_cfg["primitive_glosses"]

    print("Loading datasets...")
    mmh_dict = load_mmh_dictionary()
    stroke_counts = load_mmh_stroke_counts()
    cjkvi_ids = load_cjkvi_ids()
    subtlex_chr, subtlex_total = load_subtlex_chr()
    junda_chr, junda_pinyins, junda_total = load_junda()
    hsk30 = load_hsk30()
    radical_meanings = load_radical_meanings()
    cedict_chars, trad_only_chars = load_cedict_single_chars()
    reading_weights = load_subtlex_word_pinyin_weights(CACHE_DIR / "cedict_ts.u8")

    # 1. Determine core Simplified character set (~3,800 chars: top 3,500 SUBTLEX + top 3,500 Jun Da + all HSK 3.0 Bands 1-9)
    core_chars: set[str] = set()
    for ch, (_cnt, rank, _share) in subtlex_chr.items():
        if rank <= TOP_SUBTLEX_LIMIT:
            core_chars.add(ch)
    for ch, (_cnt, rank, _share) in junda_chr.items():
        if rank <= TOP_JUNDA_LIMIT:
            core_chars.add(ch)
    for ch, lvl in hsk30.items():
        if lvl <= 7:  # Full HSK 3.0 Bands 1-9 coverage
            core_chars.add(ch)

    # Keep only valid Simplified characters (exclude Traditional-only glyphs like 後/妳 unless explicitly in HSK 3.0)
    core_chars = {
        ch
        for ch in core_chars
        if (ch in mmh_dict or ch in cedict_chars)
        and is_cjk_glyph(ch)
        and (ch in hsk30 or ch not in trad_only_chars)
    }
    print(f"Selected {len(core_chars)} core Simplified characters.")

    # 2. Helper to get best decomposition for any node
    def get_decomposition(ch: str) -> tuple[str | None, Counter[str], dict | None]:
        mmh = mmh_dict.get(ch)
        etym = mmh.get("etymology") if mmh else None
        ids_str: str | None = None
        parts: Counter[str] = Counter()

        if mmh:
            mmh_ids = (mmh.get("decomposition") or "").strip()
            if mmh_ids and not mmh_ids.startswith("？"):
                if "？" not in mmh_ids:
                    ids_str = mmh_ids
                    parts = parse_ids_components(mmh_ids, ch)
                else:
                    fb = cjkvi_ids.get(ch)
                    if fb:
                        fb_parts = parse_ids_components(fb, ch)
                        if fb_parts:
                            ids_str = fb
                            parts = fb_parts
                    if not parts:
                        ids_str = mmh_ids
                        parts = parse_ids_components(mmh_ids, ch)

        if not parts:
            fb = cjkvi_ids.get(ch)
            if fb:
                fb_parts = parse_ids_components(fb, ch)
                if fb_parts:
                    ids_str = fb
                    parts = fb_parts

        # If IDS contains only IDC operators and '？' with no actual components, treat as atomic (None)
        if not parts:
            ids_str = None

        # Disambiguate flesh radical '月' -> '⺼' when etymology/radical clearly indicates flesh (肉)
        if parts.get("月", 0) > 0 and ch != "月" and ch != "肉":
            is_flesh = False
            if (
                etym
                and etym.get("semantic") in ("肉", "⺼")
                or mmh
                and mmh.get("radical") in ("肉", "⺼")
                and ch not in ("明", "期", "朝", "朗", "望", "朋", "服", "朔", "朕", "朦", "胧")
            ):
                is_flesh = True
            if is_flesh:
                cnt = parts.pop("月")
                parts["⺼"] += cnt

        # Guard against stroke-count inversions (proper sub-components strictly reduce stroke count)
        ch_strokes = stroke_counts.get(ch)
        if ch_strokes is not None and ch_strokes > 0:
            cleaned: Counter[str] = Counter()
            for comp, mult in parts.items():
                comp_strokes = stroke_counts.get(comp)
                if comp_strokes is not None and comp_strokes >= ch_strokes:
                    continue
                cleaned[comp] = mult
            parts = cleaned
            if not parts:
                ids_str = None

        return ids_str, parts, etym

    # 3. Recursively close the DAG from core_chars down to atomic primitives
    all_nodes: set[str] = set(core_chars)
    raw_decomp: dict[str, str | None] = {}
    raw_etym: dict[str, dict | None] = {}
    edge_map: dict[tuple[str, str], tuple[int, str]] = {}

    queue = deque(sorted(core_chars))
    visited: set[str] = set()
    while queue:
        ch = queue.popleft()
        if ch in visited:
            continue
        visited.add(ch)

        ids_str, parts, etym = get_decomposition(ch)
        raw_decomp[ch] = ids_str
        raw_etym[ch] = etym

        sem = etym.get("semantic") if etym else None
        phon = etym.get("phonetic") if etym else None
        sem_matches = {"肉", "⺼"} if sem == "肉" else ({sem} if sem else set())
        phon_matches = {phon} if phon else set()

        for comp, mult in parts.items():
            if comp == ch:
                continue
            role = "structural"
            if comp in phon_matches:
                role = "phonetic"
            elif comp in sem_matches:
                role = "semantic"
            else:
                canon = raw_variant_map.get(comp)
                if canon and canon in phon_matches:
                    role = "phonetic"
                elif canon and canon in sem_matches:
                    role = "semantic"

            edge_map[(comp, ch)] = (mult, role)
            if comp not in all_nodes:
                all_nodes.add(comp)
                queue.append(comp)

    # 4. Verify & enforce strict raw DAG acyclicity (pruning to true cycle core before breaking any edge)
    while True:
        topo_order, cycle_superset = kahn_topo_sort(all_nodes, list(edge_map.keys()))
        if not cycle_superset:
            break
        core_cycle_edges = find_core_cycle_edges(cycle_superset, list(edge_map.keys()))
        if not core_cycle_edges:
            break
        print(
            f"  [cycle-guard] Breaking raw IDS cycle edge: {core_cycle_edges[0][0]} -> {core_cycle_edges[0][1]}"
        )
        del edge_map[core_cycle_edges[0]]

    # 5. Build active variant_map restricted to graph nodes & guaranteed acyclic + self-loop-free when contracted
    active_variant_map: dict[str, str] = {}
    for var, canon in sorted(raw_variant_map.items()):
        if var == canon or var not in all_nodes or canon not in all_nodes:
            continue
        candidate_map = dict(active_variant_map)
        candidate_map[var] = canon

        def resolve(x: str, cmap: dict[str, str]) -> str:
            seen = set()
            while x in cmap and x not in seen:
                seen.add(x)
                x = cmap[x]
            return x

        contracted_nodes = {resolve(n, candidate_map) for n in all_nodes}
        contracted_edges: set[tuple[str, str]] = set()
        has_self_loop = False
        for src, dst in edge_map:
            csrc = resolve(src, candidate_map)
            cdst = resolve(dst, candidate_map)
            if csrc == cdst:
                has_self_loop = True
                break
            contracted_edges.add((csrc, cdst))

        if has_self_loop:
            print(f"  [variant-guard] Skipping {var} -> {canon} (would create self-loop)")
            continue
        _, cyc = kahn_topo_sort(contracted_nodes, list(contracted_edges))
        if cyc:
            print(
                f"  [variant-guard] Skipping {var} -> {canon} (would create cycle in {sorted(cyc)[:5]})"
            )
            continue
        active_variant_map[var] = canon

    print(
        f"DAG verified: {len(all_nodes)} nodes ({len(core_chars)} core chars + "
        f"{len(all_nodes) - len(core_chars)} primitives/intermediates), "
        f"{len(edge_map)} edges, {len(active_variant_map)} active variant mappings."
    )

    # 6. Assemble rich node objects in topological order
    nodes_out: list[dict] = []
    subtlex_cov = 0.0
    junda_cov = 0.0

    for ch in topo_order:
        is_primitive = ch not in core_chars
        mmh = mmh_dict.get(ch) or {}
        etym_raw = raw_etym.get(ch)
        etym_out = None
        if isinstance(etym_raw, dict) and etym_raw.get("type") in (
            "pictophonetic",
            "ideographic",
            "pictographic",
        ):
            etym_out = {"type": etym_raw["type"]}
            if etym_raw.get("semantic"):
                etym_out["semantic"] = etym_raw["semantic"]
            if etym_raw.get("phonetic"):
                etym_out["phonetic"] = etym_raw["phonetic"]
            if etym_raw.get("hint"):
                etym_out["hint"] = clean_text(str(etym_raw["hint"]))

        cedict_list = cedict_chars.get(ch, [])
        numbered_readings = rank_character_readings(
            ch, mmh, junda_pinyins, cedict_list, reading_weights
        )
        toned_readings = [numbered_to_toned(s) for s in numbered_readings]

        definition = ""
        if is_primitive and ch in primitive_glosses:
            definition = clean_text(primitive_glosses[ch])
        if not definition and mmh.get("definition"):
            definition = clean_text(str(mmh["definition"]))
        if not definition and cedict_list:
            non_minor = [g for _s, g, minor in cedict_list if not minor]
            definition = clean_text(non_minor[0] if non_minor else cedict_list[0][1])
        if not definition and ch in primitive_glosses:
            definition = clean_text(primitive_glosses[ch])
        if not definition and ch in radical_meanings:
            definition = clean_text(f"{radical_meanings[ch]} (radical)")
        if not definition:
            canon = active_variant_map.get(ch)
            if canon and canon in mmh_dict and mmh_dict[canon].get("definition"):
                definition = clean_text(f"{mmh_dict[canon]['definition']} (variant of {canon})")
            else:
                definition = "structural component"

        sub_cnt, sub_rank, sub_share = subtlex_chr.get(ch, (0, None, 0.0))
        jun_cnt, jun_rank, jun_share = junda_chr.get(ch, (0, None, 0.0))
        if not is_primitive:
            subtlex_cov += sub_share
            junda_cov += jun_share

        has_strokes = ch in stroke_counts
        stroke_file = f"u{ord(ch):04x}.json" if has_strokes else None

        nodes_out.append(
            {
                "id": ch,
                "isPrimitive": is_primitive,
                "strokes": stroke_counts.get(ch, 0),
                "hasStrokes": has_strokes,
                "strokeFile": stroke_file,
                "pinyin": toned_readings,
                "syllables": numbered_readings,
                "audio": None,
                "definition": definition,
                "radical": mmh.get("radical"),
                "decomposition": raw_decomp.get(ch),
                "etymology": etym_out,
                "hskLevel": hsk30.get(ch),
                "freq": {
                    "subtlexCount": sub_cnt,
                    "subtlexRank": sub_rank,
                    "subtlexShare": round(sub_share, 8),
                    "jundaCount": jun_cnt,
                    "jundaRank": jun_rank,
                    "jundaShare": round(jun_share, 8),
                },
            }
        )

    edges_out = [
        {
            "source": src,
            "target": dst,
            "multiplicity": mult,
            "role": role,
        }
        for (src, dst), (mult, role) in sorted(edge_map.items())
    ]

    meta: dict[str, Any] = {
        "version": "1.0.0",
        "generatedAt": datetime.datetime.now(datetime.UTC).isoformat(),
        "characterCount": len(core_chars),
        "primitiveCount": len(all_nodes) - len(core_chars),
        "nodeCount": len(nodes_out),
        "edgeCount": len(edges_out),
        "subtlexTotalCount": subtlex_total,
        "jundaTotalCount": junda_total,
        "subtlexCoveragePct": round(subtlex_cov * 100, 3),
        "jundaCoveragePct": round(junda_cov * 100, 3),
    }

    dataset: dict[str, Any] = {
        "meta": meta,
        "variantMap": active_variant_map,
        "nodes": nodes_out,
        "edges": edges_out,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / "graph.json"
    out_path.write_text(
        json.dumps(dataset, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"Wrote {out_path} ({out_path.stat().st_size:,} bytes) | "
        f"SUBTLEX cov: {meta['subtlexCoveragePct']}%, "
        f"Jun Da cov: {meta['jundaCoveragePct']}%"
    )
    return dataset


if __name__ == "__main__":
    build_graph()
