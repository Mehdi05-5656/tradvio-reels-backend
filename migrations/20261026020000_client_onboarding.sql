-- Client onboarding: per-client content, per-client accounts, content intake.
--
-- 1. library_sources belong to a client (org_id). Every existing source is Tradvio's. library_plan() only
--    plans a client's own sources for a client's own accounts, so a new client never inherits another's library.
-- 2. client_account_setup: which Publer account belongs to which client, with the method chosen for it
--    (blueprint_repost is the only one that runs today), the daily cadence and the batch size that starts posting.
-- 3. client_intake_batches / client_intake_items: what the operator handed in (links, sheets, files, videos) and
--    what became of each item while it was pooled into the vault.
-- 4. Caption templates per client; library_feed_publishers() uses the client's templates instead of fixed text.
-- Service role only. Idempotent.
BEGIN;

ALTER TABLE public.library_sources ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.client_orgs(id) ON DELETE SET NULL;
UPDATE public.library_sources SET org_id = (SELECT id FROM public.client_orgs WHERE slug = 'tradvio' LIMIT 1) WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS library_sources_org ON public.library_sources(org_id) WHERE enabled;

ALTER TABLE public.client_orgs ADD COLUMN IF NOT EXISTS caption_templates jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(caption_templates) = 'array' AND jsonb_array_length(caption_templates) <= 20);
UPDATE public.client_orgs SET caption_templates = '[
  "Trading takes discipline. Focus on the process, not one outcome. Trading involves risk. #Trading #TradingEducation #RiskManagement",
  "What would you review after this trading session? Focus on the process, not one outcome. Trading involves risk. #Trading #TradingEducation #RiskManagement"]'::jsonb
  WHERE slug = 'tradvio' AND caption_templates = '[]'::jsonb;

CREATE TABLE IF NOT EXISTS public.client_account_setup(
  publer_account_id text PRIMARY KEY CHECK (publer_account_id ~ '^[a-f0-9]{24}$'),
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram', 'tiktok')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 128),
  method text NOT NULL DEFAULT 'blueprint_repost' CHECK (method IN ('blueprint_repost', 'blueprint', 'recast')),
  daily_target integer NOT NULL DEFAULT 8 CHECK (daily_target BETWEEN 1 AND 8),
  batch_size integer NOT NULL DEFAULT 25 CHECK (batch_size BETWEEN 3 AND 30),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'rendering', 'scheduling', 'posting', 'paused', 'failed')),
  start_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_account_setup_org ON public.client_account_setup(org_id);
-- Every account that already has an owner today is Tradvio's.
INSERT INTO public.client_account_setup(org_id, publer_account_id, platform, label, method, daily_target, batch_size, status, start_at)
SELECT o.id, own.publer_account_id, own.platform, own.label, 'blueprint_repost', coalesce(p.daily_target, 8), coalesce(p.minimum_ready, 8),
       CASE WHEN p.enabled THEN 'posting' ELSE 'planned' END, p.not_before
