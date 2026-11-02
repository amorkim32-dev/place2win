-- Shared competition visibility controls for FOOTBALL AI HUB.
create table if not exists public.football_hub_league_settings (
  league_id bigint primary key,
  league_name text not null,
  country text not null default 'International',
  is_enabled boolean not null default true,
  is_featured boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.football_hub_league_settings enable row level security;
drop policy if exists "Visitors see enabled competitions" on public.football_hub_league_settings;
drop policy if exists "Hub administrators manage competitions" on public.football_hub_league_settings;
create policy "Visitors see enabled competitions"
  on public.football_hub_league_settings for select to anon, authenticated
  using (is_enabled or (select public.place2win_is_admin()));
create policy "Hub administrators manage competitions"
  on public.football_hub_league_settings for all to authenticated
  using ((select public.place2win_is_admin()))
  with check ((select public.place2win_is_admin()));
grant select on public.football_hub_league_settings to anon, authenticated;
grant insert, update, delete on public.football_hub_league_settings to authenticated;

