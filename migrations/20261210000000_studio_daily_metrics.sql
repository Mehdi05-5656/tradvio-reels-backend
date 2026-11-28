-- The daily tracker (Nov 28 2026): one row per Pacific day per group of people, written by the server every night
-- (src/daily-metrics.ts). cut 'all' holds the day's activity too (sales, cancels, runs, cost); the other cuts hold the
-- sign-up funnel of the people who signed up that day. Additive; service-role only.
create table if not exists public.studio_daily_metrics (
  day date not null,
  cut text not null,
  value text not null default '',
  metrics jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (day, cut, value)
);
alter table public.studio_daily_metrics enable row level security;
drop policy if exists studio_daily_metrics_service_only on public.studio_daily_metrics;
create policy studio_daily_metrics_service_only on public.studio_daily_metrics for all to service_role using (true) with check (true);
