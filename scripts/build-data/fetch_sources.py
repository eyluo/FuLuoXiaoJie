"""Download and cache open-source Mandarin datasets and audio packs."""

from __future__ import annotations

import gzip
import os
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT_DIR / ".cache" / "sources"

# Pinned GitHub commits for reproducible builds (CC-CEDICT uses MDBG's rolling release URL below)
SHAS = {
    "makemeahanzi": "bddc96d41bef78427ed0e034e9f7e31d71fd1b92",
    "cjkvi_ids": "86b4d16159f0079437870408f0ca186e529015db",
    "hsk30": "4ff9e3915ce87baaecd7ebe263085573a4ea3192",
    "nieldlr_hanzi": "5588d57964883bcf9bd63a2938be3eaa3641f99b",
    "davinfifield_audio": "aa25ecce7b7fb02757b2c2b8e3c01aa975812edc",
    "hugolpz_audio": "f759a0f18f27690742957619e1248ed91e9b3f2c",
}

TEXT_SOURCES: dict[str, str] = {
    "mmh_dictionary.txt": f"https://raw.githubusercontent.com/skishore/makemeahanzi/{SHAS['makemeahanzi']}/dictionary.txt",
    "mmh_graphics.txt": f"https://raw.githubusercontent.com/skishore/makemeahanzi/{SHAS['makemeahanzi']}/graphics.txt",
    "cjkvi_ids.txt": f"https://raw.githubusercontent.com/cjkvi/cjkvi-ids/{SHAS['cjkvi_ids']}/ids.txt",
    "hsk30_chars.csv": f"https://raw.githubusercontent.com/ivankra/hsk30/{SHAS['hsk30']}/hsk30-chars.csv",
    "subtlex_chr.tsv": f"https://raw.githubusercontent.com/nieldlr/hanzi/{SHAS['nieldlr_hanzi']}/lib/data/SUBTLEX-CH-CHR",
    "subtlex_wf.tsv": f"https://raw.githubusercontent.com/nieldlr/hanzi/{SHAS['nieldlr_hanzi']}/lib/data/SUBTLEX-CH-WF",
    "junda_freq.js": f"https://raw.githubusercontent.com/nieldlr/hanzi/{SHAS['nieldlr_hanzi']}/lib/data/frequencyjunda.txt.js",
    "radical_meanings.js": f"https://raw.githubusercontent.com/nieldlr/hanzi/{SHAS['nieldlr_hanzi']}/lib/data/radicalListWithMeaning.js",
    # Rolling upstream release from MDBG CC-CEDICT
    "cedict_ts.u8.gz": "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
}

AUDIO_TARBALLS: dict[str, tuple[str, str]] = {
    "davinfifield_mp3": (
        f"https://codeload.github.com/davinfifield/mp3-chinese-pinyin-sound/tar.gz/{SHAS['davinfifield_audio']}",
        "/mp3/",
    ),
    "hugolpz_words_mp3": (
        f"https://codeload.github.com/hugolpz/audio-cmn/tar.gz/{SHAS['hugolpz_audio']}",
        "/24k-abr/hsk/",
    ),
}

MAX_AUDIO_MEMBER_BYTES = 5 * 1024 * 1024


def download_file(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  [cache] {dest.name} ({dest.stat().st_size:,} bytes)")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  [fetch] {dest.name} <- {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "FuLuoXiaoJie-ETL/1.0"})
    tmp_path: Path | None = None
    try:
        with (
            urllib.request.urlopen(req, timeout=120) as resp,
            tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as tmp,
        ):
            tmp_path = Path(tmp.name)
            shutil.copyfileobj(resp, tmp)
        os.replace(tmp_path, dest)
        tmp_path = None
        print(f"          saved {dest.stat().st_size:,} bytes")
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def extract_cedict(gz_path: Path, out_path: Path) -> None:
    if out_path.exists() and out_path.stat().st_size > 0:
        return
    print(f"  [gunzip] {gz_path.name} -> {out_path.name}")
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=out_path.parent, delete=False) as tmp:
            tmp_path = Path(tmp.name)
            with gzip.open(gz_path, "rb") as src:
                shutil.copyfileobj(src, tmp)
        os.replace(tmp_path, out_path)
        tmp_path = None
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def fetch_audio_pack(name: str, url: str, subdir_marker: str) -> Path:
    out_dir = CACHE_DIR / "audio_packs" / name
    sentinel = out_dir / ".complete"
    if sentinel.exists():
        count = len(list(out_dir.glob("*.mp3")))
        print(f"  [cache] audio pack {name} ({count} mp3 files)")
        return out_dir

    tar_path = CACHE_DIR / f"{name}.tar.gz"
    download_file(url, tar_path)

    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir_resolved = out_dir.resolve()
    extracted = 0
    print(f"  [extract] {name} (filtering '{subdir_marker}')")
    with tarfile.open(tar_path, "r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            if subdir_marker not in member.name or not member.name.endswith(".mp3"):
                continue
            if member.size <= 0 or member.size > MAX_AUDIO_MEMBER_BYTES:
                continue
            filename = Path(member.name).name
            if not filename or filename.startswith(".") or "/" in filename or "\\" in filename:
                continue
            target_path = (out_dir / filename).resolve()
            if target_path.parent != out_dir_resolved:
                raise ValueError(f"Unsafe tar member path rejected: {member.name!r}")
            src_f = tf.extractfile(member)
            if src_f is None:
                continue
            tmp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(dir=out_dir, delete=False) as tmp:
                    tmp_path = Path(tmp.name)
                    shutil.copyfileobj(src_f, tmp)
                os.replace(tmp_path, target_path)
                tmp_path = None
                extracted += 1
            finally:
                if tmp_path is not None and tmp_path.exists():
                    tmp_path.unlink(missing_ok=True)
    sentinel.write_text(f"{extracted}\n", encoding="utf-8")
    print(f"          extracted {extracted} mp3 files into {out_dir}")
    if tar_path.exists():
        tar_path.unlink()
    return out_dir


def fetch_all() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print("Fetching open Mandarin text datasets...")
    for filename, url in TEXT_SOURCES.items():
        download_file(url, CACHE_DIR / filename)

    extract_cedict(CACHE_DIR / "cedict_ts.u8.gz", CACHE_DIR / "cedict_ts.u8")

    print("Fetching open-source Mandarin syllable audio packs...")
    for name, (url, marker) in AUDIO_TARBALLS.items():
        fetch_audio_pack(name, url, marker)


if __name__ == "__main__":
    fetch_all()
