# Managed customer assignment and provisioning

Staged implementation, September 23, 2026. This is a backend foundation, not
a deployed customer launch or a video renderer. Do not enable it in production
until the complete release package and migration have explicit owner approval.

## What works locally

- The verified `support@tradvio.com` auth UUID is the sole human operator.
  A matching server-loaded admin profile is required; email strings do not grant access.
- Register an existing, verified non-admin customer against a dedicated Publer
  workspace. Registration records a consent reference, not social credentials.
- Read Publer inventory and persist a short-lived server-generated snapshot.
  The API returns `listed_only`, not a promise of valid publishing authorization.
- Assign an exact observed account to the exact workspace/customer. The
  transaction writes the account, policy/brand inputs, idempotency receipt,
  audit event and durable setup job together.
- Automatic provisioning writes one operator-baseline blueprint and one initial
  batch request. Its target is explicitly chosen slot count × buffer days,
  capped at 24. This is not an eight-post default or a learned model.
- Missing rights produce `rights_not_confirmed`; otherwise the batch stops at
  `renderer_not_configured`. An ineligible owner or disabled workspace blocks
  before a batch is created.
- Customer reads are scoped to their authenticated user ID. Existing read-admin
  visibility remains; only the selected operator can mutate.

## API contract

All responses are private/no-store. All routes default to disabled unless
`MANAGED_PROVISIONING_ENABLED=1`. All mutations require the operator's
Supabase bearer session, not `x-app-secret`.

| Method and path | Input / result |
|---|---|
| `GET /api/admin/managed/customers` | Operator-only customer directory, 50 rows/page. Optional UUID `after`; verification is rechecked during assignment. |
| `POST /api/admin/managed/workspaces` | Exact body: `customer_user_id`, `workspace_id`, `consent_ref`. Reads provider inventory before registration. Returns workspace ID, inventory ID and normalized listed accounts. |
| `POST /api/admin/managed/discover` | Exact body: `workspace_id`. Refreshes inventory for an enabled registered workspace. |
| `POST /api/admin/managed/assign` | Exact body below. Returns HTTP 202 with `account_id`, `setup_dispatch`, `publishing_enabled:false`, and status endpoint. |
| `GET /api/managed/accounts` | Owner-scoped status, 50 rows/page with optional UUID `after`. Admins can read all. No private blueprint, consent reference or raw provider response. |

Assignment input:

```json
{
  "customer_user_id": "<verified customer UUID>",
  "workspace_id": "<registered dedicated Publer workspace>",
  "inventory_id": "<server-created snapshot UUID>",
  "publer_account_id": "<exact observed provider account ID>",
  "idempotency_key": "<8-128 characters, reused for the same intent>",
  "policy": {
    "timezone": "America/Los_Angeles",
    "slot_times": ["10:00", "16:00"],
    "buffer_days": 3
  },
  "brand_inputs": {
    "audience": "New traders",
    "voice": "Educational and factual",
    "language": "en",
    "cta": "Learn more"
  },
  "rights_confirmed": false
}
```

The schedule above is an example, not an approved customer publishing policy.
Times must be unique, valid local HH:MM values; 1–8 per day. Buffer is 1–3 days.
All four brand strings are required and limited to 500 characters. Unknown
fields, including passwords, observed handles or submitted provider facts, are
rejected. `rights_confirmed` is an operator attestation, not automatic license verification.

## Transactions and recovery

Inventory expires after five minutes for new assignments. An exact prior
idempotency receipt may be replayed without a new snapshot because it cannot
create or change anything. Different request keys for the same unchanged
destination resolve to the existing account and get their own immutable receipt.
Changed inputs conflict rather than silently updating an existing assignment.

Destination uniqueness, workspace/customer foreign keys, transaction locks and
unique initial-job/batch keys prevent duplicate assignment work. The same Publer
account ID cannot move between customers. Existing legacy workspace/account IDs
are rejected; no original slot, schedule, queue or historical row is rewritten.

After committing assignment, the API tries one bounded provisioning sweep.
Failure returns `setup_dispatch:pending_recovery`, not a misleading failed
assignment. `attempted` means a sweep ran; it does not prove this specific account
was processed, so read the status endpoint. An enabled web process also sweeps
on startup and every 60 seconds, at most five pending jobs per sweep.

Provisioning uses `FOR UPDATE SKIP LOCKED` inside one short database transaction,
with no provider/network/model/render calls. A crash or exception rolls back
both output and completion, leaving durable pending work. External rendering
will require separate fenced leases; none are claimed to exist here.

## Safety boundaries and remaining work

- New account rows have a database constraint forbidding `publishing_enabled=true`.
  The legacy publisher cannot see these rows, so enabling this flag does not
  schedule or publish anything.
- All eight new tables have RLS and browser privileges revoked. Service role
  reads tables and writes through narrowly named security-definer functions.
  Browser roles cannot execute those functions.
- Owner deletion is restricted while assigned records exist to preserve history.
  A complete offboarding/retention workflow is still required.
- There is no mapping edit, pause/retry/reset or reassignment API in this slice.
  Blocked setup remains visible and does not churn paid retries.
- Provider-native social ID deduplication across different Publer registrations
  is not implemented. Current identity checks use exact Publer account IDs.
- Workspace registration and its inventory snapshot are separate transactions.
  A snapshot failure may leave a registered workspace; retry the same registration
  or refresh discovery. Registration itself is idempotent.
- Staged UI: admin assignment and customer setup status are implemented in the
  companion frontend. `/api/me` supplies UUID/profile-checked operator capabilities
  with private/no-store caching. Missing capability hides write controls; the
  backend still independently authorizes every mutation.
- Pending: recent-auth/MFA checks for sensitive assignment, provider health/rate-capacity
  validation, licensed raw assets, renderer, meaningful-variation checks, media QC,
  account-based scheduling, analytics attribution and the learning loop.

## Verification and release gate

The suite has 61 passing tests: existing regressions plus operator capability checks, SQL validation,
idempotency conflicts, tenant boundaries, browser privilege denial, staged
HTTP-to-SQL setup, rollback recovery, and rights/renderer blocking. TypeScript,
web backend and scheduled-worker builds pass. Tests use local PGlite, synthetic
authenticated request contexts and a stubbed provider. They do not verify live
Supabase JWTs, live Publer authorization, or multi-connection production
Postgres contention.

The companion frontend has seven unit tests and thirteen simulated browser
check groups. Assignment review preserves the exact request key on retry,
invalidates stale customer/workspace inventory, and distinguishes accepted,
blocked, unavailable and out-of-date status. Its private preview has no live
API calls; it is not proof of production account health.

Before rollout: finish sensitive-action step-up and shared-secret caller
migration, run staging with real operator/customer sessions and multi-connection
Postgres tests, review rights and cadence, then obtain approval for the exact
migration/backend/frontend package. Apply the additive migration before starting
code with the feature enabled. Keep it disabled until staging acceptance passes.

Rollback before activation is to disable `MANAGED_PROVISIONING_ENABLED` and
restart the backend. Keep the new data and audit history; do not drop tables or
undo legacy publication rows. There are no new external posts to retract from
this implementation.
