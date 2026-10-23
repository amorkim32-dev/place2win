-- Protect VIP picks at the database boundary and expose only non-sensitive
-- fixture metadata to visitors without an active, approved subscription.

-- Ensure the predictions table and columns exist even if an earlier setup step
-- was skipped or partially applied.
create table if not exists public.ai_match_predictions (
  fixture_id bigint primary key,
  home_team text not null,
  away_team text not null,
  competition text not null,
  kickoff_at timestamptz not null,
  prediction text not null,
  confidence smallint not null default 50 check (confidence between 1 and 100),
  rationale text not null default '',
  probabilities jsonb not null default '{}'::jsonb,
  model text not null default 'gpt-4o-mini',
  admin_overridden boolean not null default false,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  pick_outcome text,
  actual_outcome text,
  result_home_score smallint,
  result_away_score smallint,
  result_halftime_home_score smallint,
  result_halftime_away_score smallint,
  result_source text,
  result_recorded_at timestamptz
);

alter table public.ai_match_predictions
  add column if not exists home_team text not null default 'Home team',
  add column if not exists away_team text not null default 'Away team',
  add column if not exists competition text not null default 'Football',
  add column if not exists kickoff_at timestamptz not null default now(),
  add column if not exists prediction text not null default 'Prediction pending',
  add column if not exists confidence smallint not null default 50,
  add column if not exists rationale text not null default '',
  add column if not exists probabilities jsonb not null default '{}'::jsonb,
  add column if not exists model text not null default 'gpt-4o-mini',
  add column if not exists admin_overridden boolean not null default false,
  add column if not exists generated_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists pick_outcome text,
  add column if not exists actual_outcome text,
  add column if not exists result_home_score smallint,
  add column if not exists result_away_score smallint,
  add column if not exists result_halftime_home_score smallint,
  add column if not exists result_halftime_away_score smallint,
  add column if not exists result_source text,
  add column if not exists result_recorded_at timestamptz;

alter table public.vip_payments
  add column if not exists approved_at timestamptz;

create or replace function public.place2win_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users as admins
    where admins.user_id = (select auth.uid())
  );
$$;

create or replace function public.place2win_has_active_vip()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.vip_payments as payment
    where payment.user_id = (select auth.uid())
      and payment.status = 'approved'
      and payment.plan in ('daily', 'weekly', 'monthly')
      and coalesce(payment.approved_at, payment.submitted_at) is not null
      and coalesce(payment.approved_at, payment.submitted_at) +
        case payment.plan
          when 'daily' then interval '1 day'
          when 'weekly' then interval '7 days'
          when 'monthly' then interval '30 days'
        end > now()
  );
$$;

create or replace function public.place2win_is_vip_match(p_home text, p_away text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.matches as match
    where match.is_vip = true
      and (
        (regexp_replace(lower(coalesce(match.home_team, '')), '[^a-z0-9]', '', 'g') = regexp_replace(lower(coalesce(p_home, '')), '[^a-z0-9]', '', 'g')
          and regexp_replace(lower(coalesce(match.away_team, '')), '[^a-z0-9]', '', 'g') = regexp_replace(lower(coalesce(p_away, '')), '[^a-z0-9]', '', 'g'))
        or
        (regexp_replace(lower(coalesce(match.home_team, '')), '[^a-z0-9]', '', 'g') = regexp_replace(lower(coalesce(p_away, '')), '[^a-z0-9]', '', 'g')
          and regexp_replace(lower(coalesce(match.away_team, '')), '[^a-z0-9]', '', 'g') = regexp_replace(lower(coalesce(p_home, '')), '[^a-z0-9]', '', 'g'))
      )
  );
$$;

revoke all on function public.place2win_is_admin() from public, anon;
revoke all on function public.place2win_has_active_vip() from public, anon;
revoke all on function public.place2win_is_vip_match(text, text) from public, anon;
-- These boolean helpers deliberately return false without a signed-in user;
-- anon needs execute permission because RLS evaluates the same policy for it.
grant execute on function public.place2win_is_admin() to anon, authenticated;
grant execute on function public.place2win_has_active_vip() to anon, authenticated;
grant execute on function public.place2win_is_vip_match(text, text) to anon, authenticated;

-- Approval time starts the paid access period. A database default covers old
-- admin approval buttons that only update status.
create or replace function public.place2win_set_vip_approved_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    new.approved_at := now();
  elsif new.status <> 'approved' then
    new.approved_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists place2win_vip_approved_at on public.vip_payments;
create trigger place2win_vip_approved_at
before insert or update of status on public.vip_payments
for each row execute function public.place2win_set_vip_approved_at();

alter table public.vip_payments enable row level security;
do $$
declare policy_row record;
begin
  for policy_row in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'vip_payments'
  loop
    execute format('drop policy if exists %I on public.vip_payments', policy_row.policyname);
  end loop;
end $$;

create policy "Members read their own VIP payments"
  on public.vip_payments for select to authenticated
  using (user_id = (select auth.uid()) or (select public.place2win_is_admin()));
create policy "Members submit their own pending VIP payment"
  on public.vip_payments for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and ((plan = 'daily' and amount = 300) or (plan = 'weekly' and amount = 1000) or (plan = 'monthly' and amount = 2500))
  );
create policy "Admins manage VIP payments"
  on public.vip_payments for all to authenticated
  using ((select public.place2win_is_admin()))
  with check ((select public.place2win_is_admin()));
grant select, insert on public.vip_payments to authenticated;
grant update on public.vip_payments to authenticated;

-- Guests can see free match predictions. VIP rows are readable only to active
-- members; the preview view intentionally omits the prediction column.
alter table public.matches enable row level security;
do $$
declare policy_row record;
begin
  for policy_row in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'matches'
  loop
    execute format('drop policy if exists %I on public.matches', policy_row.policyname);
  end loop;
end $$;

create policy "Visitors read free matches"
  on public.matches for select to anon, authenticated
  using (not coalesce(is_vip, false));
create policy "Active members read VIP matches"
  on public.matches for select to authenticated
  using (coalesce(is_vip, false) and ((select public.place2win_has_active_vip()) or (select public.place2win_is_admin())));
create policy "Admins manage matches"
  on public.matches for all to authenticated
  using ((select public.place2win_is_admin()))
  with check ((select public.place2win_is_admin()));
grant select on public.matches to anon, authenticated;
grant insert, update, delete on public.matches to authenticated;

create or replace view public.vip_match_previews
with (security_barrier = true)
as
  select id, home_team, away_team, competition, odds, is_vip, confidence, is_bet_of_day
  from public.matches
  where is_vip = true;
grant select on public.vip_match_previews to anon, authenticated;

alter table public.ai_match_predictions enable row level security;
do $$
declare policy_row record;
begin
  for policy_row in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ai_match_predictions'
  loop
    execute format('drop policy if exists %I on public.ai_match_predictions', policy_row.policyname);
  end loop;
end $$;

create policy "Free AI predictions and member VIP predictions"
  on public.ai_match_predictions for select to anon, authenticated
  using (
    not (select public.place2win_is_vip_match(home_team, away_team))
    or (select public.place2win_has_active_vip())
    or (select public.place2win_is_admin())
  );
create policy "Admins edit AI predictions"
  on public.ai_match_predictions for update to authenticated
  using ((select public.place2win_is_admin()))
  with check ((select public.place2win_is_admin()));
grant select on public.ai_match_predictions to anon, authenticated;
grant update (prediction, confidence, rationale, admin_overridden, updated_at, pick_outcome)
  on public.ai_match_predictions to authenticated;

