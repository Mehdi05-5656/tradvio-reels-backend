-- Per-client learning, phase 1: every learning row carries the client it belongs to, and the Tradvio-only
-- couplings (experiment id, hashtags, launch gate, leader) are replaced by per-client lookups. No posting
-- behaviour changes for Tradvio: its leaders, hashtags, experiment and gate are backfilled to its organization.
BEGIN;

-- 1. Research accounts belong to a client. The legacy phone_slot link stays optional.
ALTER TABLE public.leader_accounts ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.client_orgs(id) ON DELETE CASCADE;
ALTER TABLE public.leader_accounts ALTER COLUMN phone_slot DROP NOT NULL;
UPDATE public.leader_accounts l SET org_id = coalesce(
  (SELECT a.org_id FROM public.client_org_accounts a WHERE a.phone_slot = l.phone_slot LIMIT 1),
  (SELECT o.id FROM public.client_orgs o WHERE o.slug = 'tradvio' LIMIT 1))
WHERE l.org_id IS NULL;
ALTER TABLE public.leader_accounts ALTER COLUMN org_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS leader_accounts_org_provider_handle_key ON public.leader_accounts (org_id, provider, lower(handle));
CREATE INDEX IF NOT EXISTS leader_accounts_org_idx ON public.leader_accounts (org_id);

-- 2. Experiments per client. The registry row 'caption-question-v1' is copied to every existing client; a client
--    without a row runs under that id by default (client_experiment_id).
CREATE TABLE IF NOT EXISTS public.client_experiments (
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  id text NOT NULL,
  hypothesis text NOT NULL,
  primary_metric text NOT NULL,
  assignment_method text NOT NULL,
  minimum_per_arm integer NOT NULL DEFAULT 100,
  winner_arm text,
  decided_at timestamptz,
  notes text,
  registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
ALTER TABLE public.client_experiments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_experiments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.client_experiments TO service_role;
INSERT INTO public.client_experiments (org_id, id, hypothesis, primary_metric, assignment_method, minimum_per_arm)
SELECT o.id, e.id, e.hypothesis, e.primary_metric, e.assignment_method, e.minimum_per_arm
FROM public.client_orgs o CROSS JOIN public.library_experiments e WHERE e.id = 'caption-question-v1'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.client_experiment_id(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT id FROM public.client_experiments WHERE org_id = p_org AND decided_at IS NULL ORDER BY registered_at DESC LIMIT 1), 'caption-question-v1');
$$;
REVOKE ALL ON FUNCTION public.client_experiment_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_experiment_id(uuid) TO service_role;

-- 3. Learning settings per client: brand, niche, voice for the caption prompt; hashtags for library posts.
ALTER TABLE public.client_orgs ADD COLUMN IF NOT EXISTS learning jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE public.client_orgs SET learning = learning || '{"brand":"@tradvio","niche":"trading education","hashtags":["Trading","TradingEducation","RiskManagement"]}'::jsonb
WHERE slug = 'tradvio' AND NOT (learning ? 'hashtags');

-- 4. Suggestions, live-metric accounts and alert rules carry the client. A trigger fills the suggestion's client
--    from its queue row, so every writer (nightly worker, console) stays consistent.
ALTER TABLE public.queue_suggestions ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.client_orgs(id) ON DELETE SET NULL;
UPDATE public.queue_suggestions s SET org_id = a.org_id
FROM public.reels_manual_queue q JOIN public.client_org_accounts a ON a.phone_slot = q.phone_slot
WHERE q.id = s.queue_id AND s.org_id IS NULL;
CREATE INDEX IF NOT EXISTS queue_suggestions_org_idx ON public.queue_suggestions (org_id);
CREATE OR REPLACE FUNCTION public.queue_suggestion_org() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    SELECT a.org_id INTO NEW.org_id FROM public.reels_manual_queue q JOIN public.client_org_accounts a ON a.phone_slot = q.phone_slot WHERE q.id = NEW.queue_id LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS queue_suggestions_org ON public.queue_suggestions;
CREATE TRIGGER queue_suggestions_org BEFORE INSERT ON public.queue_suggestions FOR EACH ROW EXECUTE FUNCTION public.queue_suggestion_org();

ALTER TABLE public.live_metric_accounts ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.client_orgs(id) ON DELETE SET NULL;
UPDATE public.live_metric_accounts m SET org_id = a.org_id FROM public.client_org_accounts a WHERE a.phone_slot = m.phone_slot AND m.org_id IS NULL;
ALTER TABLE public.reels_alert_rules ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.client_orgs(id) ON DELETE CASCADE; -- null = house default

-- 5. Arms beyond A/B: a client may run up to 20 templates, one arm each (A..T).
ALTER TABLE public.reels_manual_queue DROP CONSTRAINT IF EXISTS reels_manual_queue_library_experiment_arm_check;
ALTER TABLE public.reels_manual_queue ADD CONSTRAINT reels_manual_queue_library_experiment_arm_check CHECK (library_experiment_arm ~ '^[A-T]$');

