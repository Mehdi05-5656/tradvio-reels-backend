import importlib.util
import pathlib
import unittest
import tempfile
import json

spec = importlib.util.spec_from_file_location("rehearsal", pathlib.Path(__file__).with_name("legacy-pool-rehearsal.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RecipeTests(unittest.TestCase):
    def test_retry_stable_account_specific_bounded(self):
        one = m.recipe("a"*64, "1"*24)
        self.assertEqual(one, m.recipe("a"*64, "1"*24))
        self.assertNotEqual(one["speed"], m.recipe("a"*64, "2"*24)["speed"])
        for i in range(1000):
            r = m.recipe(f"{i:064x}", f"{i:024x}")
            self.assertTrue(.01 <= r["crop_per_edge"] <= .02)
            self.assertTrue(.97 <= r["speed"] <= 1.03)
            self.assertTrue(.10 <= r["trim_start"] <= .30)
            self.assertFalse(r["platform_uniqueness_verified"])

    def test_identity_validation(self):
        for sha, account in [("bad", "1"*24), ("a"*64, "../x"), ("G"*64, "1"*24)]:
            with self.assertRaises(ValueError):
                m.recipe(sha, account)
        with self.assertRaises(ValueError):
            m.source_path({"filename": "alice__../../secret.mp4", "source_handle": "alice"})

    def test_speech_at_start_is_not_trimmed(self):
        self.assertEqual(m.silence_safe_trim([.1]*5600, .25), 0)
        self.assertEqual(m.silence_safe_trim([0.0]*1600+[.1]*4000, .25), .07)
        self.assertEqual(m.silence_safe_trim([0.0]*5600, .25), .25)

    def test_corrupt_media_never_eligible(self):
        row = {"filename": "absent__missing.mp4", "source_handle": "absent", "previously_quarantined": False}
        self.assertFalse(m.audit_one(row)["eligible_for_rehearsal"])

    def test_full_library_matrix_deduplicates_and_never_activates(self):
        source = {"eligible_for_rehearsal": True, "original_sha256": "a"*64,
                  "storage_path": "phone_a/example.mp4", "original_path": "/tmp/reels/raw/a/1.mp4"}
        report = {"accounts": [{"id": "1"*24}, {"id": "2"*24}],
                  "sources": [source, source, {**source, "original_sha256": "b"*64, "eligible_for_rehearsal": False}]}
        with tempfile.TemporaryDirectory() as d:
            target = pathlib.Path(d) / "plan.jsonl"
            result = m.batch_plan(report, target)
            self.assertEqual(result["planned_jobs"], 2)
            rows = [json.loads(x) for x in target.read_text().splitlines()]
            self.assertNotEqual(rows[0]["job_key"], rows[1]["job_key"])
            self.assertTrue(all(r["state"] == "planned_not_enqueued" and not r["publishing_enabled"] for r in rows))
            with self.assertRaises(FileExistsError):
                m.batch_plan(report, target)


if __name__ == "__main__":
    unittest.main()
