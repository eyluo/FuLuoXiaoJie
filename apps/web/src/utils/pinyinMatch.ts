export interface ParsedPinyin {
  base: string;
  tone: number | null; // 1..5 or null if unmarked
}

export interface PinyinMatchResult {
  status: "empty" | "exact" | "tone-close" | "wrong";
  matchedReading?: string;
}

const COMBINING_TONE_MAP: Record<string, number> = {
  "\u0304": 1, // combining macron (ā, m̄)
  "\u0301": 2, // combining acute (á, ń, ḿ)
  "\u030c": 3, // combining caron (ǎ, ň)
  "\u0300": 4, // combining grave (à, ǹ, m̀)
};

function normalizeBase(raw: string): string {
  // Canonicalize u:, uu (audio convention), and ü -> v
  let s = raw.replace(/u:/g, "v").replace(/ü/g, "v");
  // Convert audio-style uu after l/n (e.g. nuu -> nv, luue -> lve)
  s = s.replace(/^([ln])uu/, "$1v");
  // After j/q/x/y, ü/v is standardly written as u
  s = s.replace(/^([jqxy])v/, "$1u");
  // Neutralize standalone erhua shorthand "r" -> "er"
  if (s === "r") s = "er";
  return s;
}

/**
 * Parse a single Mandarin pinyin syllable in either tone-marked ("qǐng", "lǜ", "m̄", "de")
 * or numbered ("qing3", "lv4", "nu:3", "de5") notation into a canonical (base, tone) pair.
 * Uses NFD decomposition to support all combining diacritics (including m̄, m̀, lu\u0304\u0308)
 * and rejects conflicting or duplicate tone markers (e.g. "qīng3", "māá").
 */
export function parsePinyinSyllable(raw: string): ParsedPinyin | null {
  const cleaned = raw.trim().toLowerCase().replace(/[\s'’]+/g, "");
  if (!cleaned) return null;

  let trailingTone: number | null = null;
  let body = cleaned;

  const trailingMatch = body.match(/([1-5])$/);
  if (trailingMatch) {
    trailingTone = Number(trailingMatch[1]);
    body = body.slice(0, -1);
  }

  let markTone: number | null = null;
  const letters: string[] = [];

  for (const ch of body.normalize("NFD")) {
    const toneVal = COMBINING_TONE_MAP[ch];
    if (toneVal !== undefined) {
      // Reject duplicate tone diacritics (e.g. "māá")
      if (markTone !== null) return null;
      markTone = toneVal;
      continue;
    }

    if (ch === "\u0308") {
      // Combining diaeresis on 'u' -> 'v' (handles both u\u0308\u0304 and u\u0304\u0308)
      if (letters.length === 0 || letters[letters.length - 1] !== "u") return null;
      letters[letters.length - 1] = "v";
      continue;
    }

    if (ch === "\u0302") {
      // Combining circumflex on 'e' (ê)
      if (letters.length === 0 || letters[letters.length - 1] !== "e") return null;
      continue;
    }

    if ((ch >= "a" && ch <= "z") || ch === ":") {
      letters.push(ch);
      continue;
    }

    return null;
  }

  // Reject contradictory or mixed tone-mark + trailing-digit inputs (e.g. "qīng3")
  if (markTone !== null && trailingTone !== null) {
    return null;
  }

  const base = normalizeBase(letters.join(""));
  if (!base || !/^[a-zv]+$/.test(base)) return null;
  return { base, tone: markTone ?? trailingTone };
}

/**
 * Match a learner's typed pinyin answer against all valid readings of a character node.
 * Neutral tone (5) matches both explicit `5` and toneless input (e.g. "de" or "de5").
 */
export function matchPinyinAnswer(
  input: string,
  nodePinyin: string[],
  nodeSyllables: string[]
): PinyinMatchResult {
  if (!input.trim()) return { status: "empty" };
  const parsedInput = parsePinyinSyllable(input);
  if (!parsedInput) return { status: "wrong" };

  const targets: Array<{ display: string; parsed: ParsedPinyin }> = [];
  const count = Math.max(nodePinyin.length, nodeSyllables.length);
  for (let i = 0; i < count; i++) {
    const display = nodePinyin[i] ?? nodeSyllables[i] ?? "";
    const parsedFromSyl = nodeSyllables[i] ? parsePinyinSyllable(nodeSyllables[i]!) : null;
    const parsedFromPy = nodePinyin[i] ? parsePinyinSyllable(nodePinyin[i]!) : null;
    const target = parsedFromSyl ?? parsedFromPy;
    if (target) {
      // Unmarked target pinyin (e.g. "de") represents neutral tone 5
      const normalizedTarget: ParsedPinyin = {
        base: target.base,
        tone: target.tone ?? 5,
      };
      targets.push({
        display: display || `${normalizedTarget.base}${normalizedTarget.tone}`,
        parsed: normalizedTarget,
      });
    }
  }

  // Pass 1: exact syllable + exact tone
  for (const t of targets) {
    if (t.parsed.base !== parsedInput.base) continue;
    if (t.parsed.tone === parsedInput.tone) {
      return { status: "exact", matchedReading: t.display };
    }
    // Neutral tone (5) matches unmarked user input ("de" == "de5")
    if (t.parsed.tone === 5 && parsedInput.tone === null) {
      return { status: "exact", matchedReading: t.display };
    }
  }

  // Pass 2: right syllable, wrong or omitted tone
  for (const t of targets) {
    if (t.parsed.base === parsedInput.base) {
      return { status: "tone-close", matchedReading: t.display };
    }
  }

  return { status: "wrong" };
}

/**
 * Extract unique single-character candidate tokens from a CSV, TSV, newline, or freeform text string.
 */
export function parseImportedCharacters(raw: string): string[] {
  const seen = new Set<string>();
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) continue;
    seen.add(ch);
  }
  return Array.from(seen);
}

