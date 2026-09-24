# Managed generation and quality checks

Staged implementation. No deployment, live media ingestion, paid model request,
customer assignment or publishing is authorized by this build.

## Implementation order

- Tests: rights/tenant gates, explicit feature gate, immutable source identity,
  target sizing, leases/fencing, retry limits, global budget, recipe reservation,
  browser privilege denial, quality failures and real local video rendering.
- Database: additive licensed source/grant registry, durable per-batch jobs,
  attempt receipts, atomic claims/reservations/completion and read-only status.
- Worker: bounded private downloads, structured account-specific editorial
  planning, actual FFmpeg rendering, full decode/probe/audio checks, sampled
  perceptual fingerprints and independent multimodal content review.
- Integration: operator-only source/grant APIs, owner-scoped progress endpoint,
  separate disabled-by-default worker executable/container, rollout inventory.
- Verification: regressions, real local synthetic-video integration test, failure
  injection, no legacy queue/publisher writes, documentation and local commits.

## Acceptance checks

- Feature off performs no generation or provider calls.
- Existing batch targets are used, never a copied eight-post default.
- Only explicitly approved MP4 sources with a live account-specific use grant,
  verified hash, audio rights, editorial review and eligible owner may run.
- Anonymous/customers/read-admins cannot ingest, grant, claim, retry or complete.
- Browser roles cannot access pipeline tables or invoke internal RPCs.
- Repeated enqueue does not duplicate work; active and daily claims are bounded.
- Expired worker tokens cannot renew, reserve or complete. Recovery is capped.
- Rights/workspace/owner revocation blocks completion even after a render.
- Plans must have distinct source segments and substantive educational copy,
  fit time/text limits and never carry shell commands, URLs or arbitrary paths.
- Recipe/semantic reservations are global by source hash, not by customer.
- Decode, geometry, duration, codec, audio and empty-frame failures quarantine.
- Exact-output/perceptual collisions cannot pass final completion.
- Missing, malformed, refused or negative independent content review blocks.
- LLM output is untrusted. No model failure silently falls back to source clips.
- Storage paths are tenant/account/job/attempt-scoped and private.
- Ready means quality-passed private media, not scheduled or published.

## Explicit limitations

LLM-assisted editing is not a trained performance-learning model. Similarity
and model review are conservative heuristics, not proof of copyright clearance,
factual correctness or platform duplicate-content acceptance. No live rights
are inferred from existing queue rows. Production needs calibrated quality
thresholds, licensed sources, approved model/data-processing settings, real
session acceptance and multi-connection PostgreSQL contention tests.
