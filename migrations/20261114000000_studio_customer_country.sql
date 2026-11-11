-- The country each Studio person reaches us from, for the admin panel's People list (src/studio-geo.ts).
-- Two-letter code from the edge's CF-IPCountry header; no IP address is kept. Additive: two nullable columns.
alter table public.studio_customers add column if not exists country text;
alter table public.studio_customers add column if not exists country_at timestamptz;
alter table public.studio_customers drop constraint if exists studio_customers_country_code;
alter table public.studio_customers add constraint studio_customers_country_code check (country is null or country ~ '^[A-Z]{2}$');
