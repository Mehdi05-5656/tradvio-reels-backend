"""Local-only recovery of the original Tradvio batch workflow. No network or publishing.

Transforms produce distinct files, not a guarantee of distinct platform fingerprints.
Masks must be reviewed; never remove creator attribution automatically.
"""
import argparse
import concurrent.futures
import hashlib
import json
import math
import pathlib
import subprocess
import struct

VERSION = "legacy-light-account-v2"
RAW_ROOT = pathlib.Path("/tmp/reels/raw").resolve()


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def run(args, timeout=60):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout)


def probe(path):
    p = json.loads(run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                        "-show_streams", "-show_format", "-of", "json", str(path)]).stdout)
    video = [s for s in p["streams"] if s["codec_type"] == "video"]
    audio = [s for s in p["streams"] if s["codec_type"] == "audio"]
    d = float(p["format"]["duration"])
    if len(video) != 1 or len(audio) != 1 or not math.isfinite(d) or not 1 < d <= 600:
        raise ValueError("unsupported_media")
    v = video[0]
    if not 160 <= v["width"] <= 4096 or not 160 <= v["height"] <= 4096:
        raise ValueError("unsupported_dimensions")
    return {"duration": d, "width": v["width"], "height": v["height"],
            "video_codec": v["codec_name"], "audio_codec": audio[0]["codec_name"],
            "fps": v.get("avg_frame_rate"), "bytes": path.stat().st_size}


def source_path(row):
    handle, sep, name = row["filename"].partition("__")
    if not sep or handle != row["source_handle"] or "/" in name or "\\" in name:
        raise ValueError("invalid_source_identity")
    path = (RAW_ROOT / handle / name).resolve()
    if not path.is_relative_to(RAW_ROOT):
        raise ValueError("unsafe_path")
    return path


def recipe(source_hash, account_id):
    if len(source_hash) != 64 or any(c not in "0123456789abcdef" for c in source_hash):
        raise ValueError("invalid_source_hash")
    if len(account_id) != 24 or any(c not in "0123456789abcdef" for c in account_id):
        raise ValueError("invalid_account_id")
    seed = hashlib.sha256(f"{VERSION}:{source_hash}:{account_id}".encode()).digest()
    unit = lambda n: int.from_bytes(seed[n:n+4], "big") / (2**32 - 1)
    return {"version": VERSION, "source_sha256": source_hash, "account_id": account_id,
            "crop_per_edge": round(.01 + .01 * unit(0), 6),
            "speed": round(.97 + .06 * unit(4), 6),
            "trim_start": round(.10 + .20 * unit(8), 6),
            "width": 1080, "height": 1920, "fps": 30, "crf": 23,
            "watermark_policy": "reviewed_regions_only",
            "platform_uniqueness_verified": False}


def audit_one(row):
    result = dict(row)
    try:
        path = source_path(row)
        result.update(original_path=str(path), media=probe(path), original_sha256=digest(path),
                      inspection="container_valid_not_full_decode",
                      eligible_for_rehearsal=not row["previously_quarantined"])
        if row["previously_quarantined"]:
            result["review_reason"] = "original_may_recover_corrupt_stored_variant"
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        result.update(inspection="unavailable_or_invalid", eligible_for_rehearsal=False)
    return result


def audit(manifest, output):
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        sources = list(pool.map(audit_one, manifest["sources"]))
    valid = [s for s in sources if s["eligible_for_rehearsal"]]
    hashes = [s["original_sha256"] for s in valid]
    report = {"version": VERSION, "publishing_enabled": False, "accounts": manifest["accounts"],
              "sources": sources, "summary": {
                  "registered_source_paths": len(sources), "accounts": len(manifest["accounts"]),
                  "originals_container_valid": sum(s["inspection"] == "container_valid_not_full_decode" for s in sources),
                  "previously_quarantined": sum(s["previously_quarantined"] for s in sources),
                  "candidate_paths": len(valid), "distinct_candidate_hashes": len(set(hashes)),
                  "duplicate_original_bytes": len(hashes) - len(set(hashes)),
                  "projected_variants_before_editorial_checks": len(set(hashes)) * len(manifest["accounts"]),
                  "full_decode_verified": False}}
    output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report["summary"]))


