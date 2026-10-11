import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import hashlib

spec = importlib.util.spec_from_file_location("library_worker", pathlib.Path(__file__).with_name("library-worker.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

ACCOUNT = "6ac831b2e73f366e1cbd1699"
SHA = hashlib.sha256(b"original").hexdigest()

class Fake:
    def __init__(self):
        self.calls = []
        self.upload_error = False
        self.corrupt = False
        self.renew = True
        self.job = {"id": "11111111-1111-4111-8111-111111111111", "lease_token": "22222222-2222-4222-8222-222222222222",
                    "owner_user_id": "71c2308a-9e23-4458-b4f0-df7ae53c841e", "account_id": ACCOUNT,
                    "source_sha256": SHA, "recipe_version": m.media.VERSION,
                    "source": {"sha256": SHA, "bytes": 8, "duration": 16, "object_key": f"originals/{SHA}.mp4"}}
    def check_private(self):
        self.calls.append("private")
    def rpc(self, name, args):
        self.calls.append((name, args))
        if name == "library_claim":
            return self.job
        if name == "library_renew":
            return self.renew
    def download(self, key, target, size):
        self.calls.append("download")
        target.write_bytes(b"tampered" if self.corrupt else b"original")
    def upload(self, key, path):
        self.calls.append("upload")
        if self.upload_error:
            raise RuntimeError("not logged")

def fake_render(source, account, outdir, **kwargs):
    outdir.mkdir()
    output = outdir / "test.mp4"
    output.write_bytes(b"rendered")
    plan = m.media.recipe(SHA, account)
    return {"output": str(output), "output_sha256": m.media.digest(output),
            "full_decode_passed": True, "plan": plan, "media": {"bytes": 8, "duration": 16}}

class WorkerTests(unittest.TestCase):
    def run_worker(self, client, enabled=True):
        with tempfile.TemporaryDirectory() as d, patch.object(m.media, "render", fake_render):
            return m.run_one(client, "test-worker", enabled, pathlib.Path(d))
    def test_disabled_is_inert(self):
        c=Fake()
        self.assertEqual(self.run_worker(c, False), "disabled")
        self.assertEqual(c.calls, [])
    def test_private_render_never_calls_publer(self):
        c=Fake()
        self.assertEqual(self.run_worker(c), "rendered_private")
        names=[x[0] for x in c.calls if isinstance(x, tuple)]
        self.assertEqual(names[-1], "library_complete")
        self.assertFalse(any("publish" in x or "handoff" in x for x in names))
    def test_changed_source_blocked_before_render(self):
        c=Fake();c.corrupt=True
        self.assertEqual(self.run_worker(c), "blocked")
        self.assertNotIn("upload",c.calls)
        self.assertEqual(c.calls[-1][1]["p_reason"], "source_invalid")
    def test_uncertain_upload_is_held_not_retried(self):
        c=Fake();c.upload_error=True
        self.assertEqual(self.run_worker(c), "blocked")
        self.assertEqual(c.calls.count("upload"),1)
        self.assertEqual(c.calls[-1][1]["p_reason"], "upload_uncertain")
    def test_bad_source_path_and_expired_lease_never_upload(self):
        c=Fake();c.job["source"]["object_key"]="../escape.mp4"
        self.assertEqual(self.run_worker(c), "blocked")
        self.assertNotIn("download",c.calls)
        c=Fake();c.renew=False
        self.assertEqual(self.run_worker(c), "lease_lost")
        self.assertNotIn("download",c.calls)

if __name__=="__main__":
    unittest.main()
