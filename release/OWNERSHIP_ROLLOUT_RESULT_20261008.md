# Tradvio Reels 18-account ownership rollout result

The approved ownership-only production rollout completed on October 8, 2026, Pacific time. All 18 Publer destinations are mapped to support@tradvio.com; new managed publishing remains disabled.

## Production state

- Ownership: nine Instagram and nine TikTok accounts, all owned by user `71c2308a-9e23-4458-b4f0-df7ae53c841e`. Exact IDs match the approved inventory in `OWNERSHIP_DEPLOYMENT_20261008.md`.
- Existing publishers: `phone_a`, `phone_b`, and `tiktok_tradvio` retain their exact prior configuration, including owner, destination, daily target eight, unpaused state and September 23 update timestamps.
- New destinations: 15 ownership-only accounts, awaiting content setup. Assignment is not evidence of publishing authorization or successful delivery.
- Managed state: zero managed accounts, generation jobs, handoffs and registered raw assets. Database generation and handoff controls remain disabled.
- Runtime gates: provisioning, generation and handoff flags remain `0` on all three existing Render services, nine flags checked.
- Privacy: ownership table RLS is enabled; anonymous and authenticated browser roles have no direct SELECT access. API account queries remain owner-scoped for customers and cross-owner for authorized admins.
- Historical held submissions were not reset, retried or cancelled. No production credentials were replaced.

## Deployment receipts

### Database

Production project: `gzvxqzguthrpvjtflxcx`. Both migration applications succeeded and their ledger entries were read back:

| Migration name | Recorded database version |
|---|---|
| managed_operator_owner | 20261009010347 |
| publer_ownership | 20261009010400 |

Fresh Publer inventory observed at `2026-10-09T01:04:05Z` was compared to the approved immutable destination IDs. The atomic assignment returned `mapped_accounts: 18`; postdeployment readback confirms all 18.

### Backend

Master commit: `6a7c45a995538e44491d547624e6fad276c009bd`.

| Service | Deployment | Outcome |
|---|---|---|
| Web | dep-db43r9u0tbcc73cl8ftg | Live; finished 2026-10-09T01:05:19Z |
| Publisher cron | dep-db43ra60tbcc73cl8g70 | Live; finished 2026-10-09T01:04:51Z |
| Analytics cron | dep-db43ra60tbcc73cl8g8g | Live; finished 2026-10-09T01:04:52Z |

The [backend health endpoint](https://tradvio-reels-backend.onrender.com/healthz) returned HTTP 200. Anonymous requests to `/api/v2/accounts` and `/api/managed/accounts` returned HTTP 401.

### Dashboard

Frontend candidate: `07a409a672daae2d8f07e268793c270035290738`.

Deployment `dpl_cZhbz2KL4orRWWdXHwvG863VxGeW` was independently inspected as Ready for production in the existing Vercel project. The [production dashboard](https://tradvio-reels.vercel.app) serves the tested build; the [deployment record](https://vercel.com/tradvio/tradvio-reels/cZhbz2KL4orRWWdXHwvG863VxGeW) identifies this release.

Production asset SHA-256 hashes exactly match the local production build:

| Asset | SHA-256 |
|---|---|
| index.html | e4a8910440a8a27c65c367f1dad828bb460b4c2aa1bb85dc50a9cacbb8e85897 |
| index-DJZ9ZLu0.js | b291ff1cf196c6288152c9c3badff273132a884342a04d9d0c24f70e2335a398 |
| index-DzxwZlHm.css | 44839533dff3f3e008044ba6513fd1ace4f12c3613170b4b85ea5b6fad273257 |

The secondary team alias redirects unauthenticated requests to Vercel SSO. Its asset hashes were therefore not compared; use the main production URL above. No deployment-protection setting was changed.

## Verification

- Full backend suite: 135 passed, zero failures, zero skipped, run after deployment.
- Frontend unit suite: 18 passed in candidate checks.
- Backend and frontend typechecks and required builds passed during candidate preparation.
- Local migration replay, atomic ownership assignment, conflicting-owner protection and no-activation tests passed.
- Prior fixture-based browser checks covered assignment, status reporting, customer isolation, provider errors, safe links and desktop/mobile layouts.
- Production public-browser smoke: sign-in renders, protected `/accounts` shows sign-in, no page exceptions, no horizontal overflow at 375px.
- Real signed-in operator/customer production checks remain pending. No synthetic login or fake operator session was created.

## What the interface represents

The deployed interface distinguishes assignment, raw-video processing, quality checks and scheduling. It does not label an account ready based merely on assignment or partial generation; completed target counts and matching scheduling evidence are required.

For the 15 new destinations, the correct present state is assigned and awaiting content setup. All 18 being discoverable and unlocked in Publer is not a guarantee that all 18 can publish successfully.

## Remaining work in safe order

1. Verify the signed-in support@tradvio.com Accounts view and a real customer-isolation view.
2. Resolve shared-workspace upload/submission coordination. Every destination shares the legacy workspace, which managed handoff currently excludes. Do not remove that exclusion without concurrency and ambiguous-submission protections.
3. Identify the authorized raw-content pool and confirm reuse rights, account-specific blueprints, batch sizes and cadence. No raw assets are registered in the managed pipeline yet.
4. Run one real account-specific batch with publishing disabled. Inspect complete video playback, audio, captions, factual claims and meaningful differentiation; automated rendering tests alone do not establish editorial quality or platform acceptance.
5. Present the exact account, videos/captions and future schedule for a controlled publishing pilot. Only then enable the approved scope.
6. Verify provider receipts and public delivery before expanding account by account. Continuous replenishment and performance-feedback learning still require end-to-end acceptance.

This release establishes ownership and honest visibility, not fully automatic operation across 18 accounts. Existing schedules were preserved, but today's delivery for the legacy accounts was not independently audited in this rollout.
