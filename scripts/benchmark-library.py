"""Bounded local capacity/identity check, one private render per new destination."""
import argparse
import importlib.util
import json
import pathlib
import statistics
import time

spec=importlib.util.spec_from_file_location("media",pathlib.Path(__file__).with_name("legacy-pool-rehearsal.py"))
media=importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)

def main(report_path,outdir):
    report=json.loads(report_path.read_text())
    eligible=[s for s in report["sources"] if s["eligible_for_rehearsal"]]
    if len(report["accounts"])!=15:
        raise ValueError("expected_15_new_destinations")
    # Three user-reviewed sources, rotated across accounts; bounded to 15 files.
    selected=[]
    for video in ["7582448651809688845","7572479797549370637","7594331486510189879"]:
        selected.append(next(s for s in eligible if video in s["filename"]))
    outdir.mkdir(parents=True,exist_ok=False)
    results=[]
    for i,account in enumerate(report["accounts"]):
        source=selected[i%len(selected)]
        start=time.monotonic()
        receipt=media.render(pathlib.Path(source["original_path"]),account["id"],outdir/account["id"],emit=False)
        results.append({"account_id":account["id"],"label":account["label"],"platform":account["platform"],
                        "source_sha256":source["original_sha256"],"output_sha256":receipt["output_sha256"],
                        "render_seconds":time.monotonic()-start,"output_bytes":receipt["media"]["bytes"],
                        "output_duration":receipt["media"]["duration"],
                        "full_decode_passed":receipt["full_decode_passed"],"recipe":receipt["plan"]})
        (outdir/"progress.json").write_text(json.dumps(results,indent=2))
        print(json.dumps({"completed":len(results),"total":15}),flush=True)
    elapsed=[r["render_seconds"] for r in results]
    count=len({s["original_sha256"] for s in eligible})*15
    summary={"private_renders":len(results),"all_full_decode_passed":all(r["full_decode_passed"] for r in results),
             "distinct_output_hashes":len({r["output_sha256"] for r in results}),
             "median_seconds":statistics.median(elapsed),"max_seconds":max(elapsed),
             "sample_output_bytes":sum(r["output_bytes"] for r in results),
             "full_matrix_jobs":count,
             "sample_based_serial_render_hours":sum(elapsed)/len(elapsed)*count/3600,
             "not_a_cloud_eta":True,"publishing_enabled":False,
             "limitation":"Three short sources only; excludes transfer, other source durations, review, scheduling and cloud contention."}
    (outdir/"summary.json").write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary))

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("audit",type=pathlib.Path);p.add_argument("outdir",type=pathlib.Path)
    a=p.parse_args();main(a.audit,a.outdir)
