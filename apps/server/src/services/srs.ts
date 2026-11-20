import { randomUUID } from "node:crypto";
import {
  computeKnownCoverage,
  getReachabilityCache,
  resolveNodeIndex,
  type GraphNode,
  type ProjectedGraph,
} from "@fuluoxiaojie/graph-engine";
import { createEmptyCard, fsrs, generatorParameters, State, type Card, type Grade } from "ts-fsrs";
import type { StaticDataStore } from "../data/staticLoader.js";
import { withTransaction, type AppDatabase } from "../db/database.js";
import type { UserSettings } from "./settings.js";

export type CardType = "recognition" | "stroke" | "component" | "listening";

export interface SrsCardRow {
  id: string;
  node_id: string;
  card_type: CardType;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
}

export interface ReviewIntervalPreview {
  rating: 1 | 2 | 3 | 4;
  label: "Again" | "Hard" | "Good" | "Easy";
  due: string;
  scheduledDays: number;
  intervalLabel: string;
}

export interface DueCardPayload {
  card: SrsCardRow;
  node: GraphNode;
  components: Array<{
    id: string;
    definition: string;
    pinyin: string[];
    role: "semantic" | "phonetic" | "structural";
    multiplicity: number;
  }>;
  componentChoices: Array<{ id: string; definition: string }>;
  listeningContext: {
    maskedWord: string;
    word: string;
    pinyin: string;
    gloss: string;
  } | null;
  listeningChoices: Array<{ id: string; pinyin: string[]; definition: string }>;
  examples: Array<{ word: string; pinyin: string; numbered: string; gloss: string }>;
  notes: string;
  previews: ReviewIntervalPreview[];
}

function rowToFsrsCard(row: SrsCardRow): Card {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

function formatInterval(now: Date, due: Date, scheduledDays: number): string {
  const diffMin = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60_000));
  if (scheduledDays >= 365) return `${(scheduledDays / 365).toFixed(1)}y`;
  if (scheduledDays >= 30) return `${Math.round(scheduledDays / 30)}mo`;
  if (scheduledDays >= 1) return `${scheduledDays}d`;
  if (diffMin >= 60) return `${Math.round(diffMin / 60)}h`;
  return `${diffMin}m`;
}

function buildScheduler(settings: UserSettings) {
  return fsrs(
    generatorParameters({
      request_retention: settings.srs.requestRetention,
      enable_fuzz: true,
    })
  );
}

function fnvHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface DistractorIndex {
  topComponents: string[];
  byBaseSyllable: Map<string, GraphNode[]>;
  commonAudioNodes: GraphNode[];
}

const distractorIndexCache = new WeakMap<ProjectedGraph, DistractorIndex>();

function getDistractorIndex(proj: ProjectedGraph): DistractorIndex {
  const cached = distractorIndexCache.get(proj);
  if (cached) return cached;

  const topComponents = proj.nodes
    .map((node, idx) => ({ id: node.id, outDeg: proj.outgoing[idx]!.length }))
    .filter((item) => item.outDeg >= 10)
    .sort((a, b) => b.outDeg - a.outDeg || (a.id < b.id ? -1 : 1))
    .slice(0, 80)
    .map((item) => item.id);

  const byBaseSyllable = new Map<string, GraphNode[]>();
  const commonAudioNodes: GraphNode[] = [];

  for (const node of proj.nodes) {
    if (node.isPrimitive || !node.audio) continue;
    const primarySyl = node.syllables[0] ?? "";
    const base = primarySyl.replace(/[1-5]$/, "");
    if (base) {
      let bucket = byBaseSyllable.get(base);
      if (!bucket) {
        bucket = [];
        byBaseSyllable.set(base, bucket);
      }
      bucket.push(node);
    }
    if ((node.freq.subtlexRank ?? 99999) <= 900) {
      commonAudioNodes.push(node);
    }
  }

  for (const bucket of byBaseSyllable.values()) {
    bucket.sort((a, b) => (a.freq.subtlexRank ?? 99999) - (b.freq.subtlexRank ?? 99999));
  }
  commonAudioNodes.sort((a, b) => (a.freq.subtlexRank ?? 99999) - (b.freq.subtlexRank ?? 99999));

  const index: DistractorIndex = { topComponents, byBaseSyllable, commonAudioNodes };
  distractorIndexCache.set(proj, index);
  return index;
}

