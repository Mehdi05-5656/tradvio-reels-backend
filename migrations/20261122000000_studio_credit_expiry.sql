-- Clone8 Studio: credits expire (owner's rule, Nov 13 2026). Credits roll over, and each batch of credits expires a set
-- time after it was received:
--   plan credits (monthly, each month of a yearly plan, Apple plan periods), gifts, promo codes, referrals: 60 days
--   credits bought outright on the website (top-ups, packs): 12 months
--   credits bought in the iPhone app (Apple packs): never (App Store Review Guideline 3.1.1)
-- Credits already held when this runs get a fresh 60 days from today. A yearly plan's credits arrive month by month
-- (each month's credits then last 60 days); people on a yearly plan today keep one month's worth now and the rest of
-- their balance is held and released on their plan's monthly dates. Credits refunded from a failed or canceled video go
-- back to the batches they came from and keep those batches' dates.
--
-- How: the ledger (studio_credit_ledger) stays the one source of the balance (studio_balance is unchanged). Beside it,
-- studio_credit_lots holds every batch with what is left of it and its expiry; a trigger on the ledger keeps the batches
-- in step with every row written (credits in: a new batch; credits out: taken from the batches that expire soonest;
-- a refund: back to the batches the video used, recorded in studio_credit_lot_uses). studio_credit_schedule holds the
-- months of a yearly plan still to come. studio_credit_maintenance(), every hour (pg_cron), releases what is due and
-- writes an 'expire' row for what is left of each batch past its date.
--
-- studio_grant no longer expires the last period's plan credits at renewal (p_expire_previous is kept so callers do not
-- break, and ignored). New: studio_grant_spread (a total spread over monthly batches), studio_credit_summary (what the
-- app shows). Rows are service role only, like the ledger.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_credit_lots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plan', 'gift', 'promo', 'topup', 'apple_pack', 'legacy', 'refund')),
  amount integer NOT NULL CHECK (amount > 0),
  remaining integer NOT NULL CHECK (remaining >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                 -- null: never
  ref text,
  ledger_id bigint                        -- the ledger row that brought it (null for the batches made at the switch-on)
);
CREATE INDEX IF NOT EXISTS studio_credit_lots_live ON public.studio_credit_lots (user_id, expires_at, id) WHERE remaining > 0;
CREATE INDEX IF NOT EXISTS studio_credit_lots_due ON public.studio_credit_lots (expires_at) WHERE remaining > 0 AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.studio_credit_lot_uses (
  job_id uuid NOT NULL,
  lot_id bigint NOT NULL REFERENCES public.studio_credit_lots (id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (job_id, lot_id)
);

CREATE TABLE IF NOT EXISTS public.studio_credit_schedule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount > 0),
  release_at timestamptz NOT NULL,
  ref text NOT NULL,                      -- becomes the grant's ref (unique per person), e.g. "in_123:m2"
  note text,
  released_at timestamptz,
  canceled_at timestamptz
);
CREATE INDEX IF NOT EXISTS studio_credit_schedule_due ON public.studio_credit_schedule (release_at) WHERE released_at IS NULL AND canceled_at IS NULL;
CREATE INDEX IF NOT EXISTS studio_credit_schedule_user ON public.studio_credit_schedule (user_id) WHERE released_at IS NULL AND canceled_at IS NULL;

ALTER TABLE public.studio_credit_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_credit_lot_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_credit_schedule ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_credit_lots, public.studio_credit_lot_uses, public.studio_credit_schedule FROM anon, authenticated;

