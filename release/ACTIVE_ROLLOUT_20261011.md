# Active rollout checkpoint

The user approved the private pilot and explicitly authorized the required future deployment/work steps for the full 15-new-account rollout at 2026-10-11 02:10 PDT. They want generation and scheduling operating by morning. Do not promise all 13,155 videos finished or all accounts posting by that time.

## Live state

- Production Supabase: gzvxqzguthrpvjtflxcx.
- Additive private-library migration applied successfully via connector. Six new tables, defaults disabled; no legacy data rewrites.
- Backend production master: 8e2007af0b36f64a9fb872550512babaa85e1a6d. Web live deploy dep-db5l5crrjlhs73asc5d0; subsequent import/history flag deploy dep-db5l5stckfvc73ajeji0 live. Publisher/analytics deployments dep-db5l5d3rjlhs73asc5ng and dep-db5l5d3rjlhs73asc66g live.
- Backend flags LIBRARY_IMPORT_ENABLED=1, LIBRARY_STATUS_ENABLED=1. Other managed publishing flags unchanged/off.
- Feature-worker production main: 420ac1714b22e364d8c6c67ffc16bf30dbd1da05. Deploy dep-db5l7s0ae00c739ps380 live.
- Existing feature cron service crn-dagba90u01pc73dq0m2g retains its original hourly schedule and python worker.py command. It now contains library-worker.py and legacy-pool-rehearsal.py for separate one-off jobs.
- Backend local branch feature/private-library-learning-20261011 is at cff873e (empty-RPC parser fix, not yet pushed to backend). Feature-worker local branch feature/private-library-oneoff-20261011 is at production 420ac17.
- Backend scripts/import-private-library.mjs is new/uncommitted operational tooling.

## Pilot receipts

First one-off job job-db5l6qbbc2fs7399j27g completed one video, then stopped on completion_unconfirmed. Its database completion actually succeeded. Root cause: Python transport tried to JSON-parse an empty successful PostgREST 204 body. Fixed, regression-tested, and deployed; no output was blindly rerendered.

Second one-off job job-db5l8kh42hec739c2gf0 completed the remaining two jobs and succeeded.

All three pilot jobs for at_trades.2 / 6ac831b2e73f366e1cbd1699 are rendered_private with full_decode_passed=true and three private objects. Render times: 9.898, 9.233, 8.962 seconds. Original hashes were verified inside the cloud worker.

Library DB control currently enabled=true, max_active=1, max_daily_claims=3. Three claims consumed. No full-library jobs enqueued yet. No new publishing or scheduling.

## Running operation: do not replay

Code Mode cell **69** is running the full original import:

```js
const {importLibrary}=await import("file:///home/user/workspace/tradvio-publisher-repair/scripts/import-private-library.mjs");
await importLibrary(tools,text);
```

Use exec_wait(cell_id="69") to collect progress/completion. Last observed: 80 new uploads plus 3 preexisting pilot originals, total target 877. It registers/mints batches of 40 source-bound one-use tickets, hashes local bytes, uploads directly to signed private Storage URLs, and writes non-secret per-file receipts to rehearsal/private-import-receipts.jsonl. No plaintext capabilities or storage keys are saved.

Do not run a second importer concurrently. On failure, reconcile Storage inventory and byte counts first; the importer skips existing exact-size objects and refuses conflicts. A failed partial batch can leave registered sources with no uploaded object, so do not plan the full library before import completion/read-back.

## Next engineering and execution

1. Finish original import and verify 877 private originals / 1,299,853,028 total bytes.
2. Increase renderer CLI job budget above current 100 safely, keep an external wall-time cap, record FFmpeg/version provenance if needed, and define bounded handling of per-job blocks. Use existing service one-off jobs with inherited secrets; do not ask the user for another storage key.
3. Plan all 15 accounts idempotently, creating 13,155 total logical variants including the 3 completed pilot jobs. Increase DB max_active to at most 4 and explicit daily claims budget. Launch bounded parallel one-off jobs only after original availability is reconciled. Published cron plan rate checked: 2 CPU/4 GB is $0.00197/minute, billed per second. Endpoint POST https://api.render.com/v1/services/crn-dagba90u01pc73dq0m2g/jobs; body fields startCommand and planId=plan-crn-007.
4. Publishing integration is not yet built. Existing managed generation/handoff is a separate, incompatible 24-item/editorial-similarity pipeline that forbids the legacy workspace. Do not casually bypass its gates.
5. Consider deliberately extending the already-working legacy publisher to library-backed slots, instead of routing light-edited files through incompatible managed generation. This is a design direction only, not implemented or committed.

## Verified publishing integration constraints

- publer_slot_config_slot_check allows only phone_a, phone_b, tiktok_tradvio.
- reels_manual_queue_phone_slot_check allows only those same three slots.
- reels_manual_queue.storage_path has no storage_bucket column; publisher's signedUrl always uses bucket reels.
- New private outputs are in managed-variants. Any bridge must explicitly add/use whitelisted bucket identity and prevent cross-account artifacts.
- publer-schedule.ts loadSlots is dynamic, so its main loop can support more rows after deliberate schema/config work. It publishes one queued item per account per tick on the existing 08:00 through 22:00 two-hour PT grid, daily target 8; it backfills missed slots, so newly activated accounts need a not-before guard to avoid bursts.
- Existing withUploadLock is an in-process mutex only. Add durable shared-workspace upload coordination before expanding concurrent publishers; do not remove managed workspace guards as a shortcut.
- Publisher persists submission intent and provider job IDs, holds uncertain public submissions and has exact-account result parsing. Preserve these behaviors and eight historical holds.
- Caption source: queue_suggestions first, then device_content_templates. A new slot with no template produces a blank caption; account-specific approved caption policy must be set before activation.
- Feature worker reads reels_manual_queue id/storage_path and downloads via media_access.py, currently assuming existing storage rules. It also needs explicit new-bucket handling if library outputs are bridged.
- Analytics enumerates dynamic slot configs. TikTok saved old provider IDs do not directly join permalink-keyed analytics; getPublishedTikTokIdentity now validates a read-only old/new/platform-ID mapping, but bulk reconciliation is not implemented.

## Learning and tests

Offline Ridge candidate: 263 Instagram fixed-age samples, 210 train/53 holdout, no source overlap. Relative MAE improvement 6.468%; confidence interval crosses zero. Not promoted. No active A/B test or online-learning loop.

Last full backend suite: 156/156 passed before the Python transport fix. Python suite after fix: 11/11 passed. Fifteen real cross-account local renders and three cloud pilot renders passed technical decoding.

The user-facing reviewed rollout document, with exact initial diffs, was shared as asset a98bf64d-9647-4be6-bfea-d652d91a7181. It predates the subsequent rollout and parser fix; update results honestly, not as if the full system is already operational.