export interface HeatmapDayCell {
  date: string;
  count: number;
  againCount: number;
  weekIndex: number;
  dayOfWeek: number; // 0 = Sun .. 6 = Sat
}

function getUtcTodayDate(todayUtc?: string): Date {
  if (todayUtc) return new Date(`${todayUtc}T00:00:00.000Z`);
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Build a contiguous 13-week UTC calendar grid ending on `todayUtc` (YYYY-MM-DD)
 * so the review activity heatmap always renders complete weeks without gaps.
 */
export function buildHeatmapGrid(
  entries: Array<{ date: string; count: number; againCount: number }>,
  todayUtc?: string
): HeatmapDayCell[] {
  const map = new Map<string, { count: number; againCount: number }>();
  for (const e of entries) {
    map.set(e.date, { count: e.count, againCount: e.againCount });
  }

  const endDate = getUtcTodayDate(todayUtc);
  const endDow = endDate.getUTCDay();
  const totalDays = 12 * 7 + endDow + 1;
  const startMs = endDate.getTime() - (totalDays - 1) * 86_400_000;

  const cells: HeatmapDayCell[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startMs + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    const found = map.get(iso);
    cells.push({
      date: iso,
      count: found?.count ?? 0,
      againCount: found?.againCount ?? 0,
      weekIndex: Math.floor(i / 7),
      dayOfWeek: d.getUTCDay(),
    });
  }
  return cells;
}

/**
 * Fill a contiguous 14-day UTC forecast series starting at `todayUtc`,
 * clamping any overdue dates (< todayUtc) into Today so no due cards are dropped.
 */
export function fillForecast14d(
  entries: Array<{ date: string; count: number }>,
  todayUtc?: string
): Array<{ date: string; label: string; count: number }> {
  const base = getUtcTodayDate(todayUtc);
  const baseIso = base.toISOString().slice(0, 10);

  const map = new Map<string, number>();
  for (const e of entries) {
    const bucket = e.date < baseIso ? baseIso : e.date;
    map.set(bucket, (map.get(bucket) ?? 0) + e.count);
  }

  const out: Array<{ date: string; label: string; count: number }> = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    out.push({
      date: iso,
      label: i === 0 ? "Today" : iso.slice(5),
      count: map.get(iso) ?? 0,
    });
  }
  return out;
}

/**
 * Trigger a safe client-side file download from a Blob and revoke the temporary Object URL cleanly.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
