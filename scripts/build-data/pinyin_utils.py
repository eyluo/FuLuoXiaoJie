"""Pinyin tone-mark and numbered-syllable normalization helpers."""

from __future__ import annotations

import re
import unicodedata

COMBINING_TONE_MAP: dict[str, int] = {
    "\u0304": 1,  # macron
    "\u0301": 2,  # acute
    "\u030c": 3,  # caron
    "\u0300": 4,  # grave
}

TONE_VOWELS: dict[str, tuple[str, str, str, str, str]] = {
    "a": ("a", "ā", "á", "ǎ", "à"),
    "e": ("e", "ē", "é", "ě", "è"),
    "i": ("i", "ī", "í", "ǐ", "ì"),
    "o": ("o", "ō", "ó", "ǒ", "ò"),
    "u": ("u", "ū", "ú", "ǔ", "ù"),
    "v": ("ü", "ǖ", "ǘ", "ǚ", "ǜ"),
}

SYLLABIC_TONES: dict[str, tuple[str, str, str, str, str]] = {
    "m": ("m", "m\u0304", "ḿ", "m\u030c", "m\u0300"),
    "n": ("n", "n\u0304", "ń", "ň", "ǹ"),
    "ng": ("ng", "n\u0304g", "ńg", "ňg", "ǹg"),
}


def _normalize_jqxy_v(base: str) -> str:
    """Normalize Mandarin ü orthography: j/q/x/y+v -> u, and lue/nue -> lve/nve."""
    if base.startswith(("j", "q", "x", "y")) and "v" in base:
        return base.replace("v", "u")
    if base in ("lue", "nue"):
        return base[0] + "ve"
    return base


def toned_to_numbered(pinyin: str) -> str:
    """Convert toned pinyin (NFC or NFD, including ü/ê/m/n/ng) to canonical numbered form."""
    s = pinyin.strip().lower()
    if not s:
        return ""
    s = s.replace("u:", "v")

    # Fast path for already-numbered syllables (e.g., 'lv3', 'qing3', 'ü3')
    s_nfc = unicodedata.normalize("NFC", s).replace("ü", "v")
    m = re.fullmatch(r"([a-zv]+)([1-5])", s_nfc)
    if m:
        base = _normalize_jqxy_v(m.group(1))
        tone = int(m.group(2))
        return f"{base}{tone}"

    # NFD decomposition cleanly handles precomposed, NFD combining marks, ü + tone, and ê + tone
    decomposed = unicodedata.normalize("NFD", s)
    tone = 5
    out_chars: list[str] = []
    for ch in decomposed:
        if ch == "\u0308":  # combining diaeresis (u + ¨ -> v)
            if out_chars and out_chars[-1] == "u":
                out_chars[-1] = "v"
        elif ch in COMBINING_TONE_MAP:
            tone = COMBINING_TONE_MAP[ch]
        elif ch == "\u0302":  # circumflex on ê -> base 'e'
            continue
        elif "a" <= ch <= "z":
            out_chars.append(ch)

    base = _normalize_jqxy_v("".join(out_chars))
    if not base:
        return ""
    return f"{base}{tone}"


def numbered_to_toned(numbered: str) -> str:
    """Convert canonical numbered pinyin ('lv3', 'qing3', 'm2', 'de5') to toned pinyin."""
    s = unicodedata.normalize("NFC", numbered.strip().lower()).replace("u:", "v").replace("ü", "v")
    m = re.fullmatch(r"([a-zv]+)([1-5])?", s)
    if not m:
        return numbered
    base = _normalize_jqxy_v(m.group(1))
    tone = int(m.group(2)) if m.group(2) else 5

    if base in SYLLABIC_TONES:
        return SYLLABIC_TONES[base][0 if tone == 5 else tone]

    if tone == 5:
        return base.replace("v", "ü")

    # Standard Mandarin tone placement rules:
    # 1. 'a' or 'e' always takes the tone mark.
    # 2. In 'ou', 'o' takes the mark.
    # 3. Otherwise, the last vowel takes the mark.
    target_idx = -1
    for vowel in ("a", "e"):
        idx = base.find(vowel)
        if idx != -1:
            target_idx = idx
            break
    if target_idx == -1:
        ou_idx = base.find("ou")
        if ou_idx != -1:
            target_idx = ou_idx
    if target_idx == -1:
        for idx in range(len(base) - 1, -1, -1):
            if base[idx] in TONE_VOWELS:
                target_idx = idx
                break

    if target_idx == -1:
        return base.replace("v", "ü")

    chars = list(base)
    v = chars[target_idx]
    chars[target_idx] = TONE_VOWELS[v][tone]
    return "".join(ch if ch != "v" else "ü" for ch in chars)


def cedict_pinyin_to_toned(raw: str) -> str:
    """Convert space-separated CC-CEDICT numbered pinyin like 'xue2 xi2' to 'xué xí'."""
    parts = raw.strip().split()
    return " ".join(numbered_to_toned(p) for p in parts if p)


def cedict_pinyin_to_numbered(raw: str) -> str:
    """Normalize CC-CEDICT numbered pinyin like 'lu:3 xing2' to 'lv3 xing2'."""
    parts = raw.strip().split()
    out = []
    for p in parts:
        n = toned_to_numbered(p)
        if n:
            out.append(n)
    return " ".join(out)


SINGLE_SYLLABLE_RE = re.compile(
    r"^(?:(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?[aeiouv]+(?:ng|n|r)?|m|n|ng|hng|r)[1-5]$"
)


def is_valid_mandarin_syllable(numbered: str) -> bool:
    """Return True if string is a valid single numbered Mandarin syllable (rejects multi-syllable typos like gege5)."""
    return bool(SINGLE_SYLLABLE_RE.fullmatch(numbered))