FROM public.publer_account_ownership own
JOIN public.client_orgs o ON o.slug = 'tradvio'
LEFT JOIN public.library_publishing_policy p ON p.account_id = own.publer_account_id
WHERE own.platform IN ('instagram', 'tiktok')
ON CONFLICT (publer_account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.client_intake_batches(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR length(note) <= 500),
  top_n integer NOT NULL DEFAULT 30 CHECK (top_n BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS client_intake_batches_org ON public.client_intake_batches(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.client_intake_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.client_intake_batches(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('profile_instagram', 'profile_tiktok', 'post_instagram', 'post_tiktok', 'video_file', 'sheet', 'csv', 'pdf', 'text', 'link')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 2048),
  label text CHECK (label IS NULL OR length(label) <= 200),
  parent_id uuid REFERENCES public.client_intake_items(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'working', 'saved', 'skipped', 'failed')),
  error text CHECK (error IS NULL OR length(error) <= 300),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_intake_items_org_status ON public.client_intake_items(org_id, status);
CREATE INDEX IF NOT EXISTS client_intake_items_batch ON public.client_intake_items(batch_id);
CREATE INDEX IF NOT EXISTS client_intake_items_queued ON public.client_intake_items(created_at) WHERE status IN ('queued', 'working');

INSERT INTO storage.buckets (id, name, public, file_size_limit)
  VALUES ('client-intake', 'client-intake', false, 268435456) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.client_account_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_intake_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_intake_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_account_setup, public.client_intake_batches, public.client_intake_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_account_setup, public.client_intake_batches, public.client_intake_items TO service_role;

-- Plan only the client's own sources for the client's own account.
CREATE OR REPLACE FUNCTION public.library_plan(p_actor uuid, p_account text)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE a public.publer_account_ownership; n integer; v_org uuid;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('private-library',0));
  SELECT * INTO a FROM public.publer_account_ownership WHERE publer_account_id=p_account FOR SHARE;
  IF NOT FOUND OR a.owner_user_id IS DISTINCT FROM p_actor OR p_account !~ '^[a-f0-9]{24}$'
    THEN RAISE EXCEPTION 'account_not_owned';END IF;
  SELECT org_id INTO v_org FROM public.client_account_setup WHERE publer_account_id=p_account;
  IF v_org IS NULL THEN RAISE EXCEPTION 'account_not_assigned_to_client';END IF;
  WITH added AS(
    INSERT INTO public.library_variants(account_id,owner_user_id,workspace_id,source_sha256,recipe_version)
    SELECT p_account,a.owner_user_id,a.workspace_id,sha256,'legacy-light-account-v2'
    FROM public.library_sources WHERE enabled AND org_id=v_org
    ON CONFLICT(account_id,source_sha256,recipe_version) DO NOTHING RETURNING id,account_id
  ) INSERT INTO public.library_events(variant_id,account_id,event) SELECT id,account_id,'queued' FROM added;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $function$;

-- Caption for a rendered variant: the client's templates, A/B by the same stable hash as before; Tradvio's old text when a client has none.
CREATE OR REPLACE FUNCTION public.library_caption_for(p_account text, p_source_sha256 text, OUT caption text, OUT arm text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE templates jsonb; n integer; idx integer;
BEGIN
  SELECT o.caption_templates INTO templates FROM public.client_account_setup s JOIN public.client_orgs o ON o.id=s.org_id WHERE s.publer_account_id=p_account;
  IF templates IS NULL OR jsonb_array_length(templates)=0 THEN
    templates := '["Trading takes discipline. Focus on the process, not one outcome. Trading involves risk. #Trading #TradingEducation #RiskManagement",
                   "What would you review after this trading session? Focus on the process, not one outcome. Trading involves risk. #Trading #TradingEducation #RiskManagement"]'::jsonb;
  END IF;
  n := jsonb_array_length(templates);
  idx := CASE WHEN strpos('0123456789abcdef',substr(md5(p_source_sha256||':'||p_account||':caption-question-v1'),1,1))%2=0 THEN 0 ELSE 1 END;
  arm := CASE WHEN idx=0 THEN 'A' ELSE 'B' END;
  caption := templates->>(idx % n);
END $function$;
REVOKE ALL ON FUNCTION public.library_caption_for(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_caption_for(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.library_feed_publishers()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE p record;n integer;total_n integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('library-publishing',0));
  FOR p IN SELECT policy.*,a.workspace_id,a.platform,a.label FROM public.library_publishing_policy policy
    JOIN public.publer_account_ownership a ON a.publer_account_id=policy.account_id AND a.owner_user_id=policy.owner_user_id
    WHERE policy.enabled AND policy.expires_at>now()
      AND public.library_launch_gate_passed(policy.gate_account,policy.owner_user_id)
      AND EXISTS(SELECT 1 FROM public.publer_config WHERE workspace_id=a.workspace_id)
      AND (SELECT count(*) FROM public.library_variants v JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
        WHERE v.account_id=policy.account_id AND v.owner_user_id=policy.owner_user_id AND v.workspace_id=a.workspace_id
          AND v.state='rendered_private' AND v.result->'full_decode_passed'='true')>=policy.minimum_ready
    ORDER BY policy.account_id LOOP
    IF EXISTS(SELECT 1 FROM public.publer_slot_config WHERE publer_account_id=p.account_id AND phone_slot NOT LIKE 'library_%')
      THEN RAISE EXCEPTION 'legacy_destination_conflict';END IF;
    INSERT INTO public.publer_slot_config(phone_slot,publer_account_id,provider,handle,daily_target,paused,owner_user_id,publish_after,publication_settings)
      VALUES('library_'||p.account_id,p.account_id,p.platform,p.label,p.daily_target,false,p.owner_user_id,p.not_before,p.settings)
      ON CONFLICT(phone_slot) DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM public.publer_slot_config WHERE phone_slot='library_'||p.account_id
      AND publer_account_id=p.account_id AND owner_user_id=p.owner_user_id AND provider=p.platform
      AND publication_settings=p.settings AND publish_after=p.not_before)
      THEN RAISE EXCEPTION 'publisher_configuration_conflict';END IF;
    -- The client sees its accounts through the organization as soon as the slot exists.
    INSERT INTO public.client_org_accounts(org_id,phone_slot)
      SELECT s.org_id,'library_'||p.account_id FROM public.client_account_setup s WHERE s.publer_account_id=p.account_id
      ON CONFLICT DO NOTHING;
    INSERT INTO public.reels_manual_queue(phone_slot,source_handle,source_video_id,filename,storage_path,
      duration_sec,size_bytes,status,source_aweme_id,content_video_hash,storage_bucket,library_variant_id,library_caption,library_experiment_arm)
    SELECT 'library_'||p.account_id,s.source->>'source_handle',s.source->>'source_video_id',
      p.account_id||'__'||coalesce(s.source->>'source_video_id',left(v.source_sha256,16))||'.mp4',v.result->>'object_key',
      (v.result->>'duration')::numeric,(v.result->>'bytes')::bigint,'pending',s.source->>'source_video_id',
      v.result->>'sha256','managed-variants',v.id,c.caption,c.arm
    FROM public.library_variants v JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
    CROSS JOIN LATERAL public.library_caption_for(p.account_id,v.source_sha256) c
    WHERE v.account_id=p.account_id AND v.owner_user_id=p.owner_user_id AND v.workspace_id=p.workspace_id
      AND v.state='rendered_private' AND v.result->'full_decode_passed'='true'
      AND v.result->>'object_key' LIKE 'library/'||p.owner_user_id||'/'||p.account_id||'/'||v.id||'/%'
      AND NOT EXISTS(SELECT 1 FROM public.reels_manual_queue q WHERE q.library_variant_id=v.id)
    ORDER BY md5(v.source_sha256||':'||v.account_id||':queue-order-v1')
    LIMIT 200
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n=ROW_COUNT;total_n:=total_n+n;
    UPDATE public.client_account_setup SET status='posting',updated_at=now() WHERE publer_account_id=p.account_id AND status IN ('planned','rendering','scheduling');
  END LOOP;
  RETURN total_n;
END $function$;

COMMIT;
