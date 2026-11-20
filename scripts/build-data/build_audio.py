"""Assemble bundled offline Mandarin syllable MP3 files for all readings in graph.json."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fetch_sources import SHAS

ROOT_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT_DIR / ".cache" / "sources"
DATA_DIR = ROOT_DIR / "data"

INTERJECTION_BASE_FALLBACK = {
    "r": "er",
    "yo": "you",
    "o": "ou",
    "m": "en",
    "n": "en",
    "ng": "en",
    "hng": "heng",
    "bia": "bi",
}


def is_valid_mp3_bytes(data: bytes) -> bool:
    """Verify bytes start with an ID3 tag or MPEG audio frame sync header."""
    if len(data) < 128:
        return False
    if data[:3] == b"ID3":
        return True
    # MPEG frame sync: 11 set bits (0xFF followed by 0xE0 mask)
    return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0


def davin_candidate_names(syllable: str) -> list[tuple[str, bool]]:
    """Return [(stem, is_fallback)] for davinfifield's naming convention (uses 'uu' for ü: luu3, nuu3, luue4, nuue4)."""
    m = re.fullmatch(r"([a-zv]+)([1-5])", syllable)
    if not m:
        return []
    base, tone = m.group(1), m.group(2)

    # davinfifield encodes ü as 'uu' (NEVER map lv/nv -> lu/nu!)
    davin_base = base.replace("v", "uu")
    cands: list[tuple[str, bool]] = [(f"{davin_base}{tone}", False)]

    # Neutral tone (5): prefer explicit tone-5/unmarked file, then gentle tone neighbor
    if tone == "5":
        cands.append((davin_base, False))
        for alt in ("1", "4", "2", "3"):
            cands.append((f"{davin_base}{alt}", True))
    return cands


def hugolpz_candidate_names(syllable: str) -> list[tuple[str, bool]]:
    """Return ASCII-safe [(stem, is_fallback)] for hugolpz/audio-cmn (cmn-<stem>.mp3)."""
    m = re.fullmatch(r"([a-zv]+)([1-5])", syllable)
    if not m:
        return []
    base, tone = m.group(1), m.group(2)
    cands: list[tuple[str, bool]] = [(f"{base}{tone}", False)]
    if tone == "5":
        cands.append((base, False))
        for alt in ("1", "2", "4", "3"):
            cands.append((f"{base}{alt}", True))
    return cands