-- The caption for a rendered variant: the client's own templates under the client's own experiment. The hash keeps
-- Tradvio's existing two-arm assignment unchanged (first hex digit modulo the template count). A client with no
-- templates gets no caption, and library_feed_publishers skips that account until templates exist.
CREATE OR REPLACE FUNCTION public.library_caption_for(p_account text, p_source_sha256 text, OUT caption text, OUT arm text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_org uuid; templates jsonb; n integer; idx integer; experiment text;
BEGIN
  SELECT o.id, o.caption_templates INTO v_org, templates FROM public.client_account_setup s JOIN public.client_orgs o ON o.id = s.org_id WHERE s.publer_account_id = p_account;
  IF v_org IS NULL OR templates IS NULL OR jsonb_array_length(templates) = 0 THEN caption := NULL; arm := NULL; RETURN; END IF;
  n := least(jsonb_array_length(templates), 20);
  experiment := public.client_experiment_id(v_org);
  idx := strpos('0123456789abcdef', substr(md5(p_source_sha256 || ':' || p_account || ':' || experiment), 1, 1)) % n;
  arm := chr(65 + idx);
  caption := templates ->> idx;
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
    -- No caption templates for this client yet: nothing is queued for the account until the operator adds some.
    IF NOT EXISTS(SELECT 1 FROM public.client_account_setup s JOIN public.client_orgs o ON o.id=s.org_id
      WHERE s.publer_account_id=p.account_id AND jsonb_array_length(coalesce(o.caption_templates,'[]'::jsonb))>0) THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.publer_slot_config WHERE publer_account_id=p.account_id AND phone_slot NOT LIKE 'library_%')
      THEN RAISE EXCEPTION 'legacy_destination_conflict';END IF;
    INSERT INTO public.publer_slot_config(phone_slot,publer_account_id,provider,handle,daily_target,paused,owner_user_id,publish_after,publication_settings)
      VALUES('library_'||p.account_id,p.account_id,p.platform,p.label,p.daily_target,false,p.owner_user_id,p.not_before,p.settings)
      ON CONFLICT(phone_slot) DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM public.publer_slot_config WHERE phone_slot='library_'||p.account_id
      AND publer_account_id=p.account_id AND owner_user_id=p.owner_user_id AND provider=p.platform
      AND publication_settings=p.settings AND publish_after=p.not_before)
      THEN RAISE EXCEPTION 'publisher_configuration_conflict';END IF;
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
      AND c.caption IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.reels_manual_queue q WHERE q.library_variant_id=v.id)
    ORDER BY md5(v.source_sha256||':'||v.account_id||':queue-order-v1')
    LIMIT 200
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n=ROW_COUNT;total_n:=total_n+n;
    UPDATE public.client_account_setup SET status='posting',updated_at=now() WHERE publer_account_id=p.account_id AND status IN ('planned','rendering','scheduling');
  END LOOP;
  RETURN total_n;
END $function$;
REVOKE ALL ON FUNCTION public.library_feed_publishers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_feed_publishers() TO service_role;

-- The publication receipt names the client's experiment instead of the fixed id, and accepts any arm letter.
CREATE OR REPLACE FUNCTION public.library_publication_receipt(p_queue uuid,p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('caption',q.library_caption,'settings',p.settings,
    'storage_bucket',q.storage_bucket,'storage_path',q.storage_path,'variant_id',v.id,
    'experiment_id',public.client_experiment_id(s2.org_id),'experiment_arm',q.library_experiment_arm,'org_id',s2.org_id)
  FROM public.reels_manual_queue q
    JOIN public.library_variants v ON v.id=q.library_variant_id
    JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
    JOIN public.library_publishing_policy p ON p.account_id=v.account_id AND p.owner_user_id=v.owner_user_id
    JOIN public.publer_account_ownership a ON a.publer_account_id=p.account_id AND a.owner_user_id=p.owner_user_id
      AND a.workspace_id=v.workspace_id
    JOIN public.publer_slot_config c ON c.phone_slot=q.phone_slot AND c.publer_account_id=a.publer_account_id
      AND c.owner_user_id=a.owner_user_id AND c.provider=a.platform
    LEFT JOIN public.client_account_setup s2 ON s2.publer_account_id=p_account
  WHERE q.id=p_queue AND a.publer_account_id=p_account AND q.phone_slot='library_'||p_account
    AND p.enabled AND p.expires_at>now() AND now()>=p.not_before AND c.publish_after=p.not_before
    AND public.library_launch_gate_passed(p.gate_account,p.owner_user_id)
    AND NOT c.paused AND c.publication_settings=p.settings AND q.storage_bucket='managed-variants'
    AND q.storage_path=v.result->>'object_key' AND q.content_video_hash=v.result->>'sha256'
    AND q.status IN ('pending','publer_publishing') AND v.state='rendered_private' AND v.result->'full_decode_passed'='true'
    AND length(q.library_caption) BETWEEN 20 AND 800 AND q.library_experiment_arm ~ '^[A-T]$';
$$;
REVOKE ALL ON FUNCTION public.library_publication_receipt(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_publication_receipt(uuid,text) TO service_role;

-- 6. The launch gate a new account inherits comes from its own client's accounts, never another client's.
CREATE OR REPLACE FUNCTION public.client_gate_for(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.gate_account FROM public.library_publishing_policy p
  JOIN public.client_account_setup s ON s.publer_account_id = p.account_id
  WHERE s.org_id = p_org AND p.gate_account IS NOT NULL
  ORDER BY p.created_at, p.account_id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.client_gate_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_gate_for(uuid) TO service_role;

-- 7. Library hashtags for a slot: the client's learning.hashtags.
CREATE OR REPLACE FUNCTION public.client_learning_for_slot(p_slot text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('org_id', o.id, 'name', o.name, 'learning', o.learning)
  FROM public.client_org_accounts a JOIN public.client_orgs o ON o.id = a.org_id WHERE a.phone_slot = p_slot LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.client_learning_for_slot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_learning_for_slot(text) TO service_role;

COMMIT;
