# Tradvio Reels: private-library rendering and learning checkpoint

Prepared October 11, 2026. This is a tested local candidate, not a completed production rollout. No new account was scheduled or published during this work.

## Scope and verified progress

- **Destination scope:** 18 accounts belong under support@tradvio.com. The existing three legacy publishers are outside this change; the new-account expansion covers 15 destinations.
- **Source inventory:** 877 distinct original-download candidates after excluding 14 previously quarantined entries. The full account/source matrix contains 13,155 planned variants, not 13,155 running jobs.
- **Approved baseline:** Preserve the original content, with account-specific small crops and playback adjustments, speech-safe opening trim, 1080 × 1920 encoding, and metadata removal. The three previously reviewed private samples remain the visual baseline. No new overlays, scripts, replacement music, or automatic corner masks were added.
- **Cross-account render check:** 15 new private outputs, one for each destination, rotating among the three reviewed sources. All 15 passed full decoding and had distinct output SHA-256 hashes. A distinct file hash is not proof of perceptual novelty, platform duplicate classification, or future performance.
- **Timing:** Median local render/check time was 13.843 seconds; maximum was 15.532 seconds. Linear extrapolation from this small sample is 49.22 serial render-hours for 13,155 outputs. This is not a cloud ETA: only three short sources were sampled, other tests ran concurrently, and transfer, review, scheduling, and operational overhead are excluded.
- **Full-source size:** The candidate originals total 1,299,853,028 bytes. Their median duration is 21.83 seconds and their longest duration is 60.44 seconds, longer than the short benchmark samples; the 49.22-hour extrapolation should not be treated as a reliable full-library forecast.

## Candidate verification

- **Backend regression:** 156 tests passed, zero failed in the final clean run.
- **Python:** 10 recipe and worker tests passed.
- **Media:** 15 actual render/decode checks passed, with 15 distinct output hashes across the 15 destinations.
- **Build:** Backend bundle built successfully; whitespace checks passed.
- **Worker startup:** With no credentials inherited and the enable flag absent, the private worker returned `disabled` without network access.
- **Existing feature task:** `worker.py`, `media_access.py`, hourly schedule and default command were not changed. The renderer copies in the backend and feature-worker candidates have matching hashes.
- **Read-only production preflight:** 18 ownership rows; both managed buckets private and empty; zero managed generation jobs; no preexisting `library*` tables or functions. No production mutations were made.

Regression work also corrected an existing test fixture that expired publishing approval after only 24 hours. It could fail near the daily slot because the scheduler correctly requires one hour's lead time. Only the settings test's approval window was extended; production scheduling rules were not changed.

## Private-render implementation

The new pipeline is separate from the existing 24-video managed generator. It does not weaken that generator's editorial or perceptual-similarity rules and does not attach private outputs to its publishing handoff.

- **Original registry:** Immutable original hash, object key, byte count, duration, original platform video ID, creator handle, provenance, and private-render permission reference.
- **Full-library queue:** One job per source hash, destination and recipe version. Repeat planning does not duplicate jobs. Each job retains its owner and workspace identity.
- **Worker safety:** Disabled by default; maximum concurrent and daily claims; three-attempt ceiling; lease fencing; bounded local temporary files; original-byte hash verification; full output decode; no-overwrite private uploads. Uncertain uploads are held; uncertain completion responses are not falsely reported as failures or successes.
- **Source import:** Single-redemption, 15-minute capability tickets authorize creation of an upload URL for one exact private original object. Only ticket hashes are stored. Storage-issued signed URLs have the provider's own lifetime; consuming a ticket does not revoke an already-issued URL. They cannot read other files, list the library or administer accounts. Outputs are independently hash-checked by the renderer.
- **History:** Actual queued, started, interrupted, blocked and privately rendered events. Account history can show total/pending/running/blocked/rendered counts. Owner scoping remains enforced; customers cannot mutate processing or schedules.
- **Credential reuse:** A separate one-off job can use the existing feature-worker service's environment without printing or exporting secret values. The hourly feature worker's normal command and source files remain unchanged. Render documents one-off jobs on cron base services and inherited environment variables: https://render.com/docs/one-off-jobs.

Relevant flags are `LIBRARY_IMPORT_ENABLED`, `LIBRARY_STATUS_ENABLED` and `LIBRARY_RENDER_ENABLED`. All default off. The worker has no Publer scheduling or publishing call.

## Machine-learning result

The existing database contained 1,780 video-feature rows. There were 279 Instagram publications with an exact saved publication-to-analytics join; 263 had an outcome snapshot in the selected 24–30-hour window.

The offline candidate used Ridge regression on log(1 + views), numeric video features, account identity, posting-hour features and first-frame text features. Preprocessing was fit only on training data. The split was chronological, with all held-out source videos excluded from training.

| Measurement | Result |
|---|---:|
| Training rows | 210 |
| Held-out rows | 53 |
| Source overlap between training and holdout | 0 |
| Candidate MAE on log(1 + views) | 0.626705 |
| Per-account median baseline MAE | 0.670045 |
| Relative error reduction | 6.468% |
| Source-bootstrap 95% interval for baseline minus model error | -0.020902 to 0.103523 |
| Promotion | Not promoted |

