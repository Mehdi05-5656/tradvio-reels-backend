# Tradvio Reels 18-account ownership rollout

## Confirmed scope

On October 8 the user approved all 18 Publer accounts in workspace
`6a9d66c38c98536b8f9babf2` (`tradvio`) belonging to the existing Tradvio profile
support@tradvio.com, UUID `71c2308a-9e23-4458-b4f0-df7ae53c841e`.
The corrected custom credential authenticated successfully. All 18 provider
records were listed and marked unlocked; this is not a live publishing test.
The Publer login identity is separate from the Tradvio profile owner and will
not be renamed or transferred.

## Exact destination inventory

TikTok labels below are display names, not verified usernames. The assignment
uses exact immutable provider IDs.

| Platform | Username or display name | Provider account ID | Existing publisher |
|---|---|---|---|
| Instagram | tradingwithalexx_ | 6a9d6b0252d53c283449df25 | Yes |
| Instagram | at_trades.2 | 6ac831b2e73f366e1cbd1699 | No |
| Instagram | market.minds12 | 6ac6c29aa44c140358b13859 | No |
| Instagram | torrent_trades | 6ac5b10b3b21bda2e54a929a | No |
| Instagram | trades.james | 6ac81b466a16052684d5576c | No |
| Instagram | tradesbyyar | 6ac5ae7bcc11efecdd159091 | No |
| Instagram | tradingwitfender | 6ac7fa18bf25b54bdef7ec99 | No |
| Instagram | tradvio | 6a9d67a5a38150c12dedb605 | Yes |
| Instagram | zaytradez2 | 6ac6bbe581c608818b1c3f26 | No |
| TikTok | Chris | 6ac6bf7c88440f1ee1267b04 | No |
| TikTok | logan_createz | 6ac80bb03b23063aced480d6 | No |
| TikTok | marketmode | 6ac6c23f81c608818b1c4d74 | No |
| TikTok | Torrent | 6ac5b03248566d27e46d9dee | No |
| TikTok | Trades.James | 6ac818ffbe7e22fbcb607fae | No |
| TikTok | tradingwitfender | 6ac7f98cbf25b54bdef7eb0b | No |
| TikTok | Tradvio | 6a9d6b6dba4a5e4ef8280824 | Yes |
| TikTok | Yartrades | 6ac5ae5e3b21bda2e54a8eec | No |
| TikTok | zay | 6ac6bbba3b23063aced1e873 | No |

## Production package awaiting deployment approval

- Apply `20261008010000_managed_operator_owner.sql`: allow the sole verified
  operator to own a dedicated managed account, without allowing other admins.
- Apply `20261008020000_publer_ownership.sql`: add a server-only ownership
  table, operator-only atomic assignment RPC, and conflict checks on existing
  managed/legacy destination writes. Browser roles cannot read or write it.
- Refresh and compare the exact 18-account inventory immediately before the
  ownership transaction. Abort on changed IDs, workspace or conflicting owners.
- Record these 18 mappings to support@tradvio.com. Do not insert legacy slots,
  create generation jobs, register raw assets or activate a publisher.
- Push the reviewed backend candidate to master, triggering the existing
  Render backend, publisher and analytics deployments. Deploy the reviewed
  frontend to the existing Vercel dashboard.
- Verify ownership counts, exact provider IDs, API owner scoping, deployed
  revisions and preservation of existing legacy settings after deployment.

## What stays unchanged

The three existing slots remain unpaused and retain their current daily target
of eight, scheduling configuration, provider IDs and owner. All managed flags
and generation/handoff controls stay disabled. Historical held submissions
are neither reset nor resent. No production API keys are replaced or exposed.

The other 15 accounts show ownership with "Assigned · awaiting content setup."
This is deliberately distinct from a completed connection-health check,
generated batch, scheduled batch or public post.

## Safety and limitations

Additive migrations do not delete data. Ownership assignment refuses other
actors, mismatched owners, stale/invalid inventories and conflicting mappings.
Replaying the same approved assignment updates observed labels without
duplicating ownership records or starting work.

The existing public publisher will restart on its code deployment; this is not
a zero-downtime promise. Migration conflicts or deployment verification failures
stop the rollout. Rollback should restore the prior code revisions while
retaining the additive ownership records; do not drop records, restore an old
database snapshot or resend posts automatically.

No database restore has been tested for this package. Signed-in production
operator/customer browser checks remain pending an authorized browser session.
The dashboard currently has an existing large-bundle build warning.

## Next phase, not activated by this package

All 18 destinations share the legacy workspace, which managed handoff currently
excludes. Before enabling a new publisher, implement and test coordinated
workspace-level upload/submission safety or obtain approval for a workspace
separation. Do not simply remove the exclusion.

Confirm the approved raw-content pool and rights, per-account blueprint,
cadence and batch size. Run one real account-specific video rehearsal with
publishing disabled, inspect complete playback and captions, and then review
the exact future pilot schedule. Continuous replenishment and ML feedback
remain separate end-to-end acceptance work.
