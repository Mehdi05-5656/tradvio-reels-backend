-- Clone8 Studio: Community, the shared library of films made with the generative tools (src/studio-community.ts).
-- Additive only: one new table and two nullable columns. Nothing that exists is changed or read differently.
-- Undo: DROP TABLE studio_community_items; ALTER TABLE studio_customers DROP COLUMN community_share, DROP COLUMN community_noticed_at;

-- One row per film that has been decided: shown to everyone ('public'), kept to its maker ('private'), or held back
-- because its words could not be cleared ('held'). A film with no row has not been decided yet. The title and the
-- prompt here are the tidied ones people see; the film itself stays where it is, in the private output bucket, and
-- is shown through short-lived links.
CREATE TABLE IF NOT EXISTS studio_community_items (
  job_id uuid PRIMARY KEY REFERENCES studio_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('public', 'private', 'held')),
  kind text NOT NULL,                       -- 'story' | 'film' | 'kage'
  title text NOT NULL DEFAULT '',
  prompt text NOT NULL DEFAULT '',
  seconds integer,
  note text,                                -- why it was held, or who set it
  reports integer NOT NULL DEFAULT 0,
  removed_at timestamptz,                   -- taken down by Clone8; never shown again unless cleared
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_community_items_feed ON studio_community_items (published_at DESC) WHERE state = 'public' AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS studio_community_items_user ON studio_community_items (user_id, created_at DESC);

-- Who reported what, so one person counts once per film.
CREATE TABLE IF NOT EXISTS studio_community_reports (
  job_id uuid NOT NULL REFERENCES studio_community_items(job_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id)
);

-- Service role only, as every Studio table is: people reach these through the backend, never directly.
ALTER TABLE studio_community_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_community_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS studio_community_items_service_only ON studio_community_items;
CREATE POLICY studio_community_items_service_only ON studio_community_items FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS studio_community_reports_service_only ON studio_community_reports;
CREATE POLICY studio_community_reports_service_only ON studio_community_reports FOR ALL TO service_role USING (true) WITH CHECK (true);

-- The person's own choice (plans with the private perk only; null = not chosen, which means shared), and when they
-- were told that their films are shared. Only films made AFTER that moment are ever shown: nothing made before the
-- person knew is published.
ALTER TABLE studio_customers ADD COLUMN IF NOT EXISTS community_share text CHECK (community_share IN ('public', 'private'));
ALTER TABLE studio_customers ADD COLUMN IF NOT EXISTS community_noticed_at timestamptz;
