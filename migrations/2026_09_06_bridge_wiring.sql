-- Migration: Wire creatorvault_accounts to CreatorVault bridge flow
-- Applied against: gzvxqzguthrpvjtflxcx (Tradvio Reels Supabase)
-- Date: 2026-09-06
-- WO: Tradvio-side follow-up to CV WO-04 (bridge OAuth)
--
-- Adds nullable columns to attribute bridge-flow accounts to a partner-side
-- user id (external_user_id) and record their source bridge. Backward compatible:
-- existing rows keep NULL, existing code paths are unaffected.

ALTER TABLE public.creatorvault_accounts
  ADD COLUMN IF NOT EXISTS external_user_id text,
  ADD COLUMN IF NOT EXISTS bridge_source    text;

-- Index for the /api/creatorvault/accounts?external_user_id=... lookup
-- (OAuth return page polls this endpoint; Accounts page lists via this endpoint).
CREATE INDEX IF NOT EXISTS creatorvault_accounts_external_user_active_idx
  ON public.creatorvault_accounts (external_user_id, is_active)
  WHERE external_user_id IS NOT NULL;

COMMENT ON COLUMN public.creatorvault_accounts.external_user_id IS
  'Partner-side user id from CV pipeline_bridge_accounts.external_user_id. '
  'For the 3 seed accounts this is ''tradvio-brand''. For future multi-tenant '
  'user connects this will be the Tradvio user id.';

COMMENT ON COLUMN public.creatorvault_accounts.bridge_source IS
  'CV bridge name that this account was attached via (e.g. ''tradvio-machine''). '
  'NULL for accounts that predate the bridge flow.';