def batch_plan(report, output):
    """Immutable per-account manifest; never creates jobs in a live database."""
    seen = set()
    sources = []
    for row in report["sources"]:
        if not row["eligible_for_rehearsal"] or row["original_sha256"] in seen:
            continue
        seen.add(row["original_sha256"])
        sources.append(row)
    accounts = report["accounts"]
    if len({a["id"] for a in accounts}) != len(accounts):
        raise ValueError("duplicate_destination")
    count = 0
    with output.open("x") as f:
        for a in accounts:
            for s in sources:
                p = recipe(s["original_sha256"], a["id"])
                key = hashlib.sha256(json.dumps(p, sort_keys=True).encode()).hexdigest()
                f.write(json.dumps({"job_key": key, "account_id": a["id"], "source_sha256": s["original_sha256"],
                                    "source_storage_path": s["storage_path"],
                                    "original_local_path": s["original_path"], "recipe": p,
                                    "state": "planned_not_enqueued", "publishing_enabled": False,
                                    "output_key": f"account-variants/{a['id']}/{key}.mp4"}) + "\n")
                count += 1
    return {"sources_per_account": len(sources), "accounts": len(accounts), "planned_jobs": count,
            "publishing_enabled": False, "remote_jobs_created": 0}


def silence_safe_trim(samples, proposed, rate=16000):
    """Only remove measured leading quiet audio; never use random trim inside speech."""
    window = max(1, rate // 100)
    quiet = 0
    for start in range(0, len(samples)-window+1, window):
        frame = samples[start:start+window]
        rms = math.sqrt(sum(x*x for x in frame)/window)
        if not math.isfinite(rms) or rms > 10**(-42/20):
            break
        quiet += window
    return round(min(proposed, max(0, quiet/rate - .03)), 6)


def render(source, account_id, outdir, reviewed_masks=False):
    source = source.resolve()
    if not source.is_relative_to(RAW_ROOT):
        raise ValueError("original_download_required")
    meta = probe(source)
    plan = recipe(digest(source), account_id)
    head = run(["ffmpeg", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(source),
                "-t", "0.35", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]).stdout
    samples = struct.unpack("<"+"f"*(len(head)//4), head)
    plan["requested_trim_start"] = plan["trim_start"]
    plan["trim_start"] = silence_safe_trim(samples, plan["trim_start"])
    plan["trim_policy"] = "leading_silence_only_with_30ms_guard"
    plan["reviewed_corner_masks"] = reviewed_masks
    outdir.mkdir(parents=True, exist_ok=True)
    output = outdir / f"{account_id}-{plan['source_sha256'][:16]}.mp4"
    receipt_path = output.with_suffix(".json")
    if output.exists() or receipt_path.exists():
        raise ValueError("existing_output_reconcile_before_retry")
    pct, speed, trim = plan["crop_per_edge"], plan["speed"], plan["trim_start"]
    filters = [f"crop=trunc(iw*(1-{2*pct})/2)*2:trunc(ih*(1-{2*pct})/2)*2",
               "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos",
               "crop=1080:1920", "setsar=1"]
    if reviewed_masks:
        # Coordinates are in normalized OUTPUT space, unlike the original runner bug.
        filters += ["delogo=x=20:y=1760:w=260:h=140", "delogo=x=800:y=1760:w=260:h=140"]
    filters += [f"setpts=(PTS-STARTPTS)/{speed}", "fps=30"]
    args = ["ffmpeg", "-v", "error", "-nostdin", "-n", "-threads", "2",
            "-protocol_whitelist", "file,pipe", "-ss", str(trim), "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0", "-vf", ",".join(filters),
            "-af", f"asetpts=PTS-STARTPTS,atempo={speed}",
            "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
            "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", str(output)]
    run(args, timeout=240)
    actual = probe(output)
    expected = (meta["duration"] - trim) / speed
    if actual["width"] != 1080 or actual["height"] != 1920 or actual["fps"] != "30/1" or abs(actual["duration"]-expected) > .25:
        raise ValueError("output_qc_failed")
    run(["ffmpeg", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe",
         "-i", str(output), "-f", "null", "-"], timeout=240)
    receipt = {"plan": plan, "source": str(source), "output": str(output),
               "output_sha256": digest(output), "media": actual, "full_decode_passed": True,
               "editorial_review": "pending", "publishing_enabled": False,
               "disclaimer": "A distinct file hash does not establish perceptual uniqueness or platform acceptance."}
    receipt_path.write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    a = sub.add_parser("audit")
    a.add_argument("manifest", type=pathlib.Path)
    a.add_argument("output", type=pathlib.Path)
    p = sub.add_parser("plan")
    p.add_argument("audit", type=pathlib.Path)
    p.add_argument("output", type=pathlib.Path)
    r = sub.add_parser("render")
    r.add_argument("source", type=pathlib.Path)
    r.add_argument("account")
    r.add_argument("outdir", type=pathlib.Path)
    r.add_argument("--reviewed-corner-masks", action="store_true")
    args = parser.parse_args()
    if args.action == "audit":
        audit(json.loads(args.manifest.read_text()), args.output)
    elif args.action == "plan":
        print(json.dumps(batch_plan(json.loads(args.audit.read_text()), args.output)))
    else:
        render(args.source, args.account, args.outdir, args.reviewed_corner_masks)