export function getActiveEnabledModes(settings: UserSettings): CardType[] {
  const enabled = (Object.entries(settings.srs.enabledModes) as Array<[CardType, boolean]>)
    .filter(([, on]) => on)
    .map(([m]) => m);
  return enabled.length > 0 ? enabled : ["recognition"];
}

export function getApplicableCardTypes(
  store: StaticDataStore,
  nodeId: string,
  settings: UserSettings
): CardType[] {
  const proj = store.getProjection(settings.sandbox.mergeVariants);
  const idx = resolveNodeIndex(proj, nodeId);
  if (idx === undefined) return [];
  const node = proj.nodes[idx]!;
  const hasComponents = proj.incoming[idx]!.length > 0;
  const enabled = settings.srs.enabledModes;
  const types: CardType[] = [];

  if (enabled.recognition) types.push("recognition");
  if (enabled.stroke && node.hasStrokes) types.push("stroke");
  if (enabled.component && hasComponents) types.push("component");
  if (enabled.listening && !node.isPrimitive && node.audio !== null) types.push("listening");

  if (types.length === 0) types.push("recognition");
  return types;
}

export function enrollNodesInSrs(
  db: AppDatabase,
  store: StaticDataStore,
  settings: UserSettings,
  nodeIds: string[]
): { enrolledNodes: string[]; createdCards: number } {
  const proj = store.getProjection(settings.sandbox.mergeVariants);
  const now = new Date();
  const nowIso = now.toISOString();
  const emptyCard = createEmptyCard(now);

  const insertCard = db.prepare(
    `INSERT OR IGNORE INTO srs_cards
      (id, node_id, card_type, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertProgress = db.prepare(
    `INSERT INTO node_progress (node_id, status, source, notes, updated_at)
     VALUES (?, 'learning', 'srs', '', ?)
     ON CONFLICT(node_id) DO UPDATE SET
       status = CASE WHEN node_progress.status = 'unseen' THEN 'learning' ELSE node_progress.status END,
       updated_at = excluded.updated_at`
  );

  const enrolledNodes: string[] = [];
  let createdCards = 0;

  withTransaction(db, () => {
    for (const rawId of nodeIds) {
      const idx = resolveNodeIndex(proj, rawId);
      if (idx === undefined) continue;
      const canonicalId = proj.nodes[idx]!.id;
      const types = getApplicableCardTypes(store, canonicalId, settings);
      enrolledNodes.push(canonicalId);
      upsertProgress.run(canonicalId, nowIso);

      for (const ct of types) {
        const res = insertCard.run(
          randomUUID(),
          canonicalId,
          ct,
          emptyCard.due.toISOString(),
          emptyCard.stability,
          emptyCard.difficulty,
          emptyCard.elapsed_days,
          emptyCard.scheduled_days,
          emptyCard.reps,
          emptyCard.lapses,
          emptyCard.state,
          null
        );
        if (Number(res.changes) > 0) createdCards++;
      }
    }
  });

  return { enrolledNodes, createdCards };
}

/**
 * Build multiple-choice component distractors while excluding ALL recursive sub-components of target
 * (prevents e.g. 月 inside 青 inside 晴 from appearing as a "wrong" distractor).
 */
export function buildComponentChoices(
  proj: ProjectedGraph,
  targetIdx: number,
  trueComponentIds: string[]
): Array<{ id: string; definition: string }> {
  const targetId = proj.nodes[targetIdx]!.id;
  const cache = getReachabilityCache(proj);
  const excludedIds = new Set<string>([targetId, ...trueComponentIds]);
  const start = cache.prereqOffsets[targetIdx]!;
  const end = cache.prereqOffsets[targetIdx + 1]!;
  for (let p = start; p < end; p++) {
    excludedIds.add(proj.nodes[cache.prereqIndices[p]!]!.id);
  }

  const choices: Array<{ id: string; definition: string }> = [];
  for (const cid of trueComponentIds) {
    const idx = proj.idToIndex.get(cid);
    if (idx !== undefined) {
      choices.push({ id: cid, definition: proj.nodes[idx]!.definition });
    }
  }

  const targetCount = Math.min(8, Math.max(5, trueComponentIds.length + 4));
  const { topComponents } = getDistractorIndex(proj);
  const pool = topComponents.filter((id) => !excludedIds.has(id));
  const seed = fnvHash(`comp:${targetId}`);
  const ranked = pool
    .map((id, i) => ({ id, k: fnvHash(`${seed}:${i}:${id}`) }))
    .sort((a, b) => a.k - b.k);

  for (const item of ranked) {
    if (choices.length >= targetCount) break;
    const idx = proj.idToIndex.get(item.id)!;
    choices.push({ id: item.id, definition: proj.nodes[idx]!.definition });
  }

  choices.sort((a, b) => fnvHash(`${seed}:out:${a.id}`) - fnvHash(`${seed}:out:${b.id}`));
  return choices;
}

/**
 * Build solvable listening choices: prioritize DIFFERENT TONES of the same base syllable,
 * then distinct common syllables, strictly excluding exact homophones (same syllable/audio).
 */
export function buildListeningChoices(
  proj: ProjectedGraph,
  node: GraphNode
): Array<{ id: string; pinyin: string[]; definition: string }> {
  const { byBaseSyllable, commonAudioNodes } = getDistractorIndex(proj);
  const primarySyl = node.syllables[0] ?? "";
  const baseNoTone = primarySyl.replace(/[1-5]$/, "");
  const targetAudio = node.audio;
  const seed = fnvHash(`listen:${node.id}`);

  const isExactHomophone = (cand: GraphNode): boolean => {
    const cSyl = cand.syllables[0] ?? "";
    if (primarySyl && cSyl === primarySyl) return true;
    if (targetAudio && cand.audio === targetAudio) return true;
    return false;
  };

  // Tier 1: same base syllable with a DIFFERENT tone (optimal tone-pair discrimination, 100% solvable)
  const sameBaseDiffTone: GraphNode[] = [];
  const usedTones = new Set<string>([primarySyl]);
  for (const cand of byBaseSyllable.get(baseNoTone) ?? []) {
    if (cand.id === node.id || isExactHomophone(cand)) continue;
    const cSyl = cand.syllables[0] ?? "";
    if (!usedTones.has(cSyl)) {
      usedTones.add(cSyl);
      sameBaseDiffTone.push(cand);
    }
  }

  // Tier 2: common characters with distinct syllables/audio
  const distinctCommon = commonAudioNodes
    .filter((cand) => cand.id !== node.id && !isExactHomophone(cand))
    .map((cand) => ({ cand, k: fnvHash(`${seed}:${cand.id}`) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.cand);

  const distractors: GraphNode[] = [];
  for (const cand of [...sameBaseDiffTone.slice(0, 3), ...distinctCommon]) {
    if (distractors.length >= 3) break;
    if (!distractors.some((d) => d.id === cand.id)) {
      distractors.push(cand);
    }
  }

  const all = [node, ...distractors].map((n) => ({
    id: n.id,
    pinyin: n.pinyin,
    definition: n.definition,
  }));
  all.sort((a, b) => fnvHash(`${seed}:lout:${a.id}`) - fnvHash(`${seed}:lout:${b.id}`));
  return all;
}

function getIgnoredCanonicalSet(db: AppDatabase, proj: ProjectedGraph): Set<string> {
  const rows = db
    .prepare("SELECT node_id FROM node_progress WHERE status = 'ignored'")
    .all() as Array<{ node_id: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    const idx = resolveNodeIndex(proj, r.node_id);
    if (idx !== undefined) out.add(proj.nodes[idx]!.id);
  }
  return out;
}

export function getDueQueue(
  db: AppDatabase,
  store: StaticDataStore,
  settings: UserSettings,
  modeFilter?: CardType,
  limit = 30
): { dueCount: number; cards: DueCardPayload[] } {
  const now = new Date();
  const nowIso = now.toISOString();
  const activeModes = modeFilter ? [modeFilter] : getActiveEnabledModes(settings);
  const placeholders = activeModes.map(() => "?").join(", ");

  const allDueRows = db
    .prepare(
      `SELECT * FROM srs_cards
       WHERE due <= ? AND card_type IN (${placeholders})
       ORDER BY due ASC, state DESC`
    )
    .all(nowIso, ...activeModes) as unknown as SrsCardRow[];

  const scheduler = buildScheduler(settings);
  const proj = store.getProjection(settings.sandbox.mergeVariants);
  const ignoredSet = getIgnoredCanonicalSet(db, proj);
  const notesStmt = db.prepare("SELECT notes FROM node_progress WHERE node_id = ?");
  const cappedLimit = Math.max(1, Math.min(200, limit));

  const seenMergedKeys = new Set<string>();
  const filteredRows: Array<{ row: SrsCardRow; idx: number; node: GraphNode }> = [];

  for (const row of allDueRows) {
    const idx = resolveNodeIndex(proj, row.node_id);
    if (idx === undefined) continue;
    const node = proj.nodes[idx]!;
    if (ignoredSet.has(node.id)) continue;

    // Deduplicate cards that collapse to the same (canonicalId, card_type) under mergeVariants=true
    const dedupKey = `${node.id}:${row.card_type}`;
    if (seenMergedKeys.has(dedupKey)) continue;
    seenMergedKeys.add(dedupKey);
    filteredRows.push({ row, idx, node });
  }

  const cards: DueCardPayload[] = [];
  for (const { row, idx, node } of filteredRows.slice(0, cappedLimit)) {
    const inc = proj.incoming[idx]!;
    const components = inc.map((e) => {
      const src = proj.nodes[e.sourceIdx]!;
      return {
        id: src.id,
        definition: src.definition,
        pinyin: src.pinyin,
        role: e.role,
        multiplicity: e.multiplicity,
      };
    });

    const examples = (store.examples[node.id] ?? []).slice(0, 5);
    const firstEx = examples[0];
    const listeningContext =
      row.card_type === "listening" && firstEx
        ? {
            word: firstEx.word,
            maskedWord: firstEx.word.split(node.id).join("＿"),
            pinyin: firstEx.pinyin,
            gloss: firstEx.gloss,
          }
        : null;

    // Look up notes on canonical ID first, falling back to raw row.node_id
    const canonNote = (notesStmt.get(node.id) as { notes: string } | undefined)?.notes ?? "";
    const rawNote =
      !canonNote && row.node_id !== node.id
        ? ((notesStmt.get(row.node_id) as { notes: string } | undefined)?.notes ?? "")
        : "";
    const notes = canonNote || rawNote;

    const fsrsCard = rowToFsrsCard(row);
    const repeated = scheduler.repeat(fsrsCard, now);
    const ratings: Array<{ r: 1 | 2 | 3 | 4; label: ReviewIntervalPreview["label"] }> = [
      { r: 1, label: "Again" },
      { r: 2, label: "Hard" },
      { r: 3, label: "Good" },
      { r: 4, label: "Easy" },
    ];
    const previews: ReviewIntervalPreview[] = ratings.map(({ r, label }) => {
      const nextCard = repeated[r as Grade].card;
      return {
        rating: r,
        label,
        due: nextCard.due.toISOString(),
        scheduledDays: nextCard.scheduled_days,
        intervalLabel: formatInterval(now, nextCard.due, nextCard.scheduled_days),
      };
    });

    cards.push({
      card: row,
      node,
      components,
      componentChoices:
        row.card_type === "component"
          ? buildComponentChoices(
              proj,
              idx,
              components.map((c) => c.id)
            )
          : [],
      listeningContext,
      listeningChoices: row.card_type === "listening" ? buildListeningChoices(proj, node) : [],
      examples,
      notes,
      previews,
    });
  }

  return { dueCount: filteredRows.length, cards };
}

export function submitCardReview(
  db: AppDatabase,
  store: StaticDataStore,
  settings: UserSettings,
  cardId: string,
  rating: 1 | 2 | 3 | 4,
  durationMs = 0
): { card: SrsCardRow; promotedToKnown: boolean } | null {
  const row = db.prepare("SELECT * FROM srs_cards WHERE id = ?").get(cardId) as SrsCardRow | undefined;
  if (!row) return null;

  const now = new Date();
  const nowIso = now.toISOString();
  const scheduler = buildScheduler(settings);
  const currentCard = rowToFsrsCard(row);
  const scheduled = scheduler.repeat(currentCard, now)[rating as Grade];
  const next = scheduled.card;

  const updatedRow: SrsCardRow = {
    ...row,
    due: next.due.toISOString(),
    stability: next.stability,
    difficulty: next.difficulty,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    reps: next.reps,
    lapses: next.lapses,
    state: next.state,
    last_review: next.last_review ? next.last_review.toISOString() : nowIso,
  };

  const proj = store.getProjection(settings.sandbox.mergeVariants);
  const canonIdx = resolveNodeIndex(proj, updatedRow.node_id);
  const targetNodeId = canonIdx !== undefined ? proj.nodes[canonIdx]!.id : updatedRow.node_id;

  let promotedToKnown = false;
  const stabilityThreshold = Math.max(0.5, settings.srs.masteryStabilityDays);

  withTransaction(db, () => {
    db.prepare(
      `UPDATE srs_cards
       SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?,
           reps = ?, lapses = ?, state = ?, last_review = ?
       WHERE id = ?`
    ).run(
      updatedRow.due,
      updatedRow.stability,
      updatedRow.difficulty,
      updatedRow.elapsed_days,
      updatedRow.scheduled_days,
      updatedRow.reps,
      updatedRow.lapses,
      updatedRow.state,
      updatedRow.last_review,
      updatedRow.id
    );

    db.prepare(
      `INSERT INTO review_logs (id, card_id, node_id, card_type, rating, duration_ms, reviewed_at, fsrs_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      updatedRow.id,
      targetNodeId,
      updatedRow.card_type,
      rating,
      Math.max(0, Math.min(600_000, Math.round(durationMs))),
      nowIso,
      JSON.stringify({
        stability: updatedRow.stability,
        difficulty: updatedRow.difficulty,
        scheduled_days: updatedRow.scheduled_days,
        state: updatedRow.state,
      })
    );

    const isMasteryCard =
      updatedRow.card_type === "recognition" || !settings.srs.enabledModes.recognition;
    if (
      isMasteryCard &&
      updatedRow.state === State.Review &&
      updatedRow.stability >= stabilityThreshold
    ) {
      const prog = db
        .prepare("SELECT status FROM node_progress WHERE node_id = ?")
        .get(targetNodeId) as { status: string } | undefined;
      // Never overwrite explicitly ignored or already-known nodes
      if (!prog || (prog.status !== "known" && prog.status !== "ignored")) {
        db.prepare(
          `INSERT INTO node_progress (node_id, status, source, notes, updated_at)
           VALUES (?, 'known', 'srs', '', ?)
           ON CONFLICT(node_id) DO UPDATE SET status = 'known', source = 'srs', updated_at = excluded.updated_at`
        ).run(targetNodeId, nowIso);
        promotedToKnown = true;
      }
    }
  });

  return { card: updatedRow, promotedToKnown };
}

