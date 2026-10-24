-- Clone8 client organizations and invite links.
--
-- An organization groups the people at a client (members) and the managed accounts they may see
-- (accounts). Ownership of an account never moves: publer_slot_config.owner_user_id stays the
-- operator (enforced by publer_check_recorded_owner). Membership grants read-only visibility and
-- nothing else; every write path still requires the operator.
-- Invites are single-use links. Only the SHA-256 hash of the token is stored; the link itself is
-- shown to the operator once and shared by hand (no email provider is involved).
-- Service role only. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.client_orgs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.client_org_members(
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_via uuid,                       -- the invite that was accepted, when any
  PRIMARY KEY(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS client_org_members_user ON public.client_org_members(user_id);

CREATE TABLE IF NOT EXISTS public.client_org_accounts(
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  phone_slot text NOT NULL REFERENCES public.publer_slot_config(phone_slot) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id, phone_slot)
);
CREATE INDEX IF NOT EXISTS client_org_accounts_slot ON public.client_org_accounts(phone_slot);

CREATE TABLE IF NOT EXISTS public.client_invites(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  email text CHECK(email IS NULL OR (length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  CHECK(expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS client_invites_org ON public.client_invites(org_id);

-- The accounts a signed-in person may see through their organizations. The backend reads this
-- once per request and unions it with accounts the person owns directly.
CREATE OR REPLACE VIEW public.client_visible_accounts AS
  SELECT m.user_id, a.phone_slot, o.id AS org_id, o.name AS org_name
  FROM public.client_org_members m
  JOIN public.client_orgs o ON o.id = m.org_id AND o.archived_at IS NULL
  JOIN public.client_org_accounts a ON a.org_id = m.org_id;

ALTER TABLE public.client_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_org_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_orgs, public.client_org_members, public.client_org_accounts, public.client_invites, public.client_visible_accounts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_orgs, public.client_org_members, public.client_org_accounts, public.client_invites TO service_role;
GRANT SELECT ON public.client_visible_accounts TO service_role;

-- Accept an invite atomically. Raises invite_invalid, invite_revoked, invite_used, invite_expired or
-- invite_email_mismatch. Accepting the same invite twice as the same person is a no-op success.
CREATE OR REPLACE FUNCTION public.client_accept_invite(p_user uuid, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE inv public.client_invites; org public.client_orgs; user_email text;
BEGIN
  IF p_user IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invite_invalid'; END IF;
  SELECT * INTO inv FROM public.client_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invite_invalid'; END IF;
  SELECT * INTO org FROM public.client_orgs WHERE id = inv.org_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invite_invalid'; END IF;
  IF inv.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'invite_revoked'; END IF;
  IF inv.accepted_at IS NOT NULL THEN
    IF inv.accepted_by = p_user THEN
      RETURN jsonb_build_object('org_id', org.id, 'org_name', org.name, 'slug', org.slug, 'already_member', true);
    END IF;
    RAISE EXCEPTION 'invite_used';
  END IF;
  IF inv.expires_at <= now() THEN RAISE EXCEPTION 'invite_expired'; END IF;
  IF inv.email IS NOT NULL THEN
    SELECT lower(email) INTO user_email FROM auth.users WHERE id = p_user;
    IF user_email IS DISTINCT FROM lower(inv.email) THEN RAISE EXCEPTION 'invite_email_mismatch'; END IF;
  END IF;
  INSERT INTO public.client_org_members(org_id, user_id, added_via) VALUES (inv.org_id, p_user, inv.id)
    ON CONFLICT (org_id, user_id) DO NOTHING;
  UPDATE public.client_invites SET accepted_at = now(), accepted_by = p_user WHERE id = inv.id;
  RETURN jsonb_build_object('org_id', org.id, 'org_name', org.name, 'slug', org.slug, 'already_member', false);
END $$;
REVOKE ALL ON FUNCTION public.client_accept_invite(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_accept_invite(uuid, text) TO service_role;

COMMIT;
