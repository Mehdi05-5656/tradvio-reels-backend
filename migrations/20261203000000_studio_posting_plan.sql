-- A person's posting plan (docs/publishing/PLAN.md, scheduling redesign, Nov 22 2026): how many posts a day, where
-- the audience is, which days, and the times that come out of it (in the audience's time zone). The composer's
-- "Best times" fills the next open slots from it.
ALTER TABLE public.studio_social_profiles ADD COLUMN IF NOT EXISTS posting_plan jsonb;
