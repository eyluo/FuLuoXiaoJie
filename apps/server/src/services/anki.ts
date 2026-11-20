import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveNodeIndex, type GraphNode } from "@fuluoxiaojie/graph-engine";
import { zipSync, type Zippable } from "fflate";
import type { StaticDataStore } from "../data/staticLoader.js";

export interface ExportRow {
  character: string;
  pinyin: string;
  meaning: string;
  components: string;
  etymology: string;
  examples: string;
  audioFile: string | null;
  hskTag: string;
  tags: string;
}

function escapeCsvCell(raw: string): string {
  // Guard spreadsheets against leading formula characters without mutating Anki [sound:...] syntax
  let val = raw;
  if (/^[=+\-@\t\r]/.test(val)) {
    val = `'${val}`;
  }
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function buildExportRows(
  store: StaticDataStore,
  nodeIds: string[],
  mergeVariants: boolean
): ExportRow[] {
  const proj = store.getProjection(mergeVariants);
  const seen = new Set<string>();
  const rows: ExportRow[] = [];

  for (const rawId of nodeIds) {
    const idx = resolveNodeIndex(proj, rawId);
    if (idx === undefined) continue;
    const node: GraphNode = proj.nodes[idx]!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);

    const parts = proj.incoming[idx]!.map((e) => {
      const partNode = proj.nodes[e.sourceIdx]!;
      const multStr = e.multiplicity > 1 ? `×${e.multiplicity}` : "";
      const roleTag = e.role === "structural" ? "" : ` [${e.role}]`;
      return `${partNode.id}${multStr} (${partNode.definition})${roleTag}`;
    });

    const etymText = node.etymology?.hint
      ? `${node.etymology.type}: ${node.etymology.hint}`
      : node.etymology
        ? node.etymology.type
        : "";

    const exList = (store.examples[node.id] ?? [])
      .slice(0, 3)
      .map((ex) => `${ex.word} (${ex.pinyin}) — ${ex.gloss}`);

    const hskTag = node.hskLevel ? `HSK${node.hskLevel === 7 ? "7-9" : node.hskLevel}` : "";
    const tagList = ["FuLuoXiaoJie", node.isPrimitive ? "primitive" : "character"];
    if (hskTag) tagList.push(hskTag);

    rows.push({
      character: node.id,
      pinyin: node.pinyin.join(" / "),
      meaning: node.definition,
      components: parts.join("; "),
      etymology: etymText,
      examples: exList.join(" | "),
      audioFile: node.audio,
      hskTag,
      tags: tagList.join(" "),
    });
  }

  return rows;
}

