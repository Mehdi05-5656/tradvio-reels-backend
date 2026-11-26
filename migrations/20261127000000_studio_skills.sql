-- Clone8 Studio: Skills, reusable recipes people make and share, run from Claude by name (src/studio-skills.ts;
-- docs/higgsfield-parity/PLAN.md, phase 2). The skills by Clone8 live in code; these tables hold the ones people make.
-- Additive only: three new tables. Nothing that exists is changed or read differently.
-- Undo: DROP TABLE studio_skill_reports; DROP TABLE studio_skill_saves; DROP TABLE studio_skills;

-- One row per skill a person made. Public by default; private only on the Creator and Studio plans (the Community
-- rule). A public skill's words are checked before anyone else sees them: one that is not cleared is 'held' (its
-- maker still sees it, with the reason). 'removed' is taken down, by its maker or by Clone8.
CREATE TABLE IF NOT EXISTS studio_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 48),
  user_id uuid NOT NULL,
  author_name text NOT NULL DEFAULT '',     -- the name its maker chose to be shown as (never an email)
  title text NOT NULL,
  line text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'other',
  instructions text NOT NULL,               -- what Claude follows, with the Clone8 tools
  example text NOT NULL DEFAULT '',         -- a request that runs it
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  state text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'held', 'removed')),
  note text,                                -- why it was held or removed
  cover_kind text CHECK (cover_kind IN ('video', 'image')),
  cover_key text,                           -- in studio-outputs: a result its maker made on Clone8
  cover_poster_key text,
  runs integer NOT NULL DEFAULT 0,
  saves integer NOT NULL DEFAULT 0,
  reports integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_skills_feed ON studio_skills (runs DESC, created_at DESC) WHERE visibility = 'public' AND state = 'live';
CREATE INDEX IF NOT EXISTS studio_skills_user ON studio_skills (user_id, created_at DESC);

-- Skills a person saved to My skills (by slug, so a skill by Clone8 can be saved too).
CREATE TABLE IF NOT EXISTS studio_skill_saves (
  user_id uuid NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slug)
);

-- Who reported what, so one person counts once per skill.
CREATE TABLE IF NOT EXISTS studio_skill_reports (
  skill_id uuid NOT NULL REFERENCES studio_skills(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id)
);

-- Service role only, as every Studio table is: people reach these through the backend, never directly.
ALTER TABLE studio_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_skill_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_skill_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS studio_skills_service_only ON studio_skills;
CREATE POLICY studio_skills_service_only ON studio_skills FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS studio_skill_saves_service_only ON studio_skill_saves;
CREATE POLICY studio_skill_saves_service_only ON studio_skill_saves FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS studio_skill_reports_service_only ON studio_skill_reports;
CREATE POLICY studio_skill_reports_service_only ON studio_skill_reports FOR ALL TO service_role USING (true) WITH CHECK (true);
