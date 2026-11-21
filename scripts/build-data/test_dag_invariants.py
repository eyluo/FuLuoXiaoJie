"""Hard build-time assertions verifying DAG acyclicity, pinyin, linguistic sanity, strokes, examples, and audio."""

from __future__ import annotations

import hashlib
import json
import unittest
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from build_audio import is_valid_mp3_bytes
from build_graph import is_cjk_glyph
from pinyin_utils import numbered_to_toned, toned_to_numbered

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT_DIR / "data"


def assert_acyclic(node_ids: set[str], edges: list[tuple[str, str]]) -> list[str]:
    indeg = {n: 0 for n in node_ids}
    adj: dict[str, list[str]] = defaultdict(list)
    for u, v in edges:
        if u == v:
            raise AssertionError(f"Self-loop detected on node {u!r}")
        adj[u].append(v)
        indeg[v] += 1

    q = deque(sorted(n for n, d in indeg.items() if d == 0))
    order: list[str] = []
    while q:
        u = q.popleft()
        order.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                q.append(v)

    if len(order) != len(node_ids):
        cycle_nodes = sorted(node_ids - set(order))
        raise AssertionError(
            f"Cycle detected involving {len(cycle_nodes)} nodes: {cycle_nodes[:10]}"
        )
    return order


class TestPinyinUtils(unittest.TestCase):
    def test_nfd_and_precomposed_normalization(self) -> None:
        self.assertEqual(toned_to_numbered("a\u0304"), "a1")
        self.assertEqual(toned_to_numbered("u\u0308\u030c"), "v3")
        self.assertEqual(toned_to_numbered("lǚ"), "lv3")
        self.assertEqual(toned_to_numbered("lu:3"), "lv3")
        self.assertEqual(toned_to_numbered("jǚ"), "ju3")
        self.assertEqual(toned_to_numbered("qǘ"), "qu2")
        self.assertEqual(toned_to_numbered("ế"), "e2")
        self.assertEqual(toned_to_numbered("ê"), "e5")

    def test_syllabic_nasal_tones(self) -> None:
        self.assertEqual(numbered_to_toned("m2"), "ḿ")
        self.assertEqual(numbered_to_toned("n2"), "ń")
        self.assertEqual(numbered_to_toned("ng2"), "ńg")
        self.assertEqual(numbered_to_toned("lv3"), "lǚ")
        self.assertEqual(numbered_to_toned("de5"), "de")


