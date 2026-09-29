# Publer reliability regression checklist

No production writes or external publish calls in this suite.

## Production blocker regression list, September 29

Tests precede implementation. Only synthetic local HTTP/JWKS and database fixtures
are used; do not run mutations against production or Publer.

- Operator JWT alone can update templates and invoke the controlled harvest adapter
  with APP_WRITE_SECRET configured; no browser secret required.
- Customer, viewing admin, anonymous, missing/revoked profile and secret-only
  identities cannot mutate either route, with or without the global boundary.
- Mixed headers never convert a customer/invalid token into operator authority.
  The existing secret-first resolver is fail-closed for these writes.
- Invalid legacy slot IDs stop before writes/provider calls.
- Privacy migration removes anon/authenticated caption view access, preserves
  service reads and existing materialized data, and is replay-safe.
- Signup still provisions a user profile; ordinary profile updates cannot change
  role/identity; own-profile and admin profile reads still work under RLS.
- The admin policy helper cannot probe another user's role and is not anonymous.
- Pin audited function search paths, preserve backend-only RPC execution and
  prevent browser execution of worker/trigger functions.
- Missing or incompatible prerequisites abort the migration, rather than quietly
  claiming that privacy is fixed. Local tests do not authorize production DDL.

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
- Bind human operator writes to the verified support@tradvio.com auth UUID,
  never an email, display name, submitted role or client-provided owner ID.
- Preserve non-operator administrator read visibility but reject all mutations.
- Reject legacy shared-secret mutations; it is not a human operator identity.
- Deny operator writes if the server-loaded profile is missing, mismatched or
  no longer an administrator. Preserve signature-verified webhook dispatch.
- Test the selected operator, another administrator, an ordinary customer,
  absent profile, mismatched profile, revoked role and forged operator email.

## Managed account assignment and automatic provisioning

Staged only; no provider writes, migration application or production activation.

- New dedicated customer workspace registration requires the selected operator
  and an existing verified, non-banned customer profile. No email/handle matching.
- Preserve all legacy slots, rows, queues, schedules and workspace assignments.
  Reject attempts to register the legacy workspace or reuse a legacy destination.
- Snapshot Publer inventory server-side; clients cannot submit provider facts.
  Reject malformed/duplicate/unsupported accounts, stale snapshots and mismatches.
- Assign by exact customer, registered workspace and observed provider account ID.
- Atomic assignment creates account, policy inputs, audit event and durable job.
  Replays return the same account; changed payloads or ownership conflict.
- Destination uniqueness survives retries with different idempotency keys.
- Ordinary users and non-operator admins cannot invoke setup mutations.
- Customer status queries are owner-scoped, cache-disabled and expose no raw
  provider inventory, consent references, other customers or private blueprints.
- RLS/revokes deny browser table/function access. Only server functions may write.
- Provisioning atomically consumes locked pending jobs, rechecks customer
  eligibility and creates one baseline blueprint and one initial batch.
- Repeated worker runs do not duplicate work; transaction failures roll back.
- Missing rights or the unimplemented renderer creates an honest blocked state.
  Nothing is sent to the legacy ready queue; publishing remains disabled.
- Feature defaults off. No live provider writes, generation spend or publishing.
- Local SQL tests exercise constraints/transactions and repeatability; they do
  not substitute for a multi-connection production-Postgres contention test.
