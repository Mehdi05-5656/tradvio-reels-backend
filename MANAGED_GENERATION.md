# Managed Video Generation and Quality Checks

Staged backend implementation for Tradvio. This release adds real rendering and
quality gates to the existing customer-assignment foundation; it does not deploy,
schedule or publish customer content. The sole human operator remains
`support@tradvio.com`, enforced by the existing verified UUID and admin profile.

## What this build adds

- **Licensed source registry:** immutable MP4 identity, SHA-256, byte count,
  duration, operator-approved factual notes, audio-rights attestation and license
  reference. No existing queue item is automatically treated as licensed.
- **Account-specific use grants:** each customer account needs an explicit source
  grant, consent reference and expiry. A shared source pool is not a blanket
  permission to use every clip for every customer.
- **Durable generation jobs:** one initial job per requested batch position,
  using the assigned schedule's existing target rather than a hardcoded cadence.
- **Account-specific planning:** a configurable Anthropic model receives brand
  inputs, approved notes and eight timestamped source-frame samples. It proposes
  an educational angle, copy and nonoverlapping source segments.
- **Actual rendering:** FFmpeg assembles 3–6 selected segments, renders readable
  title/teaching overlays and normalizes the licensed source audio. Output is a
  12–45 second, 720 × 1280, 30 fps H.264/AAC MP4.
- **Quality gates:** strict plan validation, full output decode, geometry/codec/
  duration checks, audio-level checks, sampled empty-frame checks, exact hashes,
  cross-customer recipe similarity and sampled perceptual comparisons.
- **Separate content review:** a second model request sees approved notes, the
  complete proposed copy and four rendered frames. Missing, malformed,
  uncertain or negative review never falls back to publishing the raw clip.
- **Private completion:** accepted media is stored under its customer/account/
  job/attempt path. An entire accepted batch reports
  `scheduler_not_configured`; publishing remains false by database constraint.

This is an LLM-assisted, cold-start editorial pipeline. It is not a trained
performance-learning model, and it does not synthesize entirely new footage or
voiceovers. Analytics feedback and model learning remain a later stage.

## Processing and recovery

The worker is separate from the HTTP server. One invocation performs at most one
external generation job; the deployment's scheduler must invoke it repeatedly
after approval. Account provisioning continues to create durable initial batch
requests, which the enabled generation worker discovers.

Two independent gates must be on: `MANAGED_GENERATION_ENABLED=1` in the worker
and the database generation control. Both are off by default. HTTP setup routes
also require the existing `MANAGED_PROVISIONING_ENABLED=1`.

Claims are serialized for capacity and daily-budget enforcement. Defaults are
two active jobs and 24 claims per UTC day; operator limits are bounded at four
active jobs and 100 daily claims. These are attempt-count controls, not dollar
budgets. Each attempt makes at most one planning and one review request, each
with a 2,200-token output cap. Retrying a persisted plan does not plan it again.

Each claim receives a new token and a ten-minute lease. The worker renews every
30 seconds and before consequential stages, with an eight-minute overall work
deadline. Old tokens cannot reserve or complete work. At most three claims are
allowed per job; classified transient model/storage errors use a five-minute
delay. Quality failures do not automatically retry. Unknown failures block
rather than consuming an unbounded retry budget.

Rights, workspace, customer eligibility and the database gate are rechecked
throughout processing and at completion. A corrected source grant may requeue
only eligible, rights-blocked jobs with attempts remaining; it never resets
attempts or restarts failed quality checks. Other quarantined jobs need operator
investigation. There is no generic reset/retry UI in this slice.

An interrupted upload or lost database response can leave a private orphan
artifact. Attempt paths are immutable and never overwritten; stale workers
cannot mark their output accepted. Automated orphan retention/cleanup is not
implemented. `failure_unconfirmed` means the worker could not confirm its final
database state and requires a status read, not an assumed failure.

## Privacy and security

The additive migration creates five server-only tables: raw assets, use grants,
generation control, jobs and attempt receipts. Browser roles have no table or
internal-RPC access; service writes use specific security-definer functions.
Only operator-authorized HTTP requests can register sources, grant use or alter
generation control. Read-admins can inspect customer progress but cannot mutate.

When applied to a Supabase database, the migration creates private
`managed-raw` and `managed-variants` buckets and adds a restrictive object policy
that denies browser access to those buckets even if another policy is broad.
An already-public managed bucket aborts the migration for investigation rather
than silently changing an existing bucket. Legacy media policies and publishing
rows are not rewritten.

The worker verifies private bucket configuration before claiming. Downloads use
only a signed URL from the configured Supabase origin and exact source path,
reject redirects, cap bytes and verify the registered hash. FFmpeg uses
generated local paths, no shell, MP4 demuxing, disabled external data references,
bounded execution and restricted input protocols. Storage uploads cannot upsert.
Job progress responses contain no raw notes, recipes, credentials or media paths.

## Operator and customer API

All responses are private/no-store. The operator identity is derived from the
authenticated server context, never accepted in a request body.

