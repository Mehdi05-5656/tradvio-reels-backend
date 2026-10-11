# Tradvio Reels original-pool recovery and private rehearsal

October 11, 2026. This record corrects the workflow drift from the user's established full-library, preservation-oriented video pipeline. Three account-specific private samples were rendered; no new account was activated or scheduled.

## Recovered requirement

Every newly connected account should get its own version of the full shared Tradvio source library, not merely a three-video batch. The pilot is a quality gate, not the ultimate batch size. Existing content, speech and visual structure should be preserved closely; new educational scripts, replacement footage and added text overlays were not the requested baseline.

The earlier conversation includes the user's statement that the creators' Tradvio videos were made for Tradvio and repeated authorization to use the shared pool. This is operator-stated provenance, not independent verification of every embedded audio licence. Do not infer platform originality or guaranteed acceptance from changes to encoding or pixels.

## Source reconciliation

Read-only production inventory and local original-file inspection found:

| Observation | Result |
|---|---:|
| Existing queue rows across three publishers | 1,780 |
| Distinct referenced video paths/filenames | 891 |
| Referenced objects present in private Supabase `reels` | 891 |
| Missing referenced objects | 0 |
| All stored objects in `reels`, including unreferenced files | 921 |
| Previously flagged corrupt/quarantined referenced paths | 14 |
| Original local downloads with readable video/audio containers for referenced paths | 891 |
| Conservative candidate pool, excluding the 14 prior quarantines | 877 |
| Distinct SHA-256 values in that candidate original pool | 877 |
| Newly assigned destinations | 15 |
| Planned candidate variants across those destinations | 13,155 |

Container inspection is not full decoding or editorial acceptance of all 891 originals. The 14 excluded records have readable original containers and might be recoverable, but their legacy rows and stored corrupt variants were not changed or requeued.

The original downloads remain under `/tmp/reels/raw`; the processed outputs are under `/tmp/reels/processed` and in the private `reels` bucket. Those are not interchangeable. The rehearsal uses the originals to avoid another pass over already transformed outputs.

The previously empty managed registry did not mean the video library was absent. No assets were registered in production during this recovery.

## Original recipe and controlled corrections

Recovered implemented baseline:

- 1–2% center crop from each edge.
- Small speed change in the range 0.970–1.030x, with matching original-audio tempo.
- 0.10–0.30-second opening trim.
- 1080×1920, 30 fps, H.264 `veryfast`, CRF 23, yuv420p.
- AAC audio at 128 kbps.
- Source metadata stripping and MP4 fast-start.
- Reviewed watermark handling; the original runner used two bottom-corner delogo boxes.

The older notebook differs from the later executed runner: it used `fast` / CRF 20. This rehearsal follows the later runner's CRF 23 baseline.

Corrections in local `legacy-light-account-v2`:

- Recipes are deterministic from source SHA-256, destination account ID and recipe version. Retries do not randomly change an account's version.
- Opening trim is limited to measured leading silence, retaining a 30 ms guard. If speech begins immediately, trimming is zero. This avoids cutting speech merely to satisfy a random trim target.
- Corner masking is opt-in after source review; it is not blindly applied to existing captions, charts or attribution. The supplied samples were rendered without corner masks.
- Any reviewed mask coordinates use normalized output dimensions, fixing the old runner's source-coordinate/output-coordinate mismatch.
- Output source-metadata copying and chapter copying are disabled. Standard MP4/codec tags still exist; these are not a false claim of an entirely tag-free file.
- Existing outputs are not overwritten. Each sample has a receipt with source/output hashes, recipe, technical results and publishing disabled.
- Byte-level difference is recorded, but perceptual uniqueness and platform duplicate-content acceptance remain unverified.

## Private pilot

Destination selected for rehearsal: Instagram `at_trades.2`, Publer ID `6ac831b2e73f366e1cbd1699`.

| Source video ID | Duration | Crop per edge | Speed | Safe opening trim | Full decode |
|---|---:|---:|---:|---:|---|
| 7582448651809688845 | 16.394 seconds | 1.6481% | 1.024635x | 0.05 seconds | Passed |
| 7572479797549370637 | 18.081 seconds | 1.2671% | 0.979319x | 0.09 seconds | Passed |
| 7594331486510189879 | 14.150 seconds | 1.0971% | 1.029708x | 0.05 seconds | Passed |

All outputs contain H.264 video and AAC audio at 1080×1920/30fps. Original content and original audio remain; nothing was uploaded to Publer.

The initial sample review flagged abrupt speech boundaries and promotional trading-success language already present in the source material. The speech-boundary concern informed the silence-only trim correction. The samples remain pending operator editorial review; a decoder pass does not certify claims, rights, audio/video synchronization or publication readiness.

Five focused tests pass: stable retry recipes, account-specific seeds and parameter bounds, source/path validation, invalid-source rejection, speech-preserving trim and the deduplicated full-library plan with publishing disabled.

## Credential clarification

The existing production backend already has `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` configured. Presence was checked without reading or exposing values. The user declined a separate sandbox credential request; no credential was saved or copied.

The production worker should use existing server-side access rather than asking the user to re-enter the same key. This does not mean that private file transfer or the full-library worker has already been wired.

## Current engineering boundary

Completed locally:

- Recovered original requirements and executable recipe.
- Reconciled the existing library with production metadata and original downloads.
- Inspected and hashed the 891 referenced originals.
- Built a 13,155-row deterministic candidate manifest, representing 877 sources per new account.
- Rendered three private account-specific samples with technical receipts.

Not completed or activated:

- Durable cloud preservation/import of the recovered original downloads.
- Production full-library source/variant job registry and worker integration.
- Replacement of the newer 24-video batch cap with a full-library campaign plus bounded work queues.
- Safe durable upload/submission coordination in the Publer workspace shared with the three legacy publishers.
- Full-batch rendering, quality review, cloud storage and progress/ETA integration.
- One-account public pilot, subsequent expansion, controlled A/B testing or closed-loop learning.

The manifest state is explicitly `planned_not_enqueued`; remote jobs created: zero. Existing production publishers, schedules, credentials and historical holds were not changed.

## Next gate and order

Review the three private samples as the preservation/quality baseline. Then implement and test the full-library job registry, worker and cloud-source import using existing server credentials; review the exact production deployment before applying it.

Run the first account's full candidate library with bounded workers and visible progress. Quarantine quality failures rather than hiding them in a success count. After batch acceptance, present the exact public pilot content and schedule, validate delivery, and expand one account at a time.

Do not store all 13,155 rendered files simultaneously in this local sandbox: only approximately 3.6 GB of disk remained at the audit. Cloud rendering should stream one bounded job at a time to private storage and preserve durable receipts.
