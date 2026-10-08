# Operator-owned Publer accounts and pipeline progress

## Requested outcome

Assign the user's reported 14 Instagram/TikTok Publer accounts to support@tradvio.com.
Verify account-specific repurposed videos, then scheduling and publication for one
account before expanding. Customers retain read-only access to their own data.

## Verified starting point

The auth user and admin profile for support@tradvio.com exist with UUID
71c2308a-9e23-4458-b4f0-df7ae53c841e. Production has zero managed accounts,
zero registered managed raw assets, zero generation jobs and zero handoffs.
Both managed generation and handoff database controls are disabled.

The three persisted legacy slots are already owned by that UUID:
Instagram @tradvio, Instagram @tradingwithalexx_, and TikTok @Tradvio.
They remain unpaused with a daily target of eight. These settings are not
independent proof of today's publication or current provider authorization.

The saved read-only Publer credential returned HTTP 401. No local signed-in
browser is reachable. The 14-account inventory, exact account IDs, workspace
placement, authorization health and current publication status are unverified.
No credentials were exposed, extracted from production, or replaced.

## Candidate changes

- Allow only the designated operator UUID, in an active verified admin profile,
  to own managed accounts in addition to ordinary eligible customers.
- Include the operator's profile in the assignment selector.
- Preserve legacy-workspace and legacy-destination exclusions. Existing live
  slots cannot be assigned a second managed publisher.
- Include persisted managed accounts in the main account inventory, filter
  customers by server-side ownership, prefer email owner labels for admins,
  and avoid duplicating provider-discovered cards.
- Add the initial batch's target count to the owner-scoped generation endpoint.
- Display per-account assignment, raw-video processing, quality-check counts,
  and scheduling/publication counts on setup and account cards.
- Require matching generation IDs and provider receipts for the entire batch
  before reporting it scheduled. Stale/error/unknown states never become ready.

## QA inventory

- Database: operator eligibility, ordinary customer preservation, unrelated
  admin denial, banned operator denial, browser RPC denial, replay-safe migration.
- Legacy safety: original workspace/destination exclusions and slots unchanged.
- Inventory: owner filtering, deduplication, no private recipe/content data leak.
- Progress: partial batch, running work, complete quality check, missing target,
  malformed response, wrong account, unknown state, held provider submission.
- UI: desktop and 375px mobile, dark/light, scenario switch, refresh, expand
  publishing details, empty/disabled/unavailable states and no horizontal overflow.
- Excluded from local signoff: real login isolation, live Publer discovery,
  real account-specific model output, production rendering, publication and
  continuous replenishment.

## Activation gates

1. Repair the saved Publer credential or supply an authorized signed-in browser.
   The client expects an Authorization header using `Bearer-API <API key>`;
   secrets must be entered through the secure Credentials interface, not chat.
2. Reconcile every exact provider account and workspace against existing owners,
   live slots, pending schedules and historical holds. Do not fabricate accounts
   to reach a requested count or infer ownership from handles alone.
3. If accounts share the legacy workspace, design and test coordinated
   legacy/managed scheduling or an explicitly approved workspace separation.
   This candidate deliberately does not bypass that boundary.
4. Confirm the authorized raw pool, usage rights, per-account brand blueprint,
   batch size, cadence and timezone. Register actual private media and grants.
5. Present the exact production change inventory before deploying this candidate.
6. Run one account's publishing-disabled real-video rehearsal. Check source/output
   playback, narrative and caption accuracy, technical quality, meaningful
   editorial differentiation and duplicate detection. Do not promise platform
   originality classification or detection avoidance.
7. Review the exact pilot account, videos, captions and future schedule before
   enabling external scheduling. Confirm provider receipts before any retry.
8. Expand account by account only after pilot evidence. Initial batches are
   implemented; continuous replenishment and ML performance feedback still
   need end-to-end validation and potentially further implementation.

## Candidate verification

- 131 backend tests passed, including local SQL migration replay and operator
  eligibility, managed inventory scoping/deduplication, existing generation,
  rendering, quality, handoff and legacy publisher regressions.
- 18 dashboard tests passed, including generation parsing, partial-batch
  handling and exact-generation receipt matching.
- Backend and frontend TypeScript checks passed. HTTP backend, generation,
  handoff, production dashboard and isolated preview builds succeeded.
- Existing assignment and handoff Playwright suites passed 23 grouped checks.
  Coverage includes fixture-only ownership, failed/revoked reads, retry
  idempotency, stale inventory, desktop/mobile and both themes.
- Added progress visual checks passed at 1440px desktop and 375px mobile:
  processing, full quality-checked batch without a false scheduled claim,
  theme switch, scenario switch and refresh. No browser exceptions or
  horizontal overflow observed.
- The main Accounts page integration is type-checked and its backend inventory
  is regression-tested; signed-in production UI acceptance remains pending.
- Production dashboard build still emits an existing large-bundle warning.
  Local FFmpeg fixture tests do not certify actual customer videos.

## Scope boundaries

This is a local candidate, not a production rollout. No migrations applied,
accounts assigned, live jobs created, flags enabled, or posts sent. Production
backend base is 6b1a858; frontend base is c300e26. Existing historical holds stay
untouched. The unrelated leader-refresh recovery is deferred for this request.
