# Dashboard reporting and UX repair

## Scope

Repair Overview, Analytics and Today using a shared read-only, ownership-scoped reporting endpoint. Do not change publishing workers, policies, provider credentials or retry behavior. Production deploy requires a separate scoped approval after tests and preview.

## Confirmed causes

- Devices sourced from three legacy device rows rather than current publishing slots.
- Analytics validates a fixed three-slot allowlist.
- Overview counts lifetime posts as today's posts and sums repeated cumulative snapshots.
- Today counts failed attempts as posts, exposes raw slot IDs, and shows unknown metrics as zero.
- Analytics filters snapshot time but plots publication dates outside the chosen window.
- Dates use fixed UTC offsets or browser-local time inconsistently.

## Acceptance tests

- All 18 authorized publishing accounts, including accounts with no activity, appear.
- Customer visibility remains limited to owned slots; forged account selectors fail.
- Pacific dates validate and handle DST; inclusive presets contain the stated number of days.
- Published totals deduplicate retries; failed/pending attempts remain visible as history.
- No cumulative snapshot double counting; slot-scoped ID/link joins; null is not zero.
- Observed view changes use available consecutive snapshots, explicitly report missing baselines and negative corrections.
- Publication-date cohort values are separate from observed period gains.
- Historical reports never use snapshots after the selected day's end.
- Bounded pagination fails visibly rather than returning silently truncated totals.
- Shared filters, all-videos action, searchable account lists, per-account daily details.
- Keyboard operation, mobile 375px, desktop, light/dark, empty/error/loading states.

## Release gates

Backend and frontend tests, build checks, mocked-route integration, visual QA and private simulated-data preview. No claim of authenticated production UI verification without a real signed-in check.

## Candidate validation results

- Backend: 185 tests passed, no failures. Server and publisher/analytics/alert builds passed.
- Frontend: 24 tests passed, TypeScript check passed, production and isolated-preview builds passed.
- SQL migration tested twice in PGlite, including reduced snapshot selection, service-role permissions, invalid ranges and exclusion of other accounts.
- Authenticated report-route tests cover administrator visibility, customer-owned accounts only, anonymous rejection and forged account selectors.
- Read-only production rehearsal returned 6,752 reduced snapshot rows rather than silently accepting the default 1,000-row API cap.
- Browser checks: 1440px desktop, 375px mobile, light/dark, 200% zoom, keyboard account selection, date validation, daily navigation, search, sort, pagination and CSV download.
- Empty activity retains assigned accounts. Service errors and revoked access hide cached totals. Loading is explicit.
- Mobile date fields were widened after visual inspection. Daily activity defaults to one day rather than inheriting a multi-day Overview range.
- Two browser errors appeared during earlier hot-reload work; repeated clean-page tests produced no page errors. This is not a production-session verification.
- Build retains the large-JavaScript-bundle warning. Full website-wide performance remediation is not included in this reporting repair.

## Production publishing read-back

October 11, approximately 12:20 PM Pacific, from scoped production records:

| Window | Accounts with a published receipt | Failed attempts retained in history | Pending attempts |
| --- | ---: | ---: | ---: |
| 08:00 | 18 / 18 | 0 | 0 |
| 10:00 | 18 / 18 | 16 | 0 |
| 12:00 | 17 / 18 | 17 | 1 |

The last 10 AM publication was recorded at 10:23:22 Pacific. All 15 library-launch destinations have noon published receipts; Instagram @tradingwithalexx_ is the remaining legacy destination awaiting noon confirmation. The other two legacy destinations have noon receipts. All 18 configured schedules remain unpaused.

A follow-up read found the remaining attempt explicitly held after HTTP 429 while querying its Publer job status. It must be reconciled against that exact provider job, not blindly resent.

These are provider-reported receipts, not independently opened social permalinks. Prior failed attempts include Publer job-status HTTP 429 rate limits. No retry, resubmission, pause change or publisher repair was performed during this dashboard work. The above is a timestamped observation, not a guarantee for subsequent windows.

## Exact proposed rollout

1. Apply `20261011193000_dashboard_report.sql` to Supabase project `gzvxqzguthrpvjtflxcx`. This adds a reporting index and a service-role-only read function. It changes schema, not ownership or publishing records. The index can briefly lock analytics writes; lock acquisition is bounded to five seconds.
2. Push the scoped backend commit to the existing production branch. Render auto-deployment may rebuild/restart the web service and services tracking that branch, although this package does not change publisher or analytics worker logic.
3. Deploy the scoped dashboard build to the existing Tradvio Reels Vercel project, not a new site. Verify the live build and report endpoint, then perform signed-in acceptance if an authorized session is available.
4. Verify account visibility, report dates and publication records again. Do not claim success from build status alone.

Customer account privacy is retained. Existing generation, ownership, schedules, publication settings and paid jobs are unchanged. No pending submission will be resent.

## Remaining limitations

- Production has not received these changes yet. The preview uses simulated data and does not post.
- The reporting repair does not cure Publer rate limits, create missing analytics, or establish successful ML promotion or an A/B winner.
- Previously saved snapshots limit how precisely historical view gains can be reconstructed. Reports label observed changes and missing baselines rather than inventing exact daily views.
- Other legacy API routes remain for compatibility. The three repaired pages use the new shared endpoint.
- Settings shows schedule state read-only rather than offering a legacy toggle that does not reliably control the actual publishing configuration.
- The new read-only schema objects can remain safely if the application is rolled back. Application rollback requires reverting/deploying the prior versions; no zero-downtime guarantee is made.