export function getSrsStats(db: AppDatabase, store: StaticDataStore, settings: UserSettings) {
  const now = new Date();
  const nowIso = now.toISOString();
  const todayPrefix = nowIso.slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const forecastEnd = new Date(now.getTime() + 14 * 86_400_000).toISOString();

  const activeModes = getActiveEnabledModes(settings);
  const placeholders = activeModes.map(() => "?").join(", ");
  const proj = store.getProjection(settings.sandbox.mergeVariants);
  const ignoredSet = getIgnoredCanonicalSet(db, proj);

  const totalReviewsRow = db.prepare("SELECT COUNT(*) AS cnt FROM review_logs").get() as { cnt: number };
  const todayReviewsRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM review_logs WHERE reviewed_at >= ?")
    .get(`${todayPrefix}T00:00:00.000Z`) as { cnt: number };

  const retentionRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS passed
       FROM review_logs WHERE reviewed_at >= ?`
    )
    .get(thirtyDaysAgo) as { total: number; passed: number | null };

  const total30 = Number(retentionRow?.total ?? 0);
  const passed30 = Number(retentionRow?.passed ?? 0);
  const retentionRatePct = total30 > 0 ? Math.round((passed30 / total30) * 1000) / 10 : null;

  // Filter active cards by enabledModes, exclude ignored nodes, and deduplicate merged variants
  const cardRows = db
    .prepare(`SELECT node_id, card_type, state, due FROM srs_cards WHERE card_type IN (${placeholders}) ORDER BY due ASC`)
    .all(...activeModes) as Array<{ node_id: string; card_type: CardType; state: number; due: string }>;

  const states = { new: 0, learning: 0, review: 0, relearning: 0 };
  let dueNow = 0;
  const forecastMap = new Map<string, number>();
  const seenCardKeys = new Set<string>();

  for (const r of cardRows) {
    const idx = resolveNodeIndex(proj, r.node_id);
    if (idx === undefined) continue;
    const canonId = proj.nodes[idx]!.id;
    if (ignoredSet.has(canonId)) continue;
    const key = `${canonId}:${r.card_type}`;
    if (seenCardKeys.has(key)) continue;
    seenCardKeys.add(key);

    if (r.state === State.New) states.new++;
    else if (r.state === State.Learning) states.learning++;
    else if (r.state === State.Review) states.review++;
    else if (r.state === State.Relearning) states.relearning++;

    if (r.due <= nowIso) dueNow++;
    if (r.due <= forecastEnd) {
      // Clamp overdue dates to today so forecast14d strictly spans [today .. today+14d]
      const rawDay = r.due.slice(0, 10);
      const bucketDay = rawDay < todayPrefix ? todayPrefix : rawDay;
      forecastMap.set(bucketDay, (forecastMap.get(bucketDay) ?? 0) + 1);
    }
  }

  const heatmapRows = db
    .prepare(
      `SELECT substr(reviewed_at, 1, 10) AS day,
              COUNT(*) AS count,
              SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS again_count
       FROM review_logs
       WHERE reviewed_at >= ?
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(ninetyDaysAgo) as Array<{ day: string; count: number; again_count: number }>;

  const progRows = db
    .prepare("SELECT node_id, status FROM node_progress WHERE status IN ('known', 'learning')")
    .all() as Array<{ node_id: string; status: string }>;

  const knownCanonical = new Set<string>();
  const learningCanonical = new Set<string>();
  for (const r of progRows) {
    const idx = resolveNodeIndex(proj, r.node_id);
    if (idx === undefined) continue;
    const cid = proj.nodes[idx]!.id;
    if (r.status === "known") knownCanonical.add(cid);
    else if (r.status === "learning") learningCanonical.add(cid);
  }
  for (const cid of knownCanonical) learningCanonical.delete(cid);

  const coverage = computeKnownCoverage(proj, knownCanonical);

  const forecast14d = Array.from(forecastMap.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, count]) => ({ date, count }));

  return {
    totalReviews: Number(totalReviewsRow?.cnt ?? 0),
    todayReviews: Number(todayReviewsRow?.cnt ?? 0),
    dueNow,
    retentionRate30dPct: retentionRatePct,
    learningNodes: learningCanonical.size,
    cardStates: states,
    heatmap: heatmapRows.map((r) => ({
      date: r.day,
      count: Number(r.count),
      againCount: Number(r.again_count),
    })),
    forecast14d,
    coverage,
  };
}
