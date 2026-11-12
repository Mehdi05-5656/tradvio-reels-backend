-- Emails to people who signed up and did not pick a plan: one row per person per step, written BEFORE the email is
-- sent (the unique key is the claim), so a restart or a second server never sends a step twice.
create table if not exists public.studio_nudges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  step text not null check (step in ('plan_30m', 'plan_day1')),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'skipped')),
  reason text,
  message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, step)
);
create index if not exists studio_nudges_created_idx on public.studio_nudges (created_at desc);
alter table public.studio_nudges enable row level security; -- service role only: no policies
