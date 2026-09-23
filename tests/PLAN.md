# Publer reliability regression checklist

No production writes or external publish calls in this suite.

- Exact identity from actual array-shaped Publer publish response.
- TikTok published response with no permalink remains link-pending.
- Legacy wrapped posts accepted, bare IDs do not prove publication.
- Wrong account, multiple posts, malformed response, and contradictory errors held.
- Three media rejections quarantine a row without deleting its storage object.
- Infrastructure errors back off and are held after five attempts, not called corrupt.
- Ambiguous publish requests remain reserved and cannot automatically resend.
- Atomic pending-to-publishing claim prevents concurrent queue reuse.
- Publish job ID is persisted before polling; confirmed jobs can reconcile.
- Timeline displays success instead of an earlier failed retry.
- All existing time slots, timezone, daily targets, caption policy stay unchanged.
- Dashboard active accounts use existing scoped device data; no CreatorVault connect CTA.
- Desktop/mobile, empty/error state, refresh and navigation checks.

## Fully managed customer permissions

Requested September 23: customers are read-only, including their own accounts.
These changes are staged separately from the deployed three-account release.

- Deny customer POST, PUT, PATCH and DELETE under `/api`, including owned slots.
- Deny customer scheduling, publishing, pause/resume, caption decisions, upload
  signing, onboarding retries and CreatorVault OAuth initiation.
- Reject forged owner, role and administrator query parameters.
- Preserve owned reads and continue denying cross-customer reads.
- Preserve anonymous/profile-missing denial before any privileged handler runs.
- Keep HMAC webhook routing available to its own signature-verifying handler.
- Existing administrator permissions are unchanged in this first slice; sole
  operator binding is blocked until the designated login exists and is verified.
