-- The tests registry (daily tracker step 2, Nov 28 2026): every A/B test, planned, running or ended, with how people
-- are split, what counts as a win and how many people it needs; its numbers are filled in nightly by the server
-- (src/tests-registry.ts) from studio_daily_metrics. Additive; service-role only.
create table if not exists public.studio_tests (
  id text primary key,
  name text not null,
  status text not null default 'planned',          -- planned | running | ended
  hypothesis text,
  what_changes text,
  measure text not null default 'paid',            -- the funnel number that decides it
  audience text not null default 'valued',         -- valued (the countries that buy) | all
  focus jsonb,                                     -- the segment that decides it, e.g. {"role": "clipper"}
  split jsonb,                                     -- e.g. {"kind":"hex_parity","position":1,"odd":"walk-through","even":"control"}
  started_at timestamptz,
  ended_at timestamptz,
  needed_per_side integer,
  decision text,
  notes text,
  result jsonb,
  result_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.studio_tests enable row level security;
create policy studio_tests_service_only on public.studio_tests for all to service_role using (true) with check (true);

insert into public.studio_tests (id, name, status, hypothesis, what_changes, measure, audience, focus, split, started_at, needed_per_side, notes) values
('sim_results', 'See it before you pay (walk-through)', 'running',
 'People who watch Clone8''s steps and see locked results before the plans buy more often than people sent straight to the plans.',
 'Pressing Generate without a plan: 10-15 s of steps, then blurred locked result cards, then the plans. Control: the plans straight away.',
 'paid', 'valued', '{"role": "clipper"}', '{"kind": "hex_parity", "position": 1, "odd": "walk-through", "even": "control"}',
 '2026-11-24T06:35:00Z', 1840,
 'App: src/lib/sim-run.ts. Clipper read needs about 160 clippers a side. First read Nov 28: docs/retention/SIM_TEST_READ_2026-11-28.md.'),
('clips_real_moments', 'Clips: real moments, locked cuts', 'planned',
 'Showing a person the real moments found in their own video (titles, times, stills) before the plans beats a simulated walk-through.',
 'Pressing Find clips without a plan finds the moments for free from the video''s own captions; Cut them opens the plans.',
 'paid', 'valued', '{"first_tool": "clips"}', null, null, 360,
 'Starts after sim_results is read. About $0.10-0.30 a video. docs/retention/NEXT_TESTS_2026-11-28.md.'),
('stories_free_script', 'Stories: free script and first scene', 'planned',
 'Stories visitors (half of sign-ups, almost no buyers) buy when they see their own script and first scene before the plans.',
 'Pressing Generate on a Story without a plan writes the script and the first scene''s picture for free, then the plans.',
 'paid', 'valued', '{"first_tool": "stories"}', null, null, 800,
 'After clips_real_moments. Slowest to read (about 4 weeks). docs/retention/NEXT_TESTS_2026-11-28.md.')
on conflict (id) do nothing;
