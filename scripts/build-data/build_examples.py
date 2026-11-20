"""Build top everyday multi-character example words per character (data/examples.json)."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from build_graph import is_cjk_glyph
from pinyin_utils import cedict_pinyin_to_numbered, cedict_pinyin_to_toned

ROOT_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT_DIR / ".cache" / "sources"
DATA_DIR = ROOT_DIR / "data"

MAX_EXAMPLES_PER_CHAR = 5

VULGAR_PATTERNS = ("(taboo", "(vulgar", "fucking", "damn it", "motherfucker", "bullshit", "fuck")
CROSSREF_RE = re.compile(r"\s*[\u4e00-\u9fff\|]+\[[^\]]+\]")
CL_PAREN_RE = re.compile(r"\s*\(CL:[^)]+\)")


def sanitize_gloss(raw_defs: list[str]) -> str:
    cleaned: list[str] = []
    for d in raw_defs:
        s = CL_PAREN_RE.sub("", d)
        s = CROSSREF_RE.sub("", s)
        s = re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip(" ;,")
        if s:
            cleaned.append(s)
    gloss = "; ".join(cleaned[:2])
    if len(gloss) > 100:
        gloss = gloss[:97].rstrip("; ,") + "..."
    return gloss


def build_examples() -> dict[str, list[dict]]:
    graph = json.loads((DATA_DIR / "graph.json").read_text(encoding="utf-8"))
    target_chars = {n["id"] for n in graph["nodes"]}

    # Load SUBTLEX-CH word frequencies
    wf: dict[str, int] = {}
    with open(CACHE_DIR / "subtlex_wf.tsv", "r", encoding="gb18030", errors="replace") as f:
        for idx, line in enumerate(f):
            if idx < 3:
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            w = parts[0].strip()
            if len(w) < 2 or len(w) > 4:
                continue
            try:
                cnt = int(parts[1].strip())
            except ValueError:
                continue
            if cnt > 0:
                wf[w] = cnt

    # Parse CC-CEDICT multi-character words (2-4 CJK chars only)
    pattern = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+/(.+)/\s*$")
    word_entries: dict[str, tuple[str, str, str, int, bool, bool]] = {}

    with open(CACHE_DIR / "cedict_ts.u8", "r", encoding="utf-8") as f:
        for line in f:
            if not line or line.startswith("#"):
                continue
            m = pattern.match(line.strip())
            if not m:
                continue
            _trad, simp, pinyin_raw, defs_raw = m.groups()
            if len(simp) < 2 or len(simp) > 4:
                continue
            if not all(is_cjk_glyph(ch) for ch in simp):
                continue
            if not any(ch in target_chars for ch in simp):
                continue

            numbered = cedict_pinyin_to_numbered(pinyin_raw)
            if len(numbered.split()) != len(simp):
                continue

            defs = [d.strip() for d in defs_raw.split("/") if d.strip()]
            clean_defs = [
                d for d in defs
                if not d.startswith(("CL:", "variant of ", "old variant of ", "see ", "Taiwan pr."))
            ]
            if not clean_defs:
                continue

            # CC-CEDICT marks proper nouns (places, books, brands, organizations, surnames) with capitalized pinyin
            has_cap_pinyin = any(p[:1].isupper() for p in pinyin_raw.split())
            is_proper = has_cap_pinyin or all(
                d.startswith(("surname ", "abbr. for "))
                for d in clean_defs[:1]
            )
            gloss = sanitize_gloss(clean_defs)
            if not gloss:
                continue
            lower_gloss = gloss.lower()
            is_vulgar = any(vp in lower_gloss for vp in VULGAR_PATTERNS)

            toned = cedict_pinyin_to_toned(pinyin_raw)
            freq = wf.get(simp, 0)

            existing = word_entries.get(simp)
            # Always prefer non-proper over proper, and non-vulgar over vulgar
            if existing is None:
                word_entries[simp] = (toned, numbered, gloss, freq, is_proper, is_vulgar)
            else:
                prev_proper, prev_vulgar = existing[4], existing[5]
                if (prev_proper and not is_proper) or (prev_proper == is_proper and prev_vulgar and not is_vulgar):
                    word_entries[simp] = (toned, numbered, gloss, freq, is_proper, is_vulgar)

    # Index candidate words per character deterministically
    per_char: dict[str, list[tuple[int, int, str, str, str, str]]] = defaultdict(list)
    for word, (toned, numbered, gloss, freq, is_proper, is_vulgar) in sorted(word_entries.items()):
        score = freq
        if is_proper:
            score = int(score * 0.05)
        if is_vulgar:
            score = int(score * 0.01)
        length_bonus = 1 if len(word) == 2 else 0
        for ch in sorted(set(word)):
            if ch in target_chars:
                per_char[ch].append((score, length_bonus, word, toned, numbered, gloss))

    out: dict[str, list[dict]] = {}
    for ch, cands in sorted(per_char.items()):
        cands.sort(key=lambda x: (-x[0], -x[1], len(x[2]), x[2]))
        selected = []
        for score, _lb, word, toned, numbered, gloss in cands[:MAX_EXAMPLES_PER_CHAR]:
            selected.append({
                "word": word,
                "pinyin": toned,
                "numbered": numbered,
                "gloss": gloss,
                "freq": score,
            })
        if selected:
            out[ch] = selected

    out_path = DATA_DIR / "examples.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out_path} ({out_path.stat().st_size:,} bytes) covering {len(out)} nodes.")
    return out


if __name__ == "__main__":
    build_examples()
