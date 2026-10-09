# Tradvio Reels account status and activity history

Live database snapshot: October 8, 2026, approximately 8:27 PM PDT. The history feature described below is staged, not deployed to production.

## Is the system doing its full intended job?

Only partially. The three legacy accounts are publishing from existing queues and collecting analytics; 15 newly assigned accounts have not started a managed content pipeline. The full account-specific generation, performance-learning and controlled A/B-testing loop is not verified operational.

All 18 Publer destinations are mapped to support@tradvio.com. Ownership is not a fresh token-permission test or a guarantee of delivery.

## Account-by-account snapshot

Published counts are provider-reported records for October 8, not independently checked public permalinks. Queue counts mean pending legacy queue entries, not freshly generated, account-specific managed batches.

| Platform | Account label | Current pipeline state | Published today | Pending queue | Older unresolved holds |
|---|---|---|---:|---:|---:|
| Instagram | tradvio | Legacy schedule enabled | 7 of daily target 8 | 204 | 3 |
| Instagram | tradingwithalexx_ | Legacy schedule enabled | 7 of daily target 8 | 309 | 2 |
| TikTok | Tradvio | Legacy schedule enabled | 7 of daily target 8 | 709 | 3 |
| Instagram | at_trades.2 | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| Instagram | market.minds12 | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| Instagram | torrent_trades | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| Instagram | trades.james | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| Instagram | tradesbyyar | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| Instagram | tradingwitfender | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| Instagram | zaytradez2 | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | Chris | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | logan_createz | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | marketmode | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | Torrent | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | Trades.James | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | tradingwitfender | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | Yartrades | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |
| TikTok | zay | Assigned; awaiting content setup | No managed publishing started | None | Not applicable |

TikTok labels are provider display names, not verified usernames. The most recent attempt on each legacy account is recorded as published without an error, around 8:01–8:02 PM PDT; the eight older holds remain unresolved and were not resent.

## AI, performance data and experimentation

- Caption suggestions: the legacy caption worker code uses leader post scores, high-performing hashtags and recent history. Today's seven published records per legacy account match saved caption suggestions.
- Freshness: the latest saved nightly-LLM suggestions are September 8 for phone_a, September 10 for phone_b, and September 13 for tiktok_tradvio. Continued consumption of those suggestions is not evidence of fresh nightly learning.
- Analytics: the latest stored snapshots for all three slots are approximately 8:15 PM PDT on October 8. Snapshot counts are 90,484 / 39,816 / 53,995 respectively; these are repeated observations, not counts of unique posts.
- Research corpus: 227 scored leader posts currently exist. This does not establish freshness or demonstrate that their findings feed the new managed video planner.
- Managed generation: zero managed accounts, raw assets, generation jobs or handoffs currently exist. Generation and handoff database controls are disabled.
- Managed planner: code uses approved source facts, source frames, the account blueprint and a job-specific seed. Its reviewed input does not include a verified performance-feedback model or experiment outcome.
- A/B testing: no verified active experiment allocation, controlled comparison, winner selection or automatic rollout was established by this audit. Caption rotation and distinct variants alone do not constitute a controlled A/B test.
- Quality: generated variants still require a real-account rehearsal, complete playback review, factual/caption checks and evidence of meaningful differentiation. Unique outputs cannot guarantee a platform will not flag duplicate content.

## Staged account history feature

The existing Accounts cards now include a collapsible Activity history panel in the candidate code.

- Sources: recorded assignment timestamps, legacy publishing attempts/outcomes, older pending holds, saved caption-suggestion creation, latest analytics capture, managed setup audit, generation claims and Publer handoff events.
- Current state: shown separately from timestamped history. Generation completion times are not invented when the database stores only a current state.
- Filters: all stages, connection, generation, publishing and analytics.
- Refresh: every minute while open, plus manual refresh.
- Access: authorized admins may view all accounts; customers can read only their assigned records. Ownership is checked before any history query.
- Safety: no writes, retries, posting, provider API mutation, credential exposure or raw provider-error rendering.
- Failures: failed or revoked reads hide cached event rows instead of implying a healthy current state.
- Coverage: a bounded recent window, up to 50 records per source. A limit warning is shown when reached; this is not an unlimited export or a complete immutable transition audit. Older missing transitions are not reconstructed.
- History retention: existing database records are reused; no new migration is required.

## Tests and review

- Backend: 141 tests passed, no failures or skipped tests.
- Frontend: 20 tests passed.
- Both typechecks passed; backend, cron and production frontend builds passed.
- Browser: tested expand/collapse, stage filtering, manual refresh, ownership-only state, unavailable service, revoked access hiding previous rows, light/dark themes, desktop 1440px and mobile 375px.
- Visual review: no horizontal overflow, clipped controls or browser exceptions in the tested preview states.
- Limitations: preview data is simulated; real signed-in production verification remains pending deployment and an authorized user session. Existing frontend bundle-size warning remains.

## Proposed production scope

Deploy only the read-only history endpoint/access allowlist and Accounts history UI to the existing backend and Vercel dashboard. The master push will trigger existing Render backend and cron deployments; a restart is possible. No new database migration, account activation, feature-flag change, schedule change, historical retry or legacy-dashboard redirect is included.

The current production entry point remains the [Tradvio Reels dashboard](https://tradvio-reels.vercel.app). The older Render dashboard still requires a separately approved redirect or retirement.

## Recommended next sequence

1. Approve and deploy this visibility-only history feature, then inspect the real signed-in Accounts view.
2. Reconcile the eight historical holds with Publer before any retry decision.
3. Resolve shared-workspace submission coordination before enabling managed destinations.
4. Register authorized raw assets and account-specific blueprints; render and inspect one real batch with publishing disabled.
5. Approve a specific one-account publishing pilot and verify actual delivery before expanding.
6. Add a versioned experiment ledger, explicit hypothesis/variant allocation, attribution, minimum evidence and guardrails. Feed evaluated outcomes into subsequent account-specific plans rather than claiming learning from analytics collection alone.
