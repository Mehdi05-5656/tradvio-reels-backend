# Account-Specific Publer Scheduling Handoff

Built and verified locally on `feature/publer-managed-customers`. This is a
staged backend implementation, not a production deployment or proof of a live
post. No provider writes, live media transfers, production database changes,
account activation, new hosted workers or GitHub pushes occurred in this slice.

## What this adds

- **One-account scheduling:** Each quality-passed generation gets at most one
  reservation tied to its customer, assigned Publer workspace, exact destination,
  approved caption, private artifact, platform settings and publication time.
- **Operator-only activation:** Only the identity-bound `support@tradvio.com`
  operator can enable an account. Customers have read-only status; other
  administrators retain read access without activation authority.
- **Future slots:** The account's assigned timezone and local posting times
  determine slots. Reservation starts at least one hour ahead, considers 14 local
  dates, skips nonexistent spring-forward times and chooses the later occurrence
  of a repeated fall-back time. Missed slots are blocked, not published immediately.
- **Private media verification:** Before upload, the worker checks the private
  bucket, exact customer/account/generation path and SHA-256 of the stored video.
  A ten-minute signed URL is held only in memory and disclosed only to Publer's
  upload endpoint. It is not returned to customers or saved in audit records.
- **Durable handoff:** Upload and schedule submission have separate job IDs and
  pre-request intent checkpoints. Restart recovery resumes acknowledged jobs
  through reads rather than repeated POSTs.
- **Conservative verification:** A job ID or completed job alone does not mean
  scheduled. The worker reads the exact post and checks its account, caption,
  media ID and timestamp before recording `scheduled` or `published`.