| Endpoint | Purpose |
|---|---|
| `POST /api/admin/managed/assets` | Register immutable source metadata after a trusted operator uploads the MP4 to private storage. This endpoint does not fetch arbitrary URLs or upload media. |
| `POST /api/admin/managed/grants` | Grant or revoke one asset for one managed account, with consent reference and expiry. |
| `POST /api/admin/managed/generation-control` | Set the database enable flag, active-job limit and daily-claim limit. Enabling this can start billable processing if the worker is also enabled. |
| `GET /api/managed/generation/:accountId` | Owner-scoped initial-batch job status, at most 24 rows. Admins may read all. A foreign or absent account returns the same 404. |

Source metadata is an exact object:

```json
{
  "bucket": "managed-raw",
  "object_key": "approved/source.mp4",
  "sha256": "<64 lowercase hexadecimal characters>",
  "bytes": 123456,
  "duration": 30,
  "facts": "Operator-reviewed factual and editorial notes for this exact source.",
  "audio_rights": true,
  "editorial_approved": true,
  "license_ref": "<license evidence reference>"
}
```

Grant fields are `account_id`, `asset_id`, `consent_ref`, `expires_at` and
`enabled`. Control fields are `enabled`, `max_active` and `max_daily_claims`.
Do not place passwords or provider credentials in these payloads.

The existing setup screen has not been expanded to display per-video progress
or ingest raw assets in this slice. The new API supplies that integration point;
unrecognized account block reasons still use the existing conservative
operator-review message.

The original batch row remains the immutable provisioning request, including
its original blocker. Current generation progress comes from the job rows and
account status, not from rewriting that historical batch field.

## Verification

The backend suite now contains 80 passing tests, including 19 new checks/test
groups. TypeScript checking, the web-backend build and the standalone generation
worker build pass. Running the worker with generation disabled returns
`disabled` without credentials or provider calls.

Coverage includes migration replay, operator restrictions, owner-scoped HTTP
reads, browser/RLS denial, an existing broad storage policy, source identity,
grant expiry/revocation, lease replacement and fencing, global capacity/daily
limits, bounded retries, recipe collision across customers, wrong-tenant output
paths, malformed quality results and perceptual duplicates.

Real local FFmpeg tests render synthetic diagnostic footage and reject silent,
black, corrupt and incorrectly sized media. A complete local integration runs
assignment, provisioning, source registration, grant, job claim, rendering,
quality checks, private-storage simulation and fenced database completion.
Its final database row remains nonpublishing. A rendered diagnostic frame was
also visually inspected for text placement and clipping.

Model responses and storage transport are simulated in acceptance tests.
No paid model calls, live customer footage, live Supabase changes or live posts
were used. Database tests use local PGlite; they are not multi-connection
production PostgreSQL contention tests. The Dockerfile is provided, but no
Docker runtime was available here to build and smoke-test that image.

## Rollout inventory and remaining gates

Code is staged on `feature/publer-managed-customers`; nothing was pushed.
This slice adds migration `20260924010000_managed_generation.sql` after the
existing assignment/provisioning migration, a separate `generation-tick`
executable, `Dockerfile.generation`, worker modules, API routes and tests.
There are no frontend changes in this slice.

Before any production activation:

1. Approve the exact migration, backend and separate-worker deployment package.
   Preserve the prior unpushed identity/assignment changes in the release.
2. Run a staging migration against actual Supabase storage and auth, and test
   real operator/customer sessions plus simultaneous PostgreSQL workers.
3. Build and smoke-test the container with CPU/memory limits, a read-only root
   and bounded temporary storage. Pin the deployed image and model versions.
4. Configure server-only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ANTHROPIC_API_KEY`, `MANAGED_PLANNER_MODEL` and `MANAGED_REVIEW_MODEL`.
   No model name or credential is silently selected by this implementation.
5. Obtain licensed test media, account-specific grants and explicit approval
   for that media/brand data to be processed by the model provider.
6. Run a small paid staging acceptance batch. Calibrate similarity and quality
   thresholds using real examples, and review complete audio/video manually.
7. Set a conservative cadence and attempt limit, enable the two generation
   gates only after acceptance, and monitor blocked/retrying jobs and storage.
8. Build the account-scoped Publer scheduling handoff before any posting launch.
   This generation slice cannot schedule or publish.

Similarity is heuristic: word-pair overlap is not semantic equivalence, and
eight sampled visual hashes can miss or over-reject variants. Editorial review
sees sampled images and notes, not the complete motion or audio transcript.
Source licensing and factual approval remain operator attestations. No claim
is made that a variant is legally cleared, factually perfect or guaranteed to
avoid a platform's duplicate-content classification.

The implementation currently supports English/ASCII copy, one initial batch per
account and source-audio preservation. Future work includes continuous batch
replenishment, calibrated full-content review, retention/offboarding, richer
per-video UI, scalable similarity indexing, scheduling, analytics attribution
and the performance-learning loop.

To stop processing after an approved rollout, disable database generation
control and the worker's environment gate, then stop worker invocations. Keep
the records and audit receipts; do not drop tables or change existing Publer
queues. Accepted artifacts remain private and unscheduled.
