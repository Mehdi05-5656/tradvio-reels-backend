"""One-time isolated staging key handoff and synthetic Auth setup. No secret stdout."""
import json
import os
from pathlib import Path
import secrets
import sys
import uuid
import subprocess

REF = "hjojeyewxtmunrwcjjzg"
ROOT = Path("/tmp/tradvio-staging-private")
ROOT.mkdir(mode=0o700, exist_ok=True)
os.chmod(ROOT, 0o700)

def save(name, value):
    path = ROOT / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)

def get_json(method, url, **kwargs):
    # curl uses the sandbox's working native trust configuration; never disable TLS verification.
    args = ["curl", "--silent", "--show-error", "--max-time", "30",
            "--request", method, "--write-out", "\n%{http_code}", url]
    for key, value in kwargs.get("headers", {}).items():
        args += ["--header", key + ": " + value]
    body = None
    if "json" in kwargs:
        args += ["--header", "Content-Type: application/json", "--data-binary", "@-"]
        body = json.dumps(kwargs["json"])
    r = subprocess.run(args, input=body, capture_output=True, text=True, timeout=40)
    if r.returncode:
        raise RuntimeError("staging_transport_failed")
    payload, status = r.stdout.rsplit("\n", 1)
    if not status.startswith("2"):
        raise RuntimeError(f"staging_request_failed:{status}")
    return json.loads(payload)

def main():
    if sys.argv[1] == "keys":
        rows = get_json("GET", f"https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true")
        key = next(r["api_key"] for r in rows if r.get("name") == "service_role" and not r.get("disabled"))
        anon = next(r["api_key"] for r in rows if r.get("name") == "anon" and not r.get("disabled"))
        save("keys.json", {"project_ref": REF, "service_key": key, "anon_key": anon})
        print(json.dumps({"staging_keys_prepared": True, "secrets_printed": False}))
        return
    if sys.argv[1] != "users":
        raise RuntimeError("unknown_operation")
    keys = json.loads((ROOT / "keys.json").read_text())
    if keys["project_ref"] != REF:
        raise RuntimeError("wrong_project")
    headers = {"apikey": keys["service_key"], "Authorization": "Bearer " + keys["service_key"]}
    if (ROOT / "users.json").exists():
        raise RuntimeError("users_already_prepared_do_not_duplicate")
    users = {}
    # Save each credential before submission: an interrupted run cannot lose a password.
    for role in ["operator", "view_admin", "customer_a", "customer_b"]:
        uid = "71c2308a-9e23-4458-b4f0-df7ae53c841e" if role == "operator" else str(uuid.uuid4())
        user = {"id": uid, "email": f"{role}@staging.tradvio.invalid",
                "password": secrets.token_urlsafe(36), "role": role}
        users[role] = user
        save("users.json", users)
        data = get_json("POST", f"https://{REF}.supabase.co/auth/v1/admin/users",
                        headers=headers, json={"id": uid, "email": user["email"],
                        "password": user["password"], "email_confirm": True,
                        "user_metadata": {"display_name": f"STAGING {role}", "synthetic": True}})
        if data.get("id") != uid:
            raise RuntimeError("unexpected_auth_identity")
    print(json.dumps({"synthetic_users_created": len(users), "emails_sent": False,
                      "users": {r: u["id"] for r, u in users.items()}}))

try:
    main()
except Exception as exc:
    # Never print request/response bodies, headers, passwords, or key material.
    print(json.dumps({"error": str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__}))
    sys.exit(1)