def try_fetch_hugolpz(syllable: str, cache_dir: Path) -> tuple[Path, bool] | None:
    """Lazily fetch a single missing syllable from hugolpz/audio-cmn (CC-BY-SA) with atomic writes & MP3 check."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    sha = SHAS["hugolpz_audio"]
    for cand, is_fb in hugolpz_candidate_names(syllable):
        cached = cache_dir / f"cmn-{cand}.mp3"
        if cached.exists() and is_valid_mp3_bytes(cached.read_bytes()):
            return cached, is_fb
        encoded = urllib.parse.quote(f"cmn-{cand}.mp3", safe="")
        for folder in ("24k-abr/syllabs", "64k/syllabs"):
            url = f"https://raw.githubusercontent.com/hugolpz/audio-cmn/{sha}/{folder}/{encoded}"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "FuLuoXiaoJie-ETL/1.0"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read()
                if not is_valid_mp3_bytes(data):
                    continue
                tmp_path: Path | None = None
                try:
                    with tempfile.NamedTemporaryFile(dir=cache_dir, delete=False) as tmp:
                        tmp_path = Path(tmp.name)
                        tmp.write(data)
                    os.replace(tmp_path, cached)
                    tmp_path = None
                    return cached, is_fb
                finally:
                    if tmp_path is not None and tmp_path.exists():
                        tmp_path.unlink(missing_ok=True)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, UnicodeEncodeError):
                continue
    return None


def build_audio() -> dict:
    graph_path = DATA_DIR / "graph.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))

    davin_dir = CACHE_DIR / "audio_packs" / "davinfifield_mp3"
    hugo_cache = CACHE_DIR / "audio_packs" / "hugolpz_lazy"
    audio_out = DATA_DIR / "audio"
    audio_out.mkdir(parents=True, exist_ok=True)

    # Index davinfifield filenames (case-insensitive stem -> Path)
    davin_index: dict[str, Path] = {}
    if davin_dir.exists():
        for p in davin_dir.glob("*.mp3"):
            davin_index[p.stem.lower()] = p

    # Collect all unique syllables referenced in graph.json
    required_syllables: set[str] = set()
    for node in graph["nodes"]:
        for syl in node.get("syllables") or []:
            if syl:
                required_syllables.add(syl)

    # Always prune stale/orphaned MP3s and rebuild cleanly from local cache so outputs & manifest stay 100% accurate
    for stale in audio_out.glob("*.mp3"):
        stale.unlink()

    resolved: dict[str, str] = {}
    from_davin = 0
    from_hugo = 0
    tone_fallback = 0
    missing: list[str] = []

    for syl in sorted(required_syllables):
        out_file = audio_out / f"{syl}.mp3"
        src: Path | None = None
        source_kind: str | None = None

        # 1. Exact Public Domain match in davinfifield (including luu*/nuu*/luue*/nuue* for ü)
        for cand, is_fb in davin_candidate_names(syl):
            if not is_fb and cand in davin_index:
                src = davin_index[cand]
                source_kind = "davinfifield"
                break

        # 2. Supplemental match from hugolpz/audio-cmn (CC-BY-SA) before falling back on davinfifield tone
        if src is None:
            hugo_res = try_fetch_hugolpz(syl, hugo_cache)
            if hugo_res is not None:
                src, is_fb = hugo_res
                source_kind = "fallback" if is_fb else "hugolpz"

        # 3. Tone neighbor in davinfifield (for neutral tone 5 or rare tone gaps on same exact base)
        if src is None:
            for cand, is_fb in davin_candidate_names(syl):
                if is_fb and cand in davin_index:
                    src = davin_index[cand]
                    source_kind = "fallback"
                    break

        # 4. Last-resort tone/interjection neighbor for rare interjections (yo, m, hng, bia, r5)
        if src is None:
            m = re.fullmatch(r"([a-zv]+)([1-5])", syl)
            if m:
                base, tone = m.group(1), m.group(2)
                davin_base = base.replace("v", "uu")
                alt_base = INTERJECTION_BASE_FALLBACK.get(davin_base, davin_base)
                for try_tone in (tone, "1", "2", "4", "3"):
                    if f"{alt_base}{try_tone}" in davin_index:
                        src = davin_index[f"{alt_base}{try_tone}"]
                        source_kind = "fallback"
                        break

        if src is not None:
            data = src.read_bytes()
            if not is_valid_mp3_bytes(data):
                missing.append(syl)
                continue
            out_file.write_bytes(data)
            resolved[syl] = f"{syl}.mp3"
            if source_kind == "davinfifield":
                from_davin += 1
            elif source_kind == "hugolpz":
                from_hugo += 1
            else:
                tone_fallback += 1
        else:
            missing.append(syl)

    # Update graph.json primary audio field for every node
    for node in graph["nodes"]:
        audio_file = None
        for syl in node.get("syllables") or []:
            if syl in resolved:
                audio_file = resolved[syl]
                break
        node["audio"] = audio_file

    graph_path.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    manifest = {
        "totalRequired": len(required_syllables),
        "totalBundled": len(resolved),
        "fromDavinfifield": from_davin,
        "fromHugolpz": from_hugo,
        "toneFallback": tone_fallback,
        "missing": missing,
    }
    (audio_out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    total_bytes = sum(p.stat().st_size for p in audio_out.glob("*.mp3"))
    print(
        f"Bundled {len(resolved)}/{len(required_syllables)} Mandarin syllable MP3s "
        f"({total_bytes / (1024 * 1024):.1f} MB) | davinfifield={from_davin}, "
        f"hugolpz={from_hugo}, fallback={tone_fallback}, missing={missing}"
    )
    return manifest


if __name__ == "__main__":
    build_audio()
