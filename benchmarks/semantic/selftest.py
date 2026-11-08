"""Fast offline behavior checks for the benchmark; all fixtures live under .work."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
from datasets import materialize, relative_path
from benchmark import select
from runtime import cold_gate, wait_exited, warm_gate
from scoring import score, validate
from summary import summarize


class BenchmarkChecks(unittest.TestCase):
    def test_publication_and_complete_work_are_required(self):
        stage = dict(cache_hit=False, scope_chunks=2, semantic_scored_chunks=2, actual_encoded_chunks=2,
                     actual_encoded_windows=3, reused_scored_chunks=0, discarded_cached_chunks=0)
        self.assertTrue(cold_gate(stage, dict(published=True)))
        self.assertFalse(cold_gate(stage, dict(published=False)))
        self.assertFalse(cold_gate(stage, {}))
        self.assertFalse(cold_gate(stage | dict(actual_encoded_chunks=1), dict(published=True)))
        self.assertFalse(cold_gate(stage | dict(cache_hit=True), dict(published=True)))

    def test_warm_hit_still_scores_full_scope_and_encodes_zero_documents(self):
        stage = dict(cache_hit=True, scope_chunks=2, semantic_scored_chunks=2, actual_encoded_chunks=0,
                     actual_encoded_windows=0, actual_encoded_batches=0, actual_encoded_tokens=0)
        self.assertTrue(warm_gate(stage))
        self.assertFalse(warm_gate(stage | dict(cache_hit=False)))
        self.assertFalse(warm_gate(stage | dict(actual_encoded_windows=1)))
        self.assertFalse(warm_gate(stage | dict(semantic_scored_chunks=1)))

    def test_gold_source_partial_and_duplicate_coverage(self):
        with tempfile.TemporaryDirectory(dir=WORK) as directory:
            root = Path(directory)
            (root / "a.py").write_text("def target():\n    return 7\n")
            query = dict(dataset="repoqa", target=dict(path="a.py", start=1, end=2))
            hit = dict(path="a.py", start=1, end=2, content="def target():\n    return 7\n")
            full = score(query, root, [hit])
            self.assertEqual(full["rank"], 1)
            self.assertEqual(full["coverage8000"], 1)
            self.assertEqual(full, score(query, root, [hit, hit]))
            partial = score(query, root, [hit | dict(end=1, content="def target():\n")])
            self.assertEqual(partial["coverage8000"], .5)
            self.assertFalse(partial["full8000"])
            with self.assertRaises(ValueError):
                validate(root, [hit | dict(content="fabricated source")])
            with self.assertRaises(ValueError):
                validate(root, [hit | dict(path="../a.py")])
            self.assertIsNone(score(dict(dataset="evertrace", target=None), root, [hit]))
            self.assertFalse(score(query, root, [])["hit100"])

    def test_failed_requests_stay_in_quality_denominator(self):
        common = dict(phase="quality", arm="control", dataset="cosqa", directory="/fixture")
        records = [common | dict(valid=True, error=None, metrics=dict(hit1=True, mrr10=1)),
                   common | dict(valid=False, error="query too long", metrics=None)]
        result = summarize(records, [], complete=True, failure=None, mode="quality", smoke=True)
        self.assertFalse(result["passed"])
        self.assertEqual(result["quality"][0]["denominator"], 2)
        self.assertEqual(result["quality"][0]["metrics"]["hit1"], .5)

    def test_cold_without_following_verified_hit_is_not_a_timing_sample(self):
        point = dict(phase="cold", valid=True, directory="/fixture", error=None)
        result = summarize([point], [], complete=True, failure=None, mode="latency", smoke=True)
        self.assertEqual(result["cold_with_verified_hit"], 0)
        self.assertEqual(result["latency"], [])
        self.assertFalse(result["passed"])

    def test_paired_deltas_have_same_direction_in_both_orders(self):
        common = dict(phase="cold", pair_kind="ab", pair=0, dataset="cosqa", scope="cosqa", query="q",
                      valid=True, verified_hit=True, directory="/fixture", error=None)
        for arms in (("control", "candidate"), ("candidate", "control")):
            points = [common | dict(arm=arm, position=i, wall_raw_ms=100 if arm == "control" else 90)
                      for i, arm in enumerate(arms)]
            result = summarize(points, [], complete=True, failure=None, mode="latency", smoke=True)
            self.assertAlmostEqual(result["paired_deltas"][0]["delta_pct"], -10)

    def test_pidfd_observes_exit_without_sleep_polling(self):
        process = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
        descriptor = os.pidfd_open(process.pid)
        try:
            self.assertFalse(wait_exited(descriptor, 0))
            process.stdin.close()
            self.assertTrue(wait_exited(descriptor, 5))
            self.assertEqual(process.wait(), 0)
        finally:
            os.close(descriptor)
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_missing_dataset_is_a_setup_error(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            select(dict(scopes=[], queries=[], panel=[]), ["evertrace"], "latency", True)

    def test_corpus_is_visible_inside_ignored_work_directory(self):
        with tempfile.TemporaryDirectory(dir=WORK) as directory:
            root = Path(directory) / "corpus"
            (Path(directory) / "gold.json").write_text("labels stay outside the scope")
            self.assertEqual(materialize(root, {"a.py": "value = 7\n"}), {"files": 1, "bytes": 10})
            visible = subprocess.check_output(["rg", "--no-config", "--files", "-0", "--", "."], cwd=root)
            self.assertEqual(visible, b"./a.py\0")
            self.assertEqual((root / "a.py").read_text(), "value = 7\n")

    def test_scope_paths_cannot_escape(self):
        for name in ("/tmp/source", "../source", ".git/config", ""):
            with self.assertRaises(ValueError):
                relative_path(name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    WORK = args.work.resolve()
    WORK.mkdir(parents=True, exist_ok=True)
    import tiktoken
    tiktoken.get_encoding("o200k_base")
    unittest.main(argv=[sys.argv[0]])
