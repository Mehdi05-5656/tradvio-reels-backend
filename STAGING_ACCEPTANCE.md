# Controlled staging acceptance

This package prepares read-only checks for the managed Publer account pipeline.
The isolated database is now provisioned and audited, but no staging application
has been deployed and real-session acceptance has not run. Production posting
remains untouched.

## Current release boundary

- Frontend baseline: `c0e182e`, account-scoped scheduling progress and review warnings.
- Backend baseline before this staging package: `f3f64b0`, account-bound handoffs.
- Approved and created: `tradvio-reels-staging`, project
  `hjojeyewxtmunrwcjjzg`, region `us-west-1`, organization
  `ppwjskrxhcqlkdfadotf` (Mehdi05-5656's Org).
- Approved project quote: $10/month, excluding additional usage charges.
  This replaces the hourly branch proposal; no branch was created. The project
  can incur charges while awaiting the remaining configuration.
- The branch approach was rejected after reviewing production migration history:
  historical migrations embed live Publer destination IDs. None of those seed
  migrations were replayed into staging. The unrelated `tradvio-testing`
  project was not changed.
- Render workspace `tea-daenhlht0dsc73avs4d0` is approved. Its production backend
  and publishing services follow `master`; do not push staging changes there.
- No Render service or environment variable was created or modified. No
  repository push, production migration, live account change or schedule change ran.
- This package starts a separate read-only entry point. The normal production
  entry point and existing three publishing destinations are unchanged.

## Safety architecture

`npm run build-staging` builds `src/staging-readonly.ts`.
`npm run start-staging` starts it after configuration and database safety checks.
Do not use `npm start`, `publisher-tick`, `handoff-tick` or `generation-tick`
for this acceptance environment.

- All POST, PUT, PATCH and DELETE requests return 405 before authentication or
  route handling, even for the operator. No exception exists for webhooks.
- There are no ingestion, provisioning, generation, handoff or legacy publishing
  workers started by this entry point.
- Provider credentials and the legacy shared admin secret are forbidden.
- Its fetch guard allows only GET/HEAD reads from the exact staging Supabase
  origin and selected data/JWKS paths. Provider requests, RPC calls, uploads
  and redirects are blocked. This is an application guard, not a network firewall.
- Production Reels project references are rejected. The startup environment
  must explicitly disable generation/handoff and enable only managed read routes.
- Both database control records must be present and off. Account permissions
  and approvals must be off; no active leases, remote receipts, social post links
  or unpaused legacy slots are allowed.
- Startup failure is a stop, not permission to bypass a guard. Missing tables,
  count errors and absent control rows fail closed.
- The operator-only safety endpoint rechecks database gates before and after
  the acceptance runner. Safety metadata is not returned to other roles.

The read-only entry registers the same managed read handlers and authorization
boundary as production, but intentionally excludes legacy and unrelated dashboard
APIs. A pass therefore validates this managed-account slice, not every app feature.
The 405 layer does not prove production write authorization: the existing
production-route tests independently check operator-only write permissions.

## Isolated environment requirements

Provision only after approval of the exact Render workspace, new database
destination and any quoted hosting cost. Use a fresh schema-only staging
environment, not a production data clone. Do not copy provider keys, social
destinations, media, profile PII, sessions or Auth password hashes.

Backend configuration:

```text
STAGING_MODE=managed-readonly-staging
STAGING_PROJECT_REF=<new, approved, isolated project ref>
STAGING_BUILD_SHA=<reviewed full backend commit SHA>
STAGING_FRONTEND_ORIGIN=https://<approved-staging-host>
SUPABASE_URL=https://<same-staging-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<staging-only secret, secure environment>
MANAGED_PROVISIONING_ENABLED=1
MANAGED_GENERATION_ENABLED=0
MANAGED_HANDOFF_ENABLED=0
INGESTION_WORKER_DISABLED=1
```

Do not attach a production environment group. Omit Publer, CreatorVault, model
provider and shared-admin credentials entirely. Set automatic production
deployment off for the staging branch/service; do not push this branch to master.

The dashboard requires its normal production entry, built for a separate staging
hostname with explicit `VITE_API_BASE`, `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` belonging to staging. Missing configuration can fall back
to production in the current frontend, so inspect the compiled bundle and actual
network destinations before entering any credentials. Never use the fixture
preview as evidence of real authentication.

Navigate directly to the dashboard's `#setup` route for the managed screen checks.
Unrelated overview APIs are intentionally absent from the restricted server.
Keep this staging dashboard on a different origin so production browser sessions
and storage cannot be reused accidentally.

## Database and synthetic fixtures

This isolated managed-account slice uses native Supabase Auth/Storage and a
minimal, empty legacy compatibility foundation, not the complete production
schema. The following reviewed files were applied only to the new project:

```text
staging/foundation.sql
migrations/2026_09_07_endpoint_user_auth.sql
migrations/20260924001500_managed_provisioning.sql
migrations/20260924010000_managed_generation.sql
migrations/20260924020000_managed_handoff.sql
staging/lockdown.sql
```

The foundation rejects nonempty application schemas or existing users/media.
The lockdown adds six constraints that prohibit account/control activation,
approvals, worker leases and remote publication receipts. Legacy compatibility
slots must be paused. Browser roles have no direct public-table access.
An additional staging-only migration pins the profile-lock function search path.
The production privacy migration is not applicable here: its legacy tables are
intentionally absent. None of these omissions proves full legacy-app acceptance.

Create four synthetic, separately authenticated staging identities:

| Actor | Profile role | Expected capability |
|---|---|---|
| Operator | admin | `operate_accounts=true` |
| Viewing admin | admin | `operate_accounts=false` |
| Customer A | user | `operate_accounts=false` |
| Customer B | user | `operate_accounts=false` |

The current operator is pinned to UUID
`71c2308a-9e23-4458-b4f0-df7ae53c841e`, associated with the selected
`support@tradvio.com` operator. An identical email alone does not confer authority.
The independent staging Auth setup must preserve that reviewed operator identity
without copying a production password/session. The installed Supabase Auth SDK's
`AdminUserAttributes` supports an explicit `id`; use its admin create-user flow
with a new synthetic login and fresh secret after secure credentials are available.
Never weaken the production operator check to make a test pass.

Assign at least one synthetic account to each customer, using fake, non-routable
provider IDs and no real Publer workspace. Fixtures should contain distinct
held, blocked, reserved and display-only scheduled/published status rows where
needed, with no remote receipt IDs or social links. Label synthetic outcomes;
they are not proof of publication. Seed only while the staging service is stopped.
Do not invoke any enqueue, activation or publisher RPC during fixture preparation.

Run `staging/database-audit.sql` on the confirmed staging database before and
after acceptance. All eight gate results must be true; all managed tables must
have RLS enabled with neither browser role granted direct access; neither browser
role may execute managed functions. Also inspect private media bucket policies
and confirm that no production media or provider credentials were copied.

## Automated real-session check

Copy `staging/manifest.example.json` to ignored `staging/manifest.local.json`.
Fill in only non-secret target, revision, user and account identifiers.
The placeholder manifest deliberately cannot pass validation.

Obtain fresh JWTs through normal staging sign-in flows for the four identities.
Use secure, ephemeral process inputs for:

```text
STAGING_JWT_OPERATOR
STAGING_JWT_VIEW_ADMIN
STAGING_JWT_CUSTOMER_A
STAGING_JWT_CUSTOMER_B
```

Never put JWTs, passwords or service keys in chat, Git, screenshots or the
manifest. Computer execution must use approved secure credentials, not pasted
secrets. The runner does not log tokens or API bodies and does not mint users
or impersonate a service-role login.

```sh
npm run check-staging -- staging/manifest.local.json
```

The runner sends GET requests only, rejects redirects, checks private/no-store
responses and verifies the staging marker on every response. It checks:

- Exact server-returned identity and operator capability for all four sessions.
- Anonymous and invalid-token denial.
- Complete account lists, pagination and expected ownership.
- Admin visibility of both customers; customer isolation in both directions.
- Attempts to change `customer_user_id`, `user_id` or `role` query parameters.
- Own-account generation/handoff reads and 404 for another customer's account.
- Malformed account IDs and cursors.
- Customer-directory access restricted to the operator.
- No private media/recipe/provider/lease data in customer status responses.
- Matching publishing-off safety reads at the start and finish.

Token claim inspection in the runner only prevents accidental misdirection.
Real signature and session authentication remain the staging backend's job.
A failed safety check stops the run; it never tries to repair, retry or disable
anything automatically.

## Browser acceptance checklist

Use isolated browser contexts for the four staging logins, then a fifth context
for deliberate sign-out/account-switch testing. No fixture authentication is allowed.

| Check | Required result |
|---|---|
| Operator login | Server identity matches the reviewed UUID; managed accounts for both customers visible |
| Viewing admin | Both customers visible, no assignment controls |
| Customer A / B | Only own account cards and progress; no other customer's handle, identifiers or links |
| Customer controls | No editing, publishing, pause, activation or scheduling controls |
| Held-post warning | Visible while video details are closed; never presented as automatic retry |
| Status semantics | Scheduled and provider-reported published remain separate; permission is not worker-health proof |
| Refresh failure | Old information clearly marked stale, never green/healthy by default |
| Revoked access | Cached cards/status disappear on authorization failure |
| Sign out A, sign in B | No A content flashes or survives back navigation, refresh or cached queries |
| Expired session | No protected data shown without a successful refreshed session |
| Network inspection | Only the approved staging frontend, backend and Auth project contacted |
| Mobile and desktop | Readable controls, no horizontal overflow, light/dark rendering verified |

Do not save HARs or traces containing Authorization headers. Record redacted
pass/fail results, actor labels, build SHAs and timestamps instead.

## Completion standard

### Local verification record

- Full backend suite: **125 passed, 0 failed, 0 skipped**.
- TypeScript checking passed.
- Production, staging, generation-worker and handoff-worker builds passed.
  Building a worker does not start it.
- The 12 new staging tests cover startup configuration, outbound request
  restrictions, database gates and privileges, mutation rejection, signed
  synthetic sessions, tenant isolation and deliberately corrupted responses.
- Local signed-session tests use test keys and an in-process authentication
  adapter. They do not prove Supabase JWKS authentication or real sign-in.
- The clean foundation and lockdown also passed an in-memory database test,
  including rejection of enabled controls and unpaused legacy slots.
- Connected staging audit: **8/8 safety gates true**, **21 public tables with
  RLS**, **0 public tables accessible to browser roles**, **0 managed functions
  executable by browser roles**, and **6 staging lock constraints present**.
- Staging contains **0 Auth users, 0 managed accounts and 0 storage objects**.
  Both managed media buckets are private. Fixtures have not been provisioned.
- The security advisor has no remaining WARN/ERROR findings. It reports
  20 informational entries for deliberately deny-all RLS tables without
  permissive policies; this is intentional for backend-only tables
  ([Supabase linter explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)).
- Real staging API acceptance and browser sign-in checks are **not run**.
  No service was deployed and no source was pushed.

### Remaining secure handoff

The connector supplies publishable keys, not the new project's server-side
secret. A local signed-in browser was not reachable during this task. A saved
Supabase Management credential named `Supabase Management API (Tradvio staging
recovery)` is available but requires session approval, which has been requested.
The documented project-key endpoint can supply the staging-only server key
([Supabase Management API](https://supabase.com/docs/reference/api/v1-get-project-api-keys)).
Do not substitute a production key, place a key in this document or paste it in chat.

Next, securely configure the staging-only server key in the new Render service,
then create the four synthetic Auth users through the supported admin API,
assign fixture roles and account rows, and run the API/browser checks. Keep
publishing credentials absent and automatic production deployment untouched.
Do not create a deliberately failing Render service merely to claim deployment.

### Release gate

Local package tests, type checking and builds must pass first. Real staging
acceptance additionally requires the signed-in API runner, browser checklist and
database privilege audit to pass on the approved isolated environment.

If any gate becomes enabled or an unexpected remote receipt appears, stop and
investigate staging independently. Do not cancel, retry, pause or repair production
posts. Local disabling does not cancel posts already queued remotely.

Only after those results are recorded should a separate production release
proposal be prepared. Passing these checks is not authorization to enable
publishing or to make a controlled real post.
