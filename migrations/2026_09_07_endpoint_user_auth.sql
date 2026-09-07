-- WO-A: End-user auth foundation
-- Creates public.profiles + auto-provisioning trigger on auth.users insert.
-- Zero data migration (auth.users empty at time of writing).
--
-- Rollback:
--   DROP TABLE public.profiles CASCADE;
--   DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--   DROP FUNCTION IF EXISTS public.handle_new_user();
--   DROP FUNCTION IF EXISTS public.is_admin(uuid);

-- 1. profiles table -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  external_user_id  text UNIQUE NOT NULL,
  role              text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  display_name      text,
  email             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_external_user_id_idx
  ON public.profiles (external_user_id);

CREATE INDEX IF NOT EXISTS profiles_role_idx
  ON public.profiles (role) WHERE role = 'admin';

-- 2. Auto-provision profile row when a new auth.users row is inserted --------
-- external_user_id derived deterministically from user_id.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, external_user_id, email, display_name)
  VALUES (
    NEW.id,
    'user_' || replace(NEW.id::text, '-', ''),
    NEW.email,
    NULLIF(NEW.raw_user_meta_data->>'display_name', '')
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. is_admin() helper --------------------------------------------------------
-- SECURITY DEFINER + bypasses RLS via elevated privilege, so RLS policies on
-- profiles can safely call it without infinite recursion.
CREATE OR REPLACE FUNCTION public.is_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE user_id = uid AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated, anon;

-- 4. RLS ---------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- User can read their own profile OR admins can read anyone.
DROP POLICY IF EXISTS profiles_self_read ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_read ON public.profiles;
CREATE POLICY profiles_self_or_admin_read ON public.profiles
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

-- User can update display_name only (email + role + external_user_id locked
-- via a BEFORE UPDATE trigger below, since RLS WITH CHECK subqueries hit the
-- same policy and would recurse).
DROP POLICY IF EXISTS profiles_self_update ON public.profiles;
CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- BEFORE UPDATE trigger: force-preserve locked columns on self-update.
CREATE OR REPLACE FUNCTION public.profiles_lock_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- If the update is being done by the row's owner (not service_role), keep
  -- role/external_user_id/email/user_id stable regardless of what was
  -- submitted. Service role updates (server-side) can change anything.
  IF auth.role() = 'authenticated' THEN
    NEW.user_id := OLD.user_id;
    NEW.role := OLD.role;
    NEW.external_user_id := OLD.external_user_id;
    NEW.email := OLD.email;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_lock_columns_trg ON public.profiles;
CREATE TRIGGER profiles_lock_columns_trg
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_lock_columns();

GRANT SELECT, UPDATE ON public.profiles TO authenticated;
