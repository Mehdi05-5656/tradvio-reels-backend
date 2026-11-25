-- Clone8 Studio: Text Clone8, the assistant people text on Telegram (docs/text-bot/PLAN.md, phase 2;
-- src/text-bot/server.ts). Five tables, all service-role only (RLS on, no policies): the app reaches them through the
-- backend's own routes, never directly.
-- Additive only. The code works before this is applied: nothing reads these tables until STUDIO_TEXT_ENABLED=true is
-- set, and that switch is set only after this is applied.
BEGIN;

-- Which chat belongs to which Clone8 account. A row starts 'pending' when someone taps Start in Telegram with a
-- one-time link from the app, and becomes 'linked' only when the account's owner taps Confirm in the app.
CREATE TABLE IF NOT EXISTS public.studio_text_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'telegram' CHECK (channel IN ('telegram')),
  sender_id text NOT NULL,                  -- the person's id on the channel (Telegram user id)
  chat_id text NOT NULL,                    -- the private chat with the bot
  handle text,                              -- the name Telegram showed, for the app's "is this you?" line
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'linked', 'removed')),
  timezone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  last_used_at timestamptz
);
-- one Clone8 account per Telegram account at a time
CREATE UNIQUE INDEX IF NOT EXISTS studio_text_links_sender_linked ON public.studio_text_links (channel, sender_id) WHERE status = 'linked';
CREATE INDEX IF NOT EXISTS studio_text_links_user_idx ON public.studio_text_links (user_id, status);

-- One-time connection codes (only their sha256 is kept). Ten minutes, one use.
CREATE TABLE IF NOT EXISTS public.studio_text_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'telegram',
  timezone text,
  sender_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS studio_text_codes_user_idx ON public.studio_text_codes (user_id, created_at);

-- Each chat's working state: its recent talk, the action waiting for a YES, the runs being watched.
CREATE TABLE IF NOT EXISTS public.studio_text_chats (
  channel text NOT NULL,
  chat_id text NOT NULL,
  user_id uuid NOT NULL,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  watching boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, chat_id)
);
CREATE INDEX IF NOT EXISTS studio_text_chats_watching_idx ON public.studio_text_chats (channel) WHERE watching;

-- Every message Telegram delivers, written before it is answered, so a restart or deploy loses nothing. The unique
-- update id is what makes a message Telegram sends twice count once.
CREATE TABLE IF NOT EXISTS public.studio_text_inbox (
  channel text NOT NULL,
  update_id bigint NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  done_at timestamptz,
  PRIMARY KEY (channel, update_id)
);
CREATE INDEX IF NOT EXISTS studio_text_inbox_open_idx ON public.studio_text_inbox (channel, update_id) WHERE done_at IS NULL;

-- The append-only log: every message in and out, every lookup, question, YES, action and error (the weekly review
-- reads this). Message text is kept, as the owner asked, so conversations can be read back.
CREATE TABLE IF NOT EXISTS public.studio_text_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid,
  channel text NOT NULL DEFAULT 'telegram',
  chat_id text,
  event text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_text_events_at_idx ON public.studio_text_events (at);
CREATE INDEX IF NOT EXISTS studio_text_events_user_idx ON public.studio_text_events (user_id, at);

ALTER TABLE public.studio_text_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_text_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_text_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_text_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_text_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_text_links, public.studio_text_codes, public.studio_text_chats, public.studio_text_inbox, public.studio_text_events FROM anon, authenticated;

COMMIT;