export function generateAnkiCsv(
  store: StaticDataStore,
  nodeIds: string[],
  mergeVariants: boolean
): string {
  const rows = buildExportRows(store, nodeIds, mergeVariants);
  const header = [
    "Character",
    "Pinyin",
    "Meaning",
    "Components",
    "Etymology",
    "Examples",
    "Audio",
    "HSK",
    "Tags",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const audioTag = r.audioFile ? `[sound:${r.audioFile}]` : "";
    lines.push(
      [
        r.character,
        r.pinyin,
        r.meaning,
        r.components,
        r.etymology,
        r.examples,
        audioTag,
        r.hskTag,
        r.tags,
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function escapeAnkiHtml(raw: string): string {
  return raw
    .replace(/\x1f/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sha1FieldChecksum(text: string): number {
  const digest = createHash("sha1").update(text).digest("hex").slice(0, 8);
  return Number.parseInt(digest, 16);
}

function stableNoteGuid(char: string): string {
  return createHash("sha256").update(`fuluoxiaojie:${char}`).digest("base64url").slice(0, 12);
}

/**
 * Package selected characters and their bundled syllable MP3 audio into a standard Anki .apkg archive.
 */
export function generateAnkiApkg(
  store: StaticDataStore,
  nodeIds: string[],
  mergeVariants: boolean,
  deckTitle = "FuLuoXiaoJie (弗洛小姐)"
): Uint8Array {
  const rows = buildExportRows(store, nodeIds, mergeVariants);
  const tmpDir = mkdtempSync(join(tmpdir(), "flxj-apkg-"));
  const dbPath = join(tmpDir, "collection.anki2");

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    const deckId = 1711000001001;
    const modelId = 1711000002001;

    const fieldNames = [
      "Character",
      "Pinyin",
      "Meaning",
      "Components",
      "Etymology",
      "Examples",
      "Audio",
      "HSK",
    ];

    const modelsObj = {
      [String(modelId)]: {
        id: modelId,
        name: "FuLuoXiaoJie Hanzi",
        type: 0,
        mod: nowSec,
        usn: -1,
        sortf: 0,
        did: deckId,
        flds: fieldNames.map((name, ord) => ({
          name,
          ord,
          sticky: false,
          rtl: false,
          font: "Noto Sans SC",
          size: 20,
          media: [],
        })),
        tmpls: [
          {
            name: "Recognition",
            ord: 0,
            qfmt: '<div class="flxj-hanzi">{{Character}}</div>',
            afmt:
              '{{FrontSide}}<hr><div class="flxj-pinyin">{{Pinyin}} {{Audio}}</div>' +
              '<div class="flxj-meaning">{{Meaning}}</div>' +
              '{{#Components}}<div class="flxj-meta"><b>Parts:</b> {{Components}}</div>{{/Components}}' +
              '{{#Etymology}}<div class="flxj-meta"><b>Origin:</b> {{Etymology}}</div>{{/Etymology}}' +
              '{{#Examples}}<div class="flxj-meta"><b>Words:</b> {{Examples}}</div>{{/Examples}}',
            bqfmt: "",
            bafmt: "",
            did: null,
            bfont: "",
            bsize: 0,
          },
        ],
        req: [[0, "all", [0]]],
        css:
          ".card { font-family: 'Noto Sans SC', system-ui, sans-serif; text-align: center; color: #1c1b18; background: #faf7f0; padding: 20px; }" +
          ".flxj-hanzi { font-size: 64px; margin: 16px 0; }" +
          ".flxj-pinyin { font-size: 24px; color: #b83a2a; margin-bottom: 8px; }" +
          ".flxj-meaning { font-size: 20px; margin-bottom: 14px; }" +
          ".flxj-meta { font-size: 14px; color: #524d44; text-align: left; max-width: 460px; margin: 6px auto; }",
        latexPre: "",
        latexPost: "",
        tags: [],
        vers: [],
      },
    };

    const decksObj = {
      "1": {
        id: 1,
        name: "Default",
        mod: nowSec,
        usn: 0,
        lrnToday: [0, 0],
        revToday: [0, 0],
        newToday: [0, 0],
        timeToday: [0, 0],
        collapsed: false,
        browserCollapsed: false,
        desc: "",
        dyn: 0,
        conf: 1,
        extendNew: 0,
        extendRev: 0,
      },
      [String(deckId)]: {
        id: deckId,
        name: deckTitle,
        mod: nowSec,
        usn: -1,
        lrnToday: [0, 0],
        revToday: [0, 0],
        newToday: [0, 0],
        timeToday: [0, 0],
        collapsed: false,
        browserCollapsed: false,
        desc: "Exported from FuLuoXiaoJie Simplified Mandarin DAG Learner",
        dyn: 0,
        conf: 1,
        extendNew: 0,
        extendRev: 0,
      },
    };

    const dconfObj = {
      "1": {
        id: 1,
        name: "Default",
        mod: 0,
        usn: 0,
        maxTaken: 60,
        autoplay: true,
        timer: 0,
        replayq: true,
        new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20 },
        rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
        lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
      },
    };

    const confObj = {
      activeDecks: [deckId],
      curDeck: deckId,
      newSpread: 0,
      collapseTime: 1200,
      timeLim: 0,
      estTimes: true,
      dueCounts: true,
      curModel: String(modelId),
      nextPos: rows.length + 1,
      sortType: "noteFld",
      sortBackwards: false,
      addToCur: true,
    };

    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE col (
          id integer primary key, crt integer not null, mod integer not null,
          scm integer not null, ver integer not null, dty integer not null,
          usn integer not null, ls integer not null, conf text not null,
          models text not null, decks text not null, dconf text not null, tags text not null
        );
        CREATE TABLE notes (
          id integer primary key, guid text not null, mid integer not null,
          mod integer not null, usn integer not null, tags text not null,
          flds text not null, sfld text not null, csum integer not null,
          flags integer not null, data text not null
        );
        CREATE TABLE cards (
          id integer primary key, nid integer not null, did integer not null,
          ord integer not null, mod integer not null, usn integer not null,
          type integer not null, queue integer not null, due integer not null,
          ivl integer not null, factor integer not null, reps integer not null,
          lapses integer not null, left integer not null, odue integer not null,
          odid integer not null, flags integer not null, data text not null
        );
        CREATE TABLE revlog (
          id integer primary key, cid integer not null, usn integer not null,
          ease integer not null, ivl integer not null, lastIvl integer not null,
          factor integer not null, time integer not null, type integer not null
        );
        CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
        CREATE INDEX ix_notes_usn ON notes (usn);
        CREATE INDEX ix_cards_usn ON cards (usn);
        CREATE INDEX ix_revlog_usn ON revlog (usn);
        CREATE INDEX ix_cards_nid ON cards (nid);
        CREATE INDEX ix_cards_sched ON cards (did, queue, due);
        CREATE INDEX ix_revlog_cid ON revlog (cid);
        CREATE INDEX ix_notes_csum ON notes (csum);
      `);

      db.prepare(
        `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
         VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')`
      ).run(
        nowSec,
        nowMs,
        nowMs,
        JSON.stringify(confObj),
        JSON.stringify(modelsObj),
        JSON.stringify(decksObj),
        JSON.stringify(dconfObj)
      );

      const insNote = db.prepare(
        `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
         VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`
      );
      const insCard = db.prepare(
        `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
         VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`
      );

      const mediaMap: Record<string, string> = {};
      const mediaFileToIdx = new Map<string, string>();
      const zipFiles: Zippable = {};

      rows.forEach((row, i) => {
        const noteId = nowMs + i + 1;
        const cardId = nowMs + 100_000 + i + 1;
        let audioTag = "";

        if (row.audioFile) {
          if (!mediaFileToIdx.has(row.audioFile)) {
            const bytes = store.readAudioFile(row.audioFile);
            if (bytes) {
              const key = String(mediaFileToIdx.size);
              mediaFileToIdx.set(row.audioFile, key);
              mediaMap[key] = row.audioFile;
              zipFiles[key] = [bytes, { level: 0 }];
            }
          }
          if (mediaFileToIdx.has(row.audioFile)) {
            audioTag = `[sound:${row.audioFile}]`;
          }
        }

        const safeChar = escapeAnkiHtml(row.character);
        const flds = [
          safeChar,
          escapeAnkiHtml(row.pinyin),
          escapeAnkiHtml(row.meaning),
          escapeAnkiHtml(row.components),
          escapeAnkiHtml(row.etymology),
          escapeAnkiHtml(row.examples),
          audioTag,
          escapeAnkiHtml(row.hskTag),
        ].join("\x1f");

        insNote.run(
          noteId,
          stableNoteGuid(row.character),
          modelId,
          nowSec,
          ` ${row.tags} `,
          flds,
          safeChar,
          sha1FieldChecksum(safeChar)
        );
        insCard.run(cardId, noteId, deckId, nowSec, i + 1);
      });

      db.close();

      const dbBytes = readFileSync(dbPath);
      zipFiles["collection.anki2"] = [dbBytes, { level: 6 }];
      zipFiles["media"] = [new TextEncoder().encode(JSON.stringify(mediaMap)), { level: 6 }];

      return zipSync(zipFiles);
    } catch (err) {
      try {
        db.close();
      } catch {
        // Ignore close error
      }
      throw err;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