class TestMandarinDagInvariants(unittest.TestCase):
    graph: dict[str, Any]
    examples: dict[str, list[dict[str, Any]]]
    node_by_id: dict[str, dict[str, Any]]
    incoming: dict[str, dict[str, dict[str, Any]]]
    outgoing: dict[str, dict[str, dict[str, Any]]]

    @classmethod
    def setUpClass(cls) -> None:
        cls.graph = json.loads((DATA_DIR / "graph.json").read_text(encoding="utf-8"))
        cls.examples = json.loads((DATA_DIR / "examples.json").read_text(encoding="utf-8"))
        cls.node_by_id = {n["id"]: n for n in cls.graph["nodes"]}
        cls.incoming = defaultdict(dict)
        cls.outgoing = defaultdict(dict)
        for e in cls.graph["edges"]:
            cls.incoming[e["target"]][e["source"]] = e
            cls.outgoing[e["source"]][e["target"]] = e

    def test_raw_graph_is_strictly_acyclic(self) -> None:
        node_ids = set(self.node_by_id.keys())
        edges = [(e["source"], e["target"]) for e in self.graph["edges"]]
        order = assert_acyclic(node_ids, edges)
        self.assertEqual(len(order), len(node_ids))

    def test_variant_merged_graph_is_strictly_acyclic(self) -> None:
        vmap: dict[str, str] = self.graph["variantMap"]

        def resolve(x: str) -> str:
            seen = set()
            while x in vmap and x not in seen:
                seen.add(x)
                x = vmap[x]
            return x

        contracted_nodes = {resolve(nid) for nid in self.node_by_id}
        contracted_edges_set: set[tuple[str, str]] = set()
        for e in self.graph["edges"]:
            u = resolve(e["source"])
            v = resolve(e["target"])
            self.assertNotEqual(
                u, v, f"Variant merge created self-loop: {e['source']} -> {e['target']} via {u}"
            )
            contracted_edges_set.add((u, v))

        order = assert_acyclic(contracted_nodes, list(contracted_edges_set))
        self.assertEqual(len(order), len(contracted_nodes))

    def test_nodes_stored_in_valid_topological_order(self) -> None:
        rank = {n["id"]: i for i, n in enumerate(self.graph["nodes"])}
        for e in self.graph["edges"]:
            self.assertLess(
                rank[e["source"]],
                rank[e["target"]],
                f"Edge {e['source']} -> {e['target']} violates topological order in graph.json",
            )

    def test_scope_and_corpus_coverage(self) -> None:
        meta = self.graph["meta"]
        self.assertGreaterEqual(meta["characterCount"], 3500)
        self.assertGreaterEqual(meta["primitiveCount"], 100)
        self.assertGreaterEqual(meta["subtlexCoveragePct"], 99.0)
        self.assertGreaterEqual(meta["jundaCoveragePct"], 99.0)
        # Traditional-only glyphs should not pollute core Simplified characters
        for trad_only in ("後", "妳"):
            self.assertNotIn(trad_only, self.node_by_id)

    def test_no_placeholder_glyphs_nbsp_or_invalid_edges(self) -> None:
        valid_roles = {"semantic", "phonetic", "structural"}
        for nid, node in self.node_by_id.items():
            self.assertNotIn("？", nid)
            self.assertNotIn("?", nid)
            self.assertTrue(len(node["definition"]) > 0, f"Empty definition on {nid}")
            self.assertNotIn("\xa0", node["definition"])
            if node["etymology"] and node["etymology"].get("hint"):
                self.assertNotIn("\xa0", node["etymology"]["hint"])
        for e in self.graph["edges"]:
            self.assertIn(e["source"], self.node_by_id)
            self.assertIn(e["target"], self.node_by_id)
            self.assertGreaterEqual(e["multiplicity"], 1)
            self.assertIn(e["role"], valid_roles)

    def test_key_linguistic_decompositions_and_variants(self) -> None:
        self.assertIn("口", self.incoming["品"])
        self.assertEqual(self.incoming["品"]["口"]["multiplicity"], 3)
        self.assertIn("日", self.incoming["明"])
        self.assertIn("月", self.incoming["明"])
        for ch in ("请", "情", "清", "晴"):
            self.assertIn("青", self.incoming[ch], f"{ch} should depend on 青")
        self.assertIn("白", self.incoming["的"])
        self.assertIn("勺", self.incoming["的"])
        self.assertIn("⺼", self.incoming["胖"])
        self.assertEqual(self.graph["variantMap"].get("⺼"), "肉")
        self.assertEqual(self.graph["variantMap"].get("氵"), "水")
        self.assertEqual(self.graph["variantMap"].get("讠"), "言")
        self.assertNotIn("艹", self.graph["variantMap"])

        seen = set()
        stack = ["森"]
        while stack:
            cur = stack.pop()
            for src in self.incoming[cur]:
                if src not in seen:
                    seen.add(src)
                    stack.append(src)
        self.assertIn("木", seen)

    def test_primary_readings_for_high_frequency_characters(self) -> None:
        expected_primary = {
            "的": "de5",
            "了": "le5",
            "吗": "ma5",
            "吧": "ba5",
            "还": "hai2",
            "都": "dou1",
            "儿": "er2",
            "哦": "o2",
            "累": "lei4",
        }
        for ch, expected_syl in expected_primary.items():
            actual = self.node_by_id[ch]["syllables"][0]
            self.assertEqual(
                actual,
                expected_syl,
                f"Wrong primary syllable for {ch}: got {actual}, expected {expected_syl} (all={self.node_by_id[ch]['syllables']})",
            )
        # Ensure '啊' retains neutral a5 among its readings
        self.assertIn("a5", self.node_by_id["啊"]["syllables"])

    def test_stroke_files_exist_and_match_hanzi_writer_schema(self) -> None:
        strokes_dir = DATA_DIR / "strokes"
        checked = 0
        for node in self.graph["nodes"]:
            if not node["isPrimitive"] and node["hasStrokes"]:
                p = strokes_dir / node["strokeFile"]
                self.assertTrue(p.exists(), f"Missing stroke file {p} for {node['id']}")
                if checked < 50:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    self.assertIn("strokes", data)
                    self.assertIn("medians", data)
                    self.assertEqual(len(data["strokes"]), len(data["medians"]))
                    self.assertEqual(len(data["strokes"]), node["strokes"])
                checked += 1
        self.assertGreaterEqual(checked, 3400)

    def test_audio_files_integrity_and_umlaut_distinction(self) -> None:
        audio_dir = DATA_DIR / "audio"
        manifest = json.loads((audio_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["missing"], [])
        self.assertEqual(
            manifest["fromDavinfifield"] + manifest["fromHugolpz"] + manifest["toneFallback"],
            manifest["totalBundled"],
        )

        # Verify lü/nü MP3s are distinct from lu/nu MP3s!
        for v_syl, u_syl in (("lv2", "lu2"), ("lv3", "lu3"), ("lv4", "lu4"), ("nv3", "nu3")):
            v_bytes = (audio_dir / f"{v_syl}.mp3").read_bytes()
            u_bytes = (audio_dir / f"{u_syl}.mp3").read_bytes()
            self.assertTrue(is_valid_mp3_bytes(v_bytes), f"Invalid MP3 header on {v_syl}.mp3")
            self.assertNotEqual(
                hashlib.sha256(v_bytes).hexdigest(),
                hashlib.sha256(u_bytes).hexdigest(),
                f"{v_syl}.mp3 erroneously matches {u_syl}.mp3!",
            )

        missing_audio = []
        for node in self.graph["nodes"]:
            if node["isPrimitive"]:
                continue
            if node["syllables"]:
                af = node["audio"]
                p = audio_dir / af if af else None
                if not p or not p.exists() or not is_valid_mp3_bytes(p.read_bytes()):
                    missing_audio.append((node["id"], node["syllables"], af))
        self.assertEqual(missing_audio, [], f"Core chars missing valid audio: {missing_audio[:10]}")

    def test_word_audio_files_integrity(self) -> None:
        audio_dir = DATA_DIR / "audio"
        manifest = json.loads((audio_dir / "manifest.json").read_text(encoding="utf-8"))
        word_stats = manifest.get("wordAudio", {})
        self.assertGreaterEqual(word_stats.get("bundledWords", 0), 3500)

        checked_files: set[str] = set()
        for ch, ex_list in self.examples.items():
            for ex in ex_list:
                af = ex.get("audio")
                if not af:
                    continue
                self.assertRegex(
                    af, r"^w_[0-9a-f]{4,64}\.mp3$", f"Bad word audio name {af!r} under {ch}"
                )
                if af in checked_files:
                    continue
                p = audio_dir / af
                self.assertTrue(p.exists(), f"Missing word audio file {p}")
                if len(checked_files) < 100:
                    self.assertTrue(is_valid_mp3_bytes(p.read_bytes()), f"Invalid MP3 {p}")
                checked_files.add(af)
        self.assertEqual(len(checked_files), word_stats.get("bundledWords", 0))

    def test_examples_hygiene_and_proper_noun_filtering(self) -> None:
        for ch, ex_list in self.examples.items():
            for ex in ex_list:
                w = ex["word"]
                self.assertTrue(
                    all(is_cjk_glyph(c) for c in w), f"Non-CJK example word {w!r} under {ch}"
                )
                self.assertEqual(
                    len(ex["numbered"].split()),
                    len(w),
                    f"Syllable mismatch on {w!r}: {ex['numbered']}",
                )

        # Verify key everyday words were NOT hijacked by CC-CEDICT proper nouns
        word_gloss: dict[str, str] = {}
        for ex_list in self.examples.values():
            for ex in ex_list:
                word_gloss[ex["word"]] = ex["gloss"].lower()

        self.assertIn("university", word_gloss.get("大学", ""))
        self.assertTrue(
            "era" in word_gloss.get("时代", "") or "age" in word_gloss.get("时代", ""),
            f"Unexpected 时代 gloss: {word_gloss.get('时代')}",
        )
        self.assertNotIn("al-qaeda", word_gloss.get("基地", ""))
        self.assertNotIn("勿cue", word_gloss)


if __name__ == "__main__":
    unittest.main()
