-- Sprint 3: Multi-tenant onboarding ingestion tracking
-- Adds ingestion progress fields to creatorvault_accounts + a jobs queue table.

BEGIN;

-- 3.1a: Progress fields on the destination account row
ALTER TABLE creatorvault_accounts
  ADD COLUMN IF NOT EXISTS ingestion_status text
    CHECK (ingestion_status IN ('pending','processing','complete','failed','skipped')),
  ADD COLUMN IF NOT EXISTS ingestion_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS ingestion_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS posts_processed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS posts_total     integer,
  ADD COLUMN IF NOT EXISTS ingestion_error text,
  ADD COLUMN IF NOT EXISTS ingestion_eta_seconds integer;

-- Existing rows connected before this migration have never been ingested.
-- Mark them 'skipped' so we don't accidentally re-run for pre-existing
-- accounts on first worker tick. Admin can manually retry via /api/onboard/retry.
UPDATE creatorvault_accounts
   SET ingestion_status = 'skipped'
 WHERE ingestion_status IS NULL;

-- 3.1b: Job queue. One row per requested ingestion; worker picks pending.
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_account_id  uuid NOT NULL REFERENCES creatorvault_accounts(cv_account_id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','claimed','processing','complete','failed')),
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  since_cursor   timestamptz,           -- optional: only videos since this timestamp
  page_limit     integer NOT NULL DEFAULT 50,
  claimed_by     text,                  -- worker id / hostname
  claimed_at     timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,
  posts_mirrored integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_status_created_idx
  ON ingestion_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS ingestion_jobs_cv_account_idx
  ON ingestion_jobs (cv_account_id);

-- Only one non-terminal job per account to prevent duplicate work.
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_one_active_per_account
  ON ingestion_jobs (cv_account_id)
  WHERE status IN ('pending','claimed','processing');

-- 3.1c: Auto-touch updated_at
CREATE OR REPLACE FUNCTION touch_ingestion_jobs_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ingestion_jobs_touch_updated_at ON ingestion_jobs;
CREATE TRIGGER ingestion_jobs_touch_updated_at
  BEFORE UPDATE ON ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_ingestion_jobs_updated_at();

-- 3.1d: Atomic claim helper. Returns one pending job as claimed by <worker_id>.
-- SKIP LOCKED lets multiple workers coexist without racing.
CREATE OR REPLACE FUNCTION claim_next_ingestion_job(worker_id text)
RETURNS TABLE (
  job_id        uuid,
  cv_account_id uuid,
  since_cursor  timestamptz,
  page_limit    integer,
  attempts      integer
) AS $$
BEGIN
  RETURN QUERY
  UPDATE ingestion_jobs j
     SET status = 'claimed',
         claimed_by = worker_id,
         claimed_at = NOW(),
         attempts = j.attempts + 1
   WHERE j.id = (
     SELECT id FROM ingestion_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING j.id, j.cv_account_id, j.since_cursor, j.page_limit, j.attempts;
END $$ LANGUAGE plpgsql;

-- 3.1e: RLS — jobs are admin/service-role only (webhooks + worker).
-- Users see progress via the /api/onboard/status endpoint which reads
-- creatorvault_accounts.ingestion_status, not the raw jobs table.
ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ingestion_jobs_service_only ON ingestion_jobs;
CREATE POLICY ingestion_jobs_service_only ON ingestion_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
