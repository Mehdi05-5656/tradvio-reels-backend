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
