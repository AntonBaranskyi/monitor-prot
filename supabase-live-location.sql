-- =====================================================================
--  My Travel Hub — live location sharing (secured)
--  Run ONCE in Supabase -> SQL Editor. Safe to re-run.
--
--  A traveller opts in to share their position while driving; the app
--  writes one row per (user, trip). Followers on the trip's shared
--  status link see the position move.
--
--  NOTE: the trip_locations table already existed from an earlier
--  attempt and was left WIDE OPEN to the public anon key (anyone could
--  read or write anybody's coordinates). This script locks it down to
--  match the rest of the app: you may only write your OWN row, only
--  people on the trip may read it, and anonymous followers can read
--  only through a share-token-gated function.
-- =====================================================================

create table if not exists public.trip_locations (
  user_id    text not null,
  trip_id    text not null,
  lat        double precision,
  lon        double precision,
  sharing    boolean     not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, trip_id)
);

-- Real, un-spoofable identity so RLS can key on it (same pattern as profiles).
alter table public.trip_locations add column if not exists auth_uid uuid;

-- Backfill from the profiles directory where we can.
update public.trip_locations l
set    auth_uid = p.auth_uid
from   public.profiles p
where  p.user_id = l.user_id and l.auth_uid is distinct from p.auth_uid;

-- Drop any stale rows that predate this (old test/lat-lon-less records).
delete from public.trip_locations where auth_uid is null;

alter table public.trip_locations enable row level security;

do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'trip_locations'
  loop execute format('drop policy %I on public.trip_locations', r.policyname);
  end loop;
end $$;

-- Remove the old blanket anon access.
revoke all on public.trip_locations from anon;
grant select, insert, update, delete on public.trip_locations to authenticated;

-- WRITE: only your own row.
create policy loc_insert on public.trip_locations
  for insert to authenticated with check (auth_uid = auth.uid());
create policy loc_update on public.trip_locations
  for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());
create policy loc_delete on public.trip_locations
  for delete to authenticated using (auth_uid = auth.uid());

-- READ: anyone who belongs to that trip (owner, member or invited viewer).
create policy loc_select on public.trip_locations
  for select to authenticated using (
    exists (select 1 from public.trips t
            where t.id = trip_locations.trip_id
              and (auth.uid() = t.owner_uid
                or auth.uid() = any(t.member_uids)
                or auth.uid() = any(t.viewer_uids)))
  );

-- Anonymous followers hold only the share link, so they read through this
-- token-gated function — never the table directly.
create or replace function public.shared_trip_locations(p_id text, p_token text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', l.user_id, 'lat', l.lat, 'lon', l.lon, 'updated_at', l.updated_at)), '[]'::jsonb)
  from   public.trip_locations l
  join   public.trips t on t.id = l.trip_id
  where  l.trip_id = p_id
    and  l.sharing is true and l.lat is not null
    and  p_token is not null and p_token <> '' and t.share_token = p_token;
$$;

revoke all on function public.shared_trip_locations(text, text) from public;
grant execute on function public.shared_trip_locations(text, text) to anon, authenticated;

-- VERIFY: anon should have NO privileges left on the table.
select coalesce((select string_agg(privilege_type, ', ')
                 from information_schema.role_table_grants
                 where table_schema='public' and table_name='trip_locations' and grantee='anon'),
                'none (correct)') as anon_privileges;
