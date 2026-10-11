"""Bounded private rendering worker. No Publer credentials, scheduling or publishing.

Deploy separately, with existing server-side Supabase credentials. Never copy keys
from another service's environment through logs or API responses.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import tempfile
import time
import urllib.error
import urllib.request
import uuid

spec = importlib.util.spec_from_file_location("media", pathlib.Path(__file__).with_name("legacy-pool-rehearsal.py"))
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)

class LeaseLost(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class StorageClient:
    def __init__(self, url, key):
        # Credentials are sent only to this exact HTTPS Supabase origin.
        if not re.fullmatch(r"https://[a-z0-9-]+\.supabase\.co", url):
            raise ValueError("invalid_storage_origin")
        if not key:
            raise ValueError("missing_server_credential")
        self.origin, self.key = url, key
        self.opener = urllib.request.build_opener(NoRedirect())
    def request(self, path, data=None, content_type="application/json"):
        req = urllib.request.Request(self.origin+path, data=data,
            headers={"authorization": "Bearer "+self.key, "apikey": self.key,
                     "content-type": content_type, "x-upsert": "false"},
            method="POST" if data is not None else "GET")
        return self.opener.open(req, timeout=60)
    def rpc(self, name, args):
        if name not in {"library_claim","library_renew","library_complete","library_fail"}:
            raise ValueError("rpc_not_allowed")
        with self.request("/rest/v1/rpc/"+name, json.dumps(args).encode()) as response:
            raw=response.read(65537)
            if len(raw)>65536:
                raise ValueError("oversized_response")
            # PostgREST void RPCs legitimately return HTTP 204 with no body.
            return json.loads(raw) if raw.strip() else None
    def check_private(self):
        for bucket in ("managed-raw","managed-variants"):
            with self.request("/storage/v1/bucket/"+bucket) as response:
                result=json.loads(response.read(65536))
            if result.get("id")!=bucket or result.get("public") is not False:
                raise ValueError("private_bucket_required")
    def download(self, key, target, size):
        if not re.fullmatch(r"originals/[a-f0-9]{64}\.mp4",key):
            raise ValueError("source_invalid")
        with self.request("/storage/v1/object/authenticated/managed-raw/"+key) as response, target.open("xb") as f:
            n=0
            while True:
                chunk=response.read(min(1048576,size+1-n))
                if not chunk:
                    break
                n+=len(chunk)
                if n>size:
                    raise ValueError("source_invalid")
                f.write(chunk)
            if n!=size:
                raise ValueError("source_invalid")
    def upload(self, key, path):
        if not re.fullmatch(r"library/[a-f0-9-]{36}/[a-f0-9]{24}/[a-f0-9-]{36}/[a-f0-9-]{36}\.mp4",key):
            raise ValueError("invalid_output_key")
        if not 0<path.stat().st_size<67108864:
            raise ValueError("output_too_large")
        with self.request("/storage/v1/object/managed-variants/"+key, path.read_bytes(), "video/mp4") as response:
            response.read(65536)

def validate_job(job):
    for key in ("id","owner_user_id","lease_token"):
        if str(uuid.UUID(job[key]))!=job[key]:
            raise ValueError("invalid_job")
    sha=job["source_sha256"]
    if job["recipe_version"]!=media.VERSION:
        raise ValueError("recipe_version_mismatch")
    media.recipe(sha,job["account_id"])
    source=job["source"]
    if source["sha256"]!=sha or source["object_key"]!=f"originals/{sha}.mp4":
        raise ValueError("source_invalid")
    if type(source["bytes"]) is not int or not 0<source["bytes"]<=134217728:
        raise ValueError("source_invalid")

def run_one(client, worker, enabled, scratch=None):
    if not enabled:
        return "disabled"
    client.check_private()
    job=client.rpc("library_claim",{"p_worker":worker})
    if not job:
        return "idle"
    args={"p_job":job["id"],"p_token":job["lease_token"]}
    stage="source_invalid"
    def renew():
        if client.rpc("library_renew",args) is not True:
            raise LeaseLost()
    try:
        validate_job(job)
        renew()
        with tempfile.TemporaryDirectory(prefix="library-render-",dir=scratch) as d:
            root=pathlib.Path(d);source=root/"source.mp4"
            client.download(job["source"]["object_key"],source,job["source"]["bytes"])
            if media.digest(source)!=job["source_sha256"]:
                raise ValueError("source_invalid")
            renew();stage="render_failed"
            started=time.monotonic()
            receipt=media.render(source,job["account_id"],root/"output",allowed_root=root,emit=False)
            elapsed=time.monotonic()-started
            output=pathlib.Path(receipt["output"])
            if not receipt["full_decode_passed"] or not output.resolve().is_relative_to(root):
                raise ValueError("render_failed")
            if output.stat().st_size>=67108864:
                raise ValueError("render_failed")
            renew();stage="upload_uncertain"
            key=f"library/{job['owner_user_id']}/{job['account_id']}/{job['id']}/{job['lease_token']}.mp4"
            client.upload(key,output)  # one attempt, no overwrite/retry
            renew()
            result={"object_key":key,"sha256":receipt["output_sha256"],"bytes":receipt["media"]["bytes"],
                    "duration":receipt["media"]["duration"],"recipe":receipt["plan"],
                    "full_decode_passed":True,"render_seconds":round(elapsed,3)}
            try:
                client.rpc("library_complete",{**args,"p_result":result})
            except Exception:
                # Could have committed: never replace success with a guessed failure.
                return "completion_unconfirmed"
            return "rendered_private"
    except LeaseLost:
        return "lease_lost"
    except Exception:
        try:
            client.rpc("library_fail",{**args,"p_reason":stage})
            return "blocked"
        except Exception:
            return "failure_unconfirmed"

def run_batch(client, worker, count, emit):
    """Bounded batch; isolate ordinary media failures, stop uncertain operations."""
    if not 1<=count<=20000:
        raise ValueError("invalid_job_budget")
    consecutive=0
    for _ in range(count):
        result=run_one(client,worker,True)
        emit(result)
        if result=="rendered_private":
            consecutive=0
        elif result=="blocked":
            consecutive+=1
            if consecutive>=3:
                return 1
        elif result in {"completion_unconfirmed","failure_unconfirmed","lease_lost"}:
            return 1
        elif result=="idle":
            return 0
        else:
            return 1
    return 0

if __name__=="__main__":
    try:
        if os.environ.get("LIBRARY_RENDER_ENABLED")!="1":
            print(json.dumps({"status":"disabled"}))
        else:
            client=StorageClient(os.environ["SUPABASE_URL"],os.environ["SUPABASE_SERVICE_ROLE_KEY"])
            count=int(os.environ.get("LIBRARY_MAX_JOBS","1"))
            worker="library-"+str(uuid.uuid4())
            raise SystemExit(run_batch(client,worker,count,
                lambda status:print(json.dumps({"status":status}),flush=True)))
    except Exception:
        print(json.dumps({"status":"worker_failed"}))
        raise SystemExit(1)
