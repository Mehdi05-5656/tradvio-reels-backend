-- Ownership is independent of generation consent and scheduling activation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.publer_account_ownership (
  publer_account_id text PRIMARY KEY CHECK(publer_account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  workspace_id text NOT NULL CHECK(workspace_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK(platform IN ('instagram','tiktok')),
  label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 128),
  label_is_username boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publer_ownership_owner ON public.publer_account_ownership(owner_user_id);
ALTER TABLE public.publer_account_ownership ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.publer_account_ownership FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.publer_account_ownership TO service_role;

CREATE OR REPLACE FUNCTION public.publer_assign_operator_ownership(
  p_actor uuid,p_owner uuid,p_workspace text,p_accounts jsonb,p_observed_at timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; current_row public.publer_account_ownership; n integer;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  IF p_owner IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'operator_owner_required'; END IF;
  IF p_workspace IS NULL OR NOT EXISTS(SELECT 1 FROM public.publer_config WHERE workspace_id=p_workspace)
    THEN RAISE EXCEPTION 'workspace_conflict'; END IF;
  IF p_observed_at IS NULL OR p_observed_at<now()-interval '5 minutes' OR p_observed_at>now()
    THEN RAISE EXCEPTION 'inventory_stale'; END IF;
  IF p_accounts IS NULL OR jsonb_typeof(p_accounts)<>'array'
    THEN RAISE EXCEPTION 'invalid_inventory'; END IF;
  n:=jsonb_array_length(p_accounts);
  IF n NOT BETWEEN 1 AND 100 OR
    (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_accounts))<>n
    THEN RAISE EXCEPTION 'invalid_inventory'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('publer-ownership',0));
  FOR item IN SELECT value FROM jsonb_array_elements(p_accounts) ORDER BY value->>'id' LOOP
    IF jsonb_typeof(item)<>'object' OR item->>'id' IS NULL
      OR item->>'id' !~ '^[A-Za-z0-9_-]{1,128}$'
      OR COALESCE(item->>'platform','') NOT IN ('instagram','tiktok')
      OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string'
      OR length(trim(item->>'label')) NOT BETWEEN 1 AND 128
      OR jsonb_typeof(item->'label_is_username') IS DISTINCT FROM 'boolean'
      OR (item-ARRAY['id','platform','label','label_is_username'])<>'{}'::jsonb
      THEN RAISE EXCEPTION 'invalid_inventory'; END IF;
    IF EXISTS(SELECT 1 FROM public.publer_slot_config WHERE publer_account_id=item->>'id'
      AND owner_user_id IS DISTINCT FROM p_owner)
      OR EXISTS(SELECT 1 FROM public.managed_accounts WHERE publer_account_id=item->>'id'
      AND (customer_user_id<>p_owner OR workspace_id<>p_workspace))
      THEN RAISE EXCEPTION 'ownership_conflict'; END IF;
    SELECT * INTO current_row FROM public.publer_account_ownership WHERE publer_account_id=item->>'id' FOR UPDATE;
    IF FOUND AND (current_row.owner_user_id<>p_owner OR current_row.workspace_id<>p_workspace
      OR current_row.platform<>item->>'platform') THEN RAISE EXCEPTION 'ownership_conflict'; END IF;
    INSERT INTO public.publer_account_ownership(publer_account_id,workspace_id,owner_user_id,platform,label,label_is_username,observed_at)
      VALUES(item->>'id',p_workspace,p_owner,item->>'platform',item->>'label',(item->>'label_is_username')::boolean,p_observed_at)
      ON CONFLICT(publer_account_id) DO UPDATE SET label=excluded.label,
        label_is_username=excluded.label_is_username,observed_at=excluded.observed_at;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.publer_assign_operator_ownership(uuid,uuid,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publer_assign_operator_ownership(uuid,uuid,text,jsonb,timestamptz) TO service_role;

-- Existing configuration paths must not contradict a recorded owner.
CREATE OR REPLACE FUNCTION public.publer_check_recorded_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE mapped public.publer_account_ownership; candidate uuid;
BEGIN
  SELECT * INTO mapped FROM public.publer_account_ownership WHERE publer_account_id=NEW.publer_account_id FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='managed_accounts' THEN
    candidate:=NEW.customer_user_id;
    IF NEW.workspace_id<>mapped.workspace_id THEN RAISE EXCEPTION 'ownership_conflict'; END IF;
  ELSE candidate:=NEW.owner_user_id; END IF;
  IF candidate IS DISTINCT FROM mapped.owner_user_id THEN RAISE EXCEPTION 'ownership_conflict'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.publer_check_recorded_owner() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS managed_recorded_owner ON public.managed_accounts;
CREATE TRIGGER managed_recorded_owner BEFORE INSERT OR UPDATE ON public.managed_accounts
  FOR EACH ROW EXECUTE FUNCTION public.publer_check_recorded_owner();
DROP TRIGGER IF EXISTS legacy_recorded_owner ON public.publer_slot_config;
CREATE TRIGGER legacy_recorded_owner BEFORE INSERT OR UPDATE ON public.publer_slot_config
  FOR EACH ROW EXECUTE FUNCTION public.publer_check_recorded_owner();
COMMIT;