-- what kind of batch a ledger row brings, read from what wrote it (refs and notes as studio.ts, studio-topup.ts and
-- studio-apple.ts write them)
CREATE OR REPLACE FUNCTION public.studio_credit_kind(p_reason text, p_ref text, p_note text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  SELECT CASE
    WHEN p_reason = 'promo' THEN 'promo'
    WHEN coalesce(p_ref, '') LIKE 'apple\_%' THEN 'apple_pack'                       -- a pack bought in the iPhone app
    WHEN coalesce(p_ref, '') LIKE 'in\_%' THEN 'plan'                                -- a plan period (Stripe "in_…", Apple "in_apple_…", their months "…:mN")
    WHEN coalesce(p_note, '') ~* '^(auto )?top-up' OR coalesce(p_note, '') ~* ' pack$' THEN 'topup'  -- bought on the website
    ELSE 'gift' END
$$;
-- how long a batch lasts
CREATE OR REPLACE FUNCTION public.studio_credit_expiry(p_kind text, p_at timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  SELECT CASE p_kind WHEN 'apple_pack' THEN NULL WHEN 'topup' THEN p_at + interval '365 days' ELSE p_at + interval '60 days' END
$$;

-- the batches follow every ledger row
CREATE OR REPLACE FUNCTION public.studio_credit_lots_follow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
DECLARE need integer; take integer; k text; l record; u record;
BEGIN
  -- written by studio_credit_maintenance after it has emptied the batch itself
  IF NEW.reason = 'expire' THEN RETURN NEW; END IF;
  IF NEW.delta > 0 AND NEW.reason = 'refund' THEN
    -- back to the batches this video used, latest-expiring first, each keeping its own date
    need := NEW.delta;
    IF NEW.job_id IS NOT NULL THEN
      FOR u IN SELECT lu.lot_id, lu.amount FROM public.studio_credit_lot_uses lu JOIN public.studio_credit_lots lo ON lo.id = lu.lot_id
               WHERE lu.job_id = NEW.job_id AND lu.amount > 0 ORDER BY lo.expires_at DESC NULLS FIRST, lo.id DESC LOOP
        EXIT WHEN need <= 0;
        take := least(need, u.amount);
        UPDATE public.studio_credit_lots SET remaining = remaining + take WHERE id = u.lot_id;
        UPDATE public.studio_credit_lot_uses SET amount = amount - take WHERE job_id = NEW.job_id AND lot_id = u.lot_id;
        need := need - take;
      END LOOP;
    END IF;
    -- a video that reserved its credits before batches existed: what comes back is a batch of its own
    IF need > 0 THEN
      INSERT INTO public.studio_credit_lots (user_id, kind, amount, remaining, received_at, expires_at, ref, ledger_id)
        VALUES (NEW.user_id, 'refund', need, need, NEW.created_at, public.studio_credit_expiry('refund', NEW.created_at), 'refund', NEW.id);
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.delta > 0 THEN
    -- credits in: a batch, dated from now
    k := CASE WHEN NEW.reason IN ('grant', 'promo') THEN public.studio_credit_kind(NEW.reason, NEW.ref, NEW.note) ELSE 'gift' END;
    INSERT INTO public.studio_credit_lots (user_id, kind, amount, remaining, received_at, expires_at, ref, ledger_id)
      VALUES (NEW.user_id, k, NEW.delta, NEW.delta, NEW.created_at, public.studio_credit_expiry(k, NEW.created_at), NEW.ref, NEW.id);
    RETURN NEW;
  END IF;
  -- credits out (a video's reservation, an adjustment): from the batches that expire soonest; never-expiring ones last
  need := -NEW.delta;
  FOR l IN SELECT id, remaining FROM public.studio_credit_lots WHERE user_id = NEW.user_id AND remaining > 0
           ORDER BY expires_at ASC NULLS LAST, id ASC FOR UPDATE LOOP
    EXIT WHEN need <= 0;
    take := least(need, l.remaining);
    UPDATE public.studio_credit_lots SET remaining = remaining - take WHERE id = l.id;
    IF NEW.job_id IS NOT NULL THEN
      INSERT INTO public.studio_credit_lot_uses (job_id, lot_id, amount) VALUES (NEW.job_id, l.id, take)
        ON CONFLICT (job_id, lot_id) DO UPDATE SET amount = public.studio_credit_lot_uses.amount + EXCLUDED.amount;
    END IF;
    need := need - take;
  END LOOP;
  RETURN NEW;
END $$;

-- a grant: unchanged except that nothing expires at renewal any more (each batch has its own date)
CREATE OR REPLACE FUNCTION public.studio_grant(p_user uuid, p_credits integer, p_ref text, p_expire_previous boolean DEFAULT true, p_note text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
DECLARE c public.studio_customers;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  IF p_ref IS NULL OR length(p_ref) = 0 THEN RAISE EXCEPTION 'ref_required'; END IF;
  c := public.studio_lock_customer(p_user);
  IF EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref = p_ref) THEN
    RETURN jsonb_build_object('granted', false, 'expired', 0, 'balance', public.studio_balance(p_user));
  END IF;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p_credits, 'grant', p_ref, p_note);
  RETURN jsonb_build_object('granted', true, 'expired', 0, 'balance', public.studio_balance(p_user));
END $$;

-- a total that arrives in monthly batches: the first now, the rest one month apart until p_until (a yearly plan's year:
-- twelve batches; an upgrade part-way through a year: one per month left). Idempotent on p_ref, like studio_grant.
CREATE OR REPLACE FUNCTION public.studio_grant_spread(p_user uuid, p_total integer, p_ref text, p_until timestamptz, p_note text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
DECLARE c public.studio_customers; n integer := 1; each integer; first integer; k integer; t0 timestamptz := now();
BEGIN
  IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  IF p_ref IS NULL OR length(p_ref) = 0 THEN RAISE EXCEPTION 'ref_required'; END IF;
  c := public.studio_lock_customer(p_user);
  IF EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref = p_ref) THEN
    RETURN jsonb_build_object('granted', false, 'balance', public.studio_balance(p_user));
  END IF;
  -- months from now to the end, counting this one (a date a few hours short of a month still counts as that month)
  WHILE p_until IS NOT NULL AND t0 + make_interval(months => n) < p_until - interval '1 day' AND n < 60 LOOP n := n + 1; END LOOP;
  each := p_total / n; first := p_total - each * (n - 1);
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, first, 'grant', p_ref, p_note);
  FOR k IN 1 .. n - 1 LOOP
    INSERT INTO public.studio_credit_schedule (user_id, amount, release_at, ref, note)
      VALUES (p_user, each, t0 + make_interval(months => k), p_ref || ':m' || (k + 1), coalesce(p_note, 'Plan credits') || ' · month ' || (k + 1));
  END LOOP;
  RETURN jsonb_build_object('granted', true, 'now', first, 'months', n, 'each', each, 'balance', public.studio_balance(p_user));
END $$;

-- every hour: release the months that are due, expire what is left of batches past their date
CREATE OR REPLACE FUNCTION public.studio_credit_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
DECLARE s record; l record; amt integer; released integer := 0; expired integer := 0; bal integer;
BEGIN
  FOR s IN SELECT * FROM public.studio_credit_schedule WHERE released_at IS NULL AND canceled_at IS NULL AND release_at <= now()
           ORDER BY release_at, id FOR UPDATE SKIP LOCKED LOOP
    PERFORM public.studio_lock_customer(s.user_id);
    IF NOT EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = s.user_id AND reason = 'grant' AND ref = s.ref) THEN
      INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (s.user_id, s.amount, 'grant', s.ref, s.note);
      released := released + s.amount;
    END IF;
    UPDATE public.studio_credit_schedule SET released_at = now() WHERE id = s.id;
  END LOOP;
  FOR l IN SELECT * FROM public.studio_credit_lots WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now()
           ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LOOP
    PERFORM public.studio_lock_customer(l.user_id);
    -- never more than the balance (expiring must not take anyone below zero)
    bal := public.studio_balance(l.user_id); amt := least(l.remaining, greatest(0, bal));
    UPDATE public.studio_credit_lots SET remaining = 0 WHERE id = l.id;
    IF amt > 0 THEN
      INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note)
        VALUES (l.user_id, -amt, 'expire', 'lot:' || l.id, 'Received ' || to_char(l.received_at AT TIME ZONE 'UTC', 'Mon FMDD') || ', expired ' || to_char(l.expires_at AT TIME ZONE 'UTC', 'Mon FMDD'));
      expired := expired + amt;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('released', released, 'expired', expired);