The adapter uses Publer's explicit future-scheduling request, with
`bulk.state="scheduled"` and one `accounts[].scheduled_at`; Publer documents a
minimum one-minute lead time, while this implementation requires ten minutes
at submission ([Publer manual scheduling](https://publer.com/docs/posting/create-posts/publishing-methods/manual-scheduling)).
No immediate-publish endpoint, automatic scheduling fallback, recycling,
recurrence or cross-account fan-out is used.

## Approval and isolation

Three gates must allow new work: the worker environment flag, global database
handoff control and the account's unexpired operator approval. Account rights,
asset grants and workspace/customer eligibility are rechecked, including whether
the rights and approval last through the reserved publication time. Pausing
generation alone does not prevent previously approved, quality-passed artifacts
from being scheduled.

Activation records an approval reference, expiry and explicit platform settings.
Instagram requires an explicit feed-sharing choice. TikTok requires explicit
public visibility, comments, duet, stitch, promotional and paid-content settings;
the worker does not silently classify customer content as noncommercial.
Approval must cover the intended cadence, destination, media disclosure and
content classification. Different commercial classifications should not share
one account-level approval in this version without operator review.

Changing the approved caption, artifact, assigned destination or publication
settings invalidates an unsent snapshot. Browser roles cannot directly read or
write handoff tables or execute handoff mutations. The service role has direct
read access and narrowly named mutation functions, not direct table-write grants.

The migration drops the earlier managed-account `publishing_enabled=false`
constraint to permit explicit activation, but changes no existing flag to true.
New controls and all previously unactivated accounts remain disabled.

## State and failure handling

The normal sequence is:

```text
quality_passed
  -> reserved
  -> upload_sending -> upload_wait
  -> media_ready
  -> submit_sending -> submit_wait
  -> confirming
  -> scheduled
  -> published or failed
```

- **Uncertain remote writes:** A timeout, missing response or expired sending
  lease results in `held` with an unknown-outcome reason. No automatic mutation
  retry is allowed. Re-enabling controls does not reset held work.
- **Read failures:** Temporary provider read failures defer reconciliation.
  Claims have a daily budget; unresolved asynchronous work becomes held once
  its intended publication time is more than 24 hours old.
- **Wrong or incomplete receipts:** Multiple results, different destinations,
  missing IDs, changed media/text/time, mixed failure payloads and locked-plan
  responses are rejected or held. Unknown success shapes are not guessed.
- **Calendar conflicts:** Account-scoped Publer calendar checks run before
  upload and again before submission. Unknown pagination, more than three
  pages or an existing post at the same instant stops the handoff.
- **No scheduling guarantee against human races:** Local uniqueness and
  serialized claims prevent this worker from reserving the same local slot
  twice. A human or another integration can still add a Publer post after
  the final calendar read; exclusive operational control remains necessary.
- **Scheduled versus published:** `scheduled` is provider-confirmed future
  scheduling. `published` is provider-reported publication, not an independently
  checked social permalink. A missing permalink does not prove failure.

The inspected job-status documentation describes asynchronous status envelopes
but does not define a concrete successful scheduled-post payload with all IDs;
the strict result parsers therefore still need live contract acceptance before
activation ([Publer creating posts](https://publer.com/docs/posting/create-posts)).
Post-detail read-back uses the documented account, timestamp, text and media
fields ([Publer posts API](https://publer.com/docs/api-reference/posts)).
The current inventory check proves that an exact account is listed, not that its
authorization will remain healthy indefinitely ([Publer accounts API](https://publer.com/docs/api-reference/accounts)).

## API contracts

All routes require application authentication and the managed-setup feature
gate. Every route independently enforces the appropriate operator or owner check.
Customer responses use `Cache-Control: private, no-store`.

| Route | Authority | Purpose |
|---|---|---|
| `POST /api/admin/managed/handoff-control` | Sole operator | Global handoff permission and daily claim budget |
| `POST /api/admin/managed/handoff-activation` | Sole operator | Account permission, approval expiry and platform settings |
| `GET /api/managed/handoffs/:accountId` | Owner or viewing admin | Up to 24 initial-batch statuses, scheduled times, error codes and remote-review flags |

Global control body:

```json
{"enabled": false, "daily_claims": 100}
```

Instagram activation body, for an approved future rollout:

```json
{
  "account_id": "<managed account UUID>",
  "enabled": true,
  "approval_ref": "<record of approved media, cadence and provider disclosure>",
  "expires_at": "<future ISO-8601 timestamp>",
  "publication_settings": {"feed": true}
}
```

For TikTok, replace `publication_settings` with the operator's reviewed values.
This is a shape example, not authorization or a content-classification recommendation:

```json
{
  "privacy": "PUBLIC_TO_EVERYONE",
  "comment": true,
  "duet": false,
  "stitch": false,
  "promotional": true,
  "paid": false
}
```

To disable an account, use `enabled:false`, a recorded reason in `approval_ref`,
a valid timestamp and `publication_settings:null`; the prior platform choices
are retained. Do not put passwords or API keys in any approval payload.

`publishing_enabled` in status responses means account-level permission, not a
healthy worker or confirmed publication. Generation status now returns the
actual account permission and a scheduling-status URL instead of hardcoding
publishing as disabled. Existing setup screens have not yet been expanded into
a per-video schedule/review console; the new endpoint is their integration point.
Historical provisioning batch blockers and generic account blocker messages are
not authoritative per-video scheduling status.

## Runtime and migration inventory

New migration: `migrations/20260924020000_managed_handoff.sql`. It follows the
existing managed provisioning and generation migrations. Preserve the earlier
identity, server-only privacy and assignment changes when preparing a release;
do not deploy this migration as an isolated production patch.

New runtime modules are `managed-handoff.ts`, `managed-publer.ts`,
`handoff-storage.ts`, `handoff-routes.ts` and `handoff-tick.ts`. Small integrations
register the routes, allow owner-scoped reads, update generation status and add
build commands. The legacy Publer adapter, scheduler, publisher, analytics and
alert-worker source files remain unchanged.

```sh
npm run build-handoff
npm run handoff-tick
```

The executable returns `{"status":"disabled"}` unless
`MANAGED_HANDOFF_ENABLED=1`. An enabled worker requires server-only
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `PUBLER_API_KEY`.
No worker invocation schedule or production secret has been created.

Each invocation handles one durable stage, not an entire batch. The database
serializes active claims globally, enforces a minimum 15-second claim spacing
and defaults to 100 claims per UTC day, configurable from 1 to 500.
Leases last three minutes, provider requests have a 30-second timeout, response
JSON is capped at 1 MiB, and media verification is capped below 64 MiB.
The provider/storage phase uses a shared two-minute deadline; database transport
is bounded separately.

These are conservative pilot limits, not a production throughput promise.
At least five successful claims are needed to confirm one scheduled video,
plus subsequent publication read-back and pending polls. Measure the desired
cadence and combined legacy/managed Publer usage before selecting a worker
frequency or increasing limits. There is not yet a shared provider-wide quota
coordinator with the legacy publisher.

## Verification record

The complete backend suite passes **113 tests, zero failures or skips**,
including **33 new handoff tests**. TypeScript checking, web-backend build,
legacy-worker builds, generation-worker build and handoff-worker build pass.
The handoff executable was smoke-tested with its environment gate absent and
made no database, storage or provider calls.

New coverage comprises 11 database, 8 provider-contract, 9 worker/recovery,
3 HTTP authorization and 2 private-storage tests. Cases include migration
replay, two-customer isolation, unique slots, DST changes, rights expiry,
operator activation, explicit disclosures, customer/read-admin denial,
stale leases, daily caps, durable intent rejection, lost acknowledgments,
ambiguous upload/submission, exact post read-back and changed approved inputs.

Database tests use local PGlite and apply migrations twice. Provider, storage,
identity and network faults use fixtures. The existing full suite also runs
real FFmpeg tests on synthetic media, but no live customer media, paid model
generation or Publer mutation was performed for this handoff.
Fixture success does not establish live Publer contract compatibility or
multi-connection production PostgreSQL contention safety.

## Rollout and stop procedure

Before production:

1. Review and approve the complete unpushed release inventory, migrations and
   separate-worker deployment. Keep the three legacy destinations unchanged.
2. Apply staged migrations to an isolated Supabase test project; test real
   operator/customer JWTs, browser RLS, replay and simultaneous database clients.
3. Use a dedicated, nonlegacy test account/workspace and explicitly approved
   licensed media. Validate actual upload, job, calendar and post-detail shapes
   through one authorized scheduled-post acceptance test. Do not relax matching
   checks merely because a provider shape differs.
4. Confirm the exact account/time/media/caption/disclosures in Publer, then check
   provider publication and an actual social permalink where available.
5. Validate capacity, combined provider usage, shutdown, manual remote
   cancellation and alert routing. Integrate per-video state into the admin and
   customer screens before presenting automated publishing as operational.
6. Only then activate the chosen account, global control and worker invocation
   frequency. Start with one account and a small batch.

To stop new submissions, disable database control or the account approval first.
Keep the worker environment enabled for read-only reconciliation until outstanding
remote work has been reviewed. The API explicitly returns
`external_schedules_cancelled:false`: already submitted or scheduled posts may
still publish. Inspect and cancel them in Publer when required; disabling a
local flag is not cancellation. Once reconciled, stop worker invocations.

Held or unknown-outcome rows require exact provider investigation. This slice
does not provide a blind retry/release button or automated cancellation.
Preserve receipts and reservations; do not delete rows to force resubmission.
New-work gates are checked immediately before durable write intent, but cannot
atomically cancel a request already in flight.

Still separate work: operator reconciliation/cancellation tooling, per-video
dashboard presentation, continuous batch replenishment, managed-post analytics
attribution, performance-learning integration, offboarding/retention and
production alert routing. The handoff is built; the full continuously operating
customer service is not yet verified end to end.
