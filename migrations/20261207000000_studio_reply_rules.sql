-- Clone8 Studio: reply-only auto-replies on Instagram and Facebook (owner, Nov 24 2026: "an option that allows only for
-- reply without sending a DM, and having a DM as an option to toggle on"; src/studio-reply-only.ts).
-- The posting service's own comment rules must send a DM on Instagram and Facebook, so a rule with the DM switched off
-- runs at Clone8: the service tells us about each new comment (comment.received), we match the keyword and post the
-- public reply. Rules with a DM, and every TikTok, YouTube, Threads and LinkedIn rule, stay with the service as today.
-- Additive only. The code works before this is applied: the reply-only choice stays hidden until
-- STUDIO_AUTOREPLY_REPLY_ONLY=true is set, and that switch is set only after this is applied.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_reply_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id text NOT NULL,                    -- the posting service's id for the linked account
  platform text NOT NULL CHECK (platform IN ('instagram', 'facebook')),
  name text NOT NULL DEFAULT 'Auto-reply',
  keywords text[] NOT NULL DEFAULT '{}',
  match text NOT NULL DEFAULT 'word' CHECK (match IN ('word', 'contains', 'exact')),
  exclude text[] NOT NULL DEFAULT '{}',
  comment_reply text NOT NULL,
  reply_variations text[] NOT NULL DEFAULT '{}',
  post_id text,                                -- one post (the service's post id), or null for every post
  platform_post_id text,                       -- the same post by its network id (a post picked from the account)
  post_title text,
  repeat text NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'every')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_reply_rules_account_idx ON public.studio_reply_rules (account_id) WHERE active;
CREATE INDEX IF NOT EXISTS studio_reply_rules_user_idx ON public.studio_reply_rules (user_id);

-- One row per comment a rule answered (or tried to). The unique pair is what keeps a comment from ever being answered
-- twice: the row is written before the reply is sent, and a failed or unknown send is never retried.
CREATE TABLE IF NOT EXISTS public.studio_reply_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES public.studio_reply_rules (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  comment_id text NOT NULL,
  commenter_id text,
  commenter text,
  comment_text text,
  reply_text text,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, comment_id)
);
CREATE INDEX IF NOT EXISTS studio_reply_log_rule_idx ON public.studio_reply_log (rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_reply_log_commenter_idx ON public.studio_reply_log (rule_id, commenter_id, created_at DESC);

-- Server only (service role), like every other studio_ table.
ALTER TABLE public.studio_reply_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_reply_log ENABLE ROW LEVEL SECURITY;

COMMIT;