END $$;

-- what the app shows beside the balance: the next batch to expire, and the next month of a yearly plan still to come
CREATE OR REPLACE FUNCTION public.studio_credit_summary(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  WITH live AS (SELECT remaining, expires_at FROM public.studio_credit_lots WHERE user_id = p_user AND remaining > 0 AND expires_at IS NOT NULL),
       first_day AS (SELECT min(date_trunc('day', expires_at)) AS d FROM live),
       nxt AS (SELECT min(release_at) AS at FROM public.studio_credit_schedule WHERE user_id = p_user AND released_at IS NULL AND canceled_at IS NULL)
  SELECT jsonb_build_object(
    'expiring', (SELECT CASE WHEN f.d IS NULL THEN NULL ELSE jsonb_build_object('credits', (SELECT sum(remaining) FROM live WHERE date_trunc('day', expires_at) = f.d), 'at', (SELECT min(expires_at) FROM live WHERE date_trunc('day', expires_at) = f.d)) END FROM first_day f),
    'never', (SELECT coalesce(sum(remaining), 0) FROM public.studio_credit_lots WHERE user_id = p_user AND remaining > 0 AND expires_at IS NULL),
    'upcoming', (SELECT CASE WHEN n.at IS NULL THEN NULL ELSE jsonb_build_object('credits', (SELECT sum(amount) FROM public.studio_credit_schedule WHERE user_id = p_user AND released_at IS NULL AND canceled_at IS NULL AND release_at = n.at), 'at', n.at, 'held', (SELECT sum(amount) FROM public.studio_credit_schedule WHERE user_id = p_user AND released_at IS NULL AND canceled_at IS NULL)) END FROM nxt n)
  )
$$;

DROP TRIGGER IF EXISTS studio_credit_lots_follow ON public.studio_credit_ledger;
CREATE TRIGGER studio_credit_lots_follow AFTER INSERT ON public.studio_credit_ledger FOR EACH ROW EXECUTE FUNCTION public.studio_credit_lots_follow();

-- ---- the switch-on: what everyone holds today becomes one batch with a fresh 60 days; on a yearly plan, one month's
-- credits now and the rest held for the plan's coming monthly dates (released by the hourly run, 60 days each)
DO $$
DECLARE r record; hold integer; now_amt integer; k integer; at timestamptz; amt integer; left_ integer; lot bigint;
BEGIN
  FOR r IN SELECT b.user_id, b.bal, c.billing_interval, c.status, c.period_start, c.period_end, coalesce(c.credits_per_period, 0) AS credits_per_period, c.plan_id
           FROM (SELECT user_id, sum(delta)::integer AS bal FROM public.studio_credit_ledger GROUP BY user_id HAVING sum(delta) > 0) b
           LEFT JOIN public.studio_customers c ON c.user_id = b.user_id LOOP
    INSERT INTO public.studio_credit_lots (user_id, kind, amount, remaining, received_at, expires_at, ref)
      VALUES (r.user_id, 'legacy', r.bal, r.bal, now(), now() + interval '60 days', 'switch-on') RETURNING id INTO lot;
    IF r.billing_interval = 'year' AND r.status IN ('active', 'trialing', 'past_due') AND r.period_end > now() AND r.credits_per_period > 0 AND r.bal > r.credits_per_period THEN
      -- the plan's monthly dates still to come in this year, one month's credits each, as far as the balance goes
      hold := 0; left_ := r.bal - r.credits_per_period; k := 1;
      LOOP
        at := r.period_start + make_interval(months => k);
        EXIT WHEN at >= r.period_end OR left_ <= 0 OR k > 12;
        IF at > now() THEN
          amt := least(r.credits_per_period, left_);
          INSERT INTO public.studio_credit_schedule (user_id, amount, release_at, ref, note)
            VALUES (r.user_id, amt, at, 'in_switch-on:' || r.user_id || ':m' || (k + 1), initcap(coalesce(r.plan_id, 'plan')) || ' yearly · month ' || (k + 1));
          hold := hold + amt; left_ := left_ - amt;
        END IF;
        k := k + 1;
      END LOOP;
      IF hold > 0 THEN
        -- (taken from the switch-on batch by the trigger: what is left of it is this month's credits and anything bought)
        INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note)
          VALUES (r.user_id, -hold, 'adjust', 'switch-on-hold', 'Held for the coming months of your yearly plan: they arrive on your plan''s monthly date');
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