The predeclared gate required at least 50 held-out rows, at least 10% error reduction and a positive lower confidence bound. The candidate failed the latter two criteria. It is not running account selection or scheduling.

Important limitations:

- Only two legacy Instagram accounts are represented; this does not establish performance on the 15 new accounts.
- Music presence was missing throughout the training data and was omitted by the fitted imputer. Feature coverage must be repaired before interpreting that variable.
- The observation window is 24–30 hours after the logged publication attempt, not exact publication-age measurement.
- Existing historical rows do not contain the old transformation settings. The new worker now records them; this model cannot yet learn which edit settings work.
- Feature coefficients are predictive associations, not explanations of why a video went viral.
- There is no active controlled A/B experiment or automatic production retraining/promotion loop. The held-out set must not be reused to tune successive candidate models.

## TikTok attribution repair

The previous exact join produced zero matched TikTok labels. A read-only Publer lookup demonstrated that the stored legacy ID `6acb188ae22c90929b0df52f` resolves to provider ID `219632154`, platform post ID `7695271349719272734`, and its TikTok permalink. The account ID and legacy ID were verified against the requested record.

A tested read-only mapping helper now rejects mismatched accounts, unrelated post IDs, unpublished states, foreign link hosts and mismatched platform IDs. No bulk historical mapping was written and no TikTok examples were added to training during this work. This is provider identity evidence, not an independent check of the public TikTok page.

## Proposed production pilot requiring approval

The following is the next bounded deployment, not approval to publish:

- **Database:** Apply additive migration `20261011010000_private_library.sql` to Supabase project `gzvxqzguthrpvjtflxcx`. It creates six private tables and service-only functions. It does not rewrite existing queues, ownership records, analytics, or publisher settings.
- **Backend:** Push the reviewed backend candidate to `Mehdi05-5656/tradvio-reels-backend`, branch `master`. Render auto-deploys the web service and any services watching that branch. Web service: `srv-daenlb8u01pc73f958e0`; existing publisher and analytics services: `crn-daennav40ujc7380f1sg` and `crn-daennbf40ujc7380f3dg`.
- **Feature-worker image:** Push the reviewed candidate to `Mehdi05-5656/tradvio-features-worker`, branch `main`, rebuilding cron `crn-dagba90u01pc73dq0m2g`. Its hourly schedule and default `python worker.py` command remain unchanged. Two private-render scripts are added to the image.
- **Import and history:** Enable only `LIBRARY_IMPORT_ENABLED=1` and `LIBRARY_STATUS_ENABLED=1` on the backend. Import the three reviewed originals into private `managed-raw` paths keyed by their SHA-256 hashes. No overwrites or public storage.
- **Pilot destination:** Instagram `at_trades.2`, Publer account `6ac831b2e73f366e1cbd1699`, owner support@tradvio.com. Register only the three pilot originals initially and create exactly three private jobs.
- **One-off run:** Use a separate 2-CPU/4-GB job based on the existing feature-worker image, with `planId=plan-crn-007`. Set the database ceiling to one active claim and three claims that day. Command:

```text
timeout --signal=TERM --kill-after=30s 1200s env LIBRARY_RENDER_ENABLED=1 LIBRARY_MAX_JOBS=3 python library-worker.py
```

Render lists the 2-CPU/4-GB cron compute rate as $0.00197 per minute, and documents per-second billing for one-off jobs. Build, storage and transfer charges are separate; no new recurring service is proposed. Pricing and billing references: https://render.com/pricing and https://render.com/docs/one-off-jobs.

After read-back, disable private generation and the import endpoint again. Leave read-only history available. Keep all new-account publishing and managed handoff flags disabled.

### Pilot originals

| Original video ID | SHA-256 |
|---|---|
| 7582448651809688845 | a424a018b11a4572fef37d451c072642cda6595cbe0a52399568826e271bd924 |
| 7572479797549370637 | f5ecf46edd873618fd00b74ecefc89d274626bacafdab121e53bd183cddebbd6 |
| 7594331486510189879 | efdd8a21300ceca07f055c7f31eb369b03241f140e285cb4481034f27b576452 |

## Rollback and limits

The web deployment restarts the single backend instance; zero downtime is not promised. Rebuilding the feature-worker image is a production change even though its normal task is unchanged. A full external database backup has not been created for this additive candidate.

Stop new processing by setting the library control off and disabling import. Retain job receipts and private files for reconciliation rather than deleting them. A rollback to previous code does not remove additive tables or revoke already-issued storage upload URLs. Do not rerun an uncertain upload or publication blindly.

## What is still not complete

The full library has not been uploaded or rendered in the cloud. The 15 new accounts have not started posting. The production dashboard has not received this candidate's new private-library status integration.

After the three-job cloud pilot, the remaining steps are full original import, account-by-account private queue expansion with measured cloud capacity and storage limits, full quality review, shared-workspace publishing coordination, exact initial scheduling approval, verified publication-to-variant attribution, and controlled learning experiments. The full-pool requirement remains the target; the small pilot is only a safety check.
