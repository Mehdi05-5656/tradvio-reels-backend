-- Clone8 Studio: the Creator Program (owner's decision, Oct 31 2026). Creators post videos made with Clone8 on their own
-- TikTok and Instagram accounts, linked through Ayrshare, and are paid per view ($1 per 1,000 views, at most 1,000,000
-- views a video), monthly, on the 1st. Everything here is service-role only (RLS on, no policies): the backend reads and
-- writes it for the person, the admin panel for the owner.
--
-- 1. studio_creator_members: who joined, which terms they accepted, where to pay them.
-- 2. studio_creator_accounts: each TikTok / Instagram account enrolled in the program (one owner per account), with the
--    bio check ("powered by @clone8.io") and what the follower counts looked like (fraud review).
-- 3. studio_creator_videos: every video found on an enrolled account after it joined, its views, how it was shown to be
--    made with Clone8 (posted through Clone8, or linked to one of the creator's generations), and how many of its views
--    have been counted so far.
-- 4. studio_creator_earnings: one statement per creator per month (open while the month runs, then review, approved,
--    paid, withheld or carried when under the minimum payout), and studio_creator_earning_lines: every counted view
--    batch, per video, so each statement adds up.
-- 5. studio_creator_accrue: counts a video's new views once, atomically (the same views are never paid twice).
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_creator_members (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  terms_version text NOT NULL,
  terms_accepted_at timestamptz NOT NULL DEFAULT now(),
  terms_ip text,
  payout_method text CHECK (payout_method IN ('paypal', 'wise')),
  payout_email text,
  legal_name text,
  country text,
  removed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.studio_creator_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.studio_creator_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('tiktok', 'instagram')),
  username text NOT NULL,
  profile_url text,
  -- pending_bio: enrolled, bio line not found yet; active: counting; suspended: held by review; removed: left or unlinked
  status text NOT NULL DEFAULT 'pending_bio' CHECK (status IN ('pending_bio', 'active', 'suspended', 'removed')),
  bio_ok boolean NOT NULL DEFAULT false,
  bio_checked_at timestamptz,
  bio_excerpt text,
  followers_at_enroll integer,
  followers integer,
  followers_checked_at timestamptz,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.studio_creator_accounts ENABLE ROW LEVEL SECURITY;
-- an account is enrolled by one person at a time
CREATE UNIQUE INDEX IF NOT EXISTS studio_creator_accounts_one_owner ON public.studio_creator_accounts (platform, lower(username)) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS studio_creator_accounts_user ON public.studio_creator_accounts (user_id);

CREATE TABLE IF NOT EXISTS public.studio_creator_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.studio_creator_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  platform_post_id text NOT NULL,
  url text,
  caption text,
  thumb_url text,
  posted_at timestamptz,
  views bigint NOT NULL DEFAULT 0,
  likes bigint,
  comments bigint,
  shares bigint,
  views_at timestamptz,
  -- views already counted into statements (never above the per-video cap)
  views_counted bigint NOT NULL DEFAULT 0,
  -- how it is shown to be made with Clone8: posted through Clone8, or linked by the creator to one of their generations
  proof text NOT NULL DEFAULT 'none' CHECK (proof IN ('none', 'posted_via_clone8', 'linked')),
  job_id uuid REFERENCES public.studio_jobs(id) ON DELETE SET NULL,
  output_key text,
  -- pending: found, not shown to be Clone8 yet (counts nothing); eligible: counting; rejected: never pays
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'eligible', 'rejected')),
  reject_reason text,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_post_id)
);
ALTER TABLE public.studio_creator_videos ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS studio_creator_videos_user ON public.studio_creator_videos (user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS studio_creator_videos_account ON public.studio_creator_videos (account_id);

CREATE TABLE IF NOT EXISTS public.studio_creator_earnings (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  views bigint NOT NULL DEFAULT 0,
  -- money in micro-dollars (1e-6 USD): $1 per 1,000 views is 1,000 a view, so nothing is rounded until it is paid
  amount_micros bigint NOT NULL DEFAULT 0,
  carried_in_micros bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'review', 'approved', 'paid', 'withheld', 'carried')),
  paid_at timestamptz,
  payout_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);
ALTER TABLE public.studio_creator_earnings ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS studio_creator_earnings_month ON public.studio_creator_earnings (month, status);

CREATE TABLE IF NOT EXISTS public.studio_creator_earning_lines (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES public.studio_creator_videos(id) ON DELETE CASCADE,
  month date NOT NULL,
  views bigint NOT NULL,
  amount_micros bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.studio_creator_earning_lines ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS studio_creator_earning_lines_month ON public.studio_creator_earning_lines (user_id, month);

-- Count a video's views up to p_counted (already capped and windowed by the caller) into p_month's statement. Only the
-- part not counted before is added; a month already closed is never written (its views wait for the open month).
CREATE OR REPLACE FUNCTION public.studio_creator_accrue(p_video uuid, p_counted bigint, p_month date, p_micros_per_view integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $function$
DECLARE v public.studio_creator_videos; e public.studio_creator_earnings; delta bigint; micros bigint;
BEGIN
  IF p_counted IS NULL OR p_counted < 0 OR p_micros_per_view IS NULL OR p_micros_per_view < 0 THEN RAISE EXCEPTION 'invalid_accrual'; END IF;
  SELECT * INTO v FROM public.studio_creator_videos WHERE id = p_video FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'video_not_found'; END IF;
  IF v.status <> 'eligible' THEN RETURN jsonb_build_object('added', 0, 'reason', 'not_eligible'); END IF;
  delta := p_counted - v.views_counted;
  IF delta <= 0 THEN RETURN jsonb_build_object('added', 0); END IF;
  INSERT INTO public.studio_creator_earnings(user_id, month) VALUES (v.user_id, p_month) ON CONFLICT (user_id, month) DO NOTHING;
  SELECT * INTO e FROM public.studio_creator_earnings WHERE user_id = v.user_id AND month = p_month FOR UPDATE;
  IF e.status <> 'open' THEN RETURN jsonb_build_object('added', 0, 'reason', 'month_closed'); END IF;
  micros := delta * p_micros_per_view;
  UPDATE public.studio_creator_videos SET views_counted = p_counted, updated_at = now() WHERE id = p_video;
  INSERT INTO public.studio_creator_earning_lines(user_id, video_id, month, views, amount_micros) VALUES (v.user_id, p_video, p_month, delta, micros);
  UPDATE public.studio_creator_earnings SET views = views + delta, amount_micros = amount_micros + micros, updated_at = now() WHERE user_id = v.user_id AND month = p_month;
  RETURN jsonb_build_object('added', delta, 'micros', micros);
END $function$;

REVOKE ALL ON FUNCTION public.studio_creator_accrue(uuid, bigint, date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_creator_accrue(uuid, bigint, date, integer) TO service_role;

COMMIT;
