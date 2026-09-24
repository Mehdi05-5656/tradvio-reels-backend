# Account-specific Publer scheduling handoff

Staged build only. No production migrations, pushes, activation, provider writes,
live media disclosure or changes to the three legacy destinations.

Status: implemented and locally verified. The complete backend suite passes
113 tests, including 33 handoff tests. `MANAGED_HANDOFF.md` records the runtime,
approval contracts, limits and remaining rollout gates.

## Test list and implementation order

1. Tests first: disabled gates, eligible quality-passed media only, customer/
   destination/workspace binding, future timezone slots, DST gaps/overlaps,
   reservation uniqueness, grants lasting through the slot, bounded claims.
2. Durable outbox: explicit operator activation, global off-by-default control,
   immutable schedule snapshot, fenced leases, upload and submit intent records,
   provider receipts, append-only state-transition audit.
3. Provider adapter and worker: private signed media, exact account inventory
   check, future-only scheduling, asynchronous read-back, strict post/media/
   caption/time binding, no mutation retries after ambiguous responses.
4. Scoped status and operator control APIs, separate executable, rollout notes.
5. Fault-injection/DB/HTTP regressions, builds, local commit, handoff.

## Safety contracts

- Customers and read-admins cannot activate or mutate scheduling.
- Generation quality success does not itself authorize public publishing.
- Gate activation uses the sole operator identity and an approval reference.
- Instagram feed sharing and TikTok commercial/paid-content settings are explicit
  operator choices, captured in the immutable reservation.
- The account's own assigned timezone/times determine future slots. No immediate
  publish, catch-up burst, auto-scheduling fallback or cross-account fan-out.
- One generation job and one local account/date/time get one reservation.
- Record write intent before HTTP POST. An expired sending lease or missing
  response is held; never assume a failed response means no remote effect.
- Persist upload-job and schedule-job IDs separately. Resume by reads, not POST.
- A job ID or HTTP 200 is not scheduling proof; read the exact provider post and
  match destination, time, caption and media before reporting scheduled.
- Scheduled and published are different states. Published means provider-
  reported, not independently verified at a social permalink.
- Local disable/revocation cannot retract posts already queued at Publer.
  Outstanding remote work must remain visible and require provider review.
- No edits to legacy queues, schedules, captions, publisher or analytics worker.

## Verification limits

Provider transport uses fixtures; no live writes. Current Publer documentation
does not establish an idempotency guarantee. Live contract validation, real
customer JWTs, staging contention, cancellation/offboarding and ongoing content
replenishment remain rollout work, not claims of this implementation.
