-- =====================================================================
--  My Travel Hub — per-trip backend isolation (Row Level Security)
--  Run ONCE in Supabase -> SQL Editor. Safe to re-run (idempotent).
--
--  Why: today every trip lives in ONE anon-readable/writable row
--  (travel_data id='shared'), so the public anon key that ships inside
--  the app's JavaScript can read AND overwrite everybody's trips. The
--  Captain/Traveler/Viewer roles are enforced only in the UI. This makes
--  them real, enforced by Postgres.
--
--  1. profiles  -> gains auth_uid (the real, un-spoofable auth id),
--                  backfilled; writes locked to your own row; a public
--                  view exposes ONLY user_id/name/avatar so your private
--                  notes + to-dos stop being world-readable.
--  2. trips     -> a real per-trip table. You can read a trip only if you
--                  are its owner, a member, or an invited viewer.
--  3. guard     -> a trigger stops members from stealing ownership or
--                  rewriting the roster.
--  4. shared_trip() -> the public ?view= link, unlocked by a per-trip
--                  secret token instead of exposing every trip.
--  5. migrate   -> copies your existing trips into the new table.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PROFILES: real identity + privacy
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists auth_uid uuid;

-- Backfill auth_uid from the auth system (user_id was stamped at signup).
update public.profiles p
set    auth_uid = u.id
from   auth.users u
where  u.raw_user_meta_data->>'user_id' = p.user_id
  and  p.auth_uid is distinct from u.id;

create unique index if not exists profiles_auth_uid_key
  on public.profiles(auth_uid) where auth_uid is not null;

alter table public.profiles enable row level security;

-- Drop whatever anon-era policies exist (names unknown -> loop).
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'profiles'
  loop execute format('drop policy %I on public.profiles', r.policyname);
  end loop;
end $$;

-- Your full profile row (incl. notes/to-dos) is yours alone.
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth_uid = auth.uid());
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth_uid = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

-- Public directory: name + avatar only. Used to look travelers up by
-- User ID and to show photos on a shared status link. No notes/to-dos.
create or replace view public.profiles_public as
  select user_id, name, auth_uid, profile->>'pic' as pic
  from   public.profiles;
grant select on public.profiles_public to anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. TRIPS: one row per trip, protected by RLS
-- ---------------------------------------------------------------------
create table if not exists public.trips (
  id          text primary key,
  owner_uid   uuid   not null,
  member_uids uuid[] not null default '{}',
  viewer_uids uuid[] not null default '{}',
  share_token text   not null default replace(gen_random_uuid()::text, '-', ''),
  data        jsonb  not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.trips enable row level security;

do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'trips'
  loop execute format('drop policy %I on public.trips', r.policyname);
  end loop;
end $$;

-- READ: owner, members and invited viewers.
create policy trips_select on public.trips
  for select to authenticated
  using (auth.uid() = owner_uid
      or auth.uid() = any(member_uids)
      or auth.uid() = any(viewer_uids));

-- CREATE: only ever as yourself.
create policy trips_insert on public.trips
  for insert to authenticated
  with check (auth.uid() = owner_uid);

-- WRITE: owner and members (a traveler must be able to tick their own
-- status). Viewers are deliberately absent -> read-only, enforced here.
create policy trips_update on public.trips
  for update to authenticated
  using      (auth.uid() = owner_uid or auth.uid() = any(member_uids))
  with check (auth.uid() = owner_uid or auth.uid() = any(member_uids));

-- DELETE: creator only.
create policy trips_delete on public.trips
  for delete to authenticated
  using (auth.uid() = owner_uid);


-- ---------------------------------------------------------------------
-- 3. GUARD: members may edit the itinerary, never the roster/ownership
-- ---------------------------------------------------------------------
create or replace function public.trips_guard()
returns trigger language plpgsql as $$
begin
  -- auth.uid() is null only for admin/server-side work (the SQL editor, the
  -- service key). Real requests without a login never get here: the update
  -- policies are granted to `authenticated` only.
  if auth.uid() is not null and auth.uid() is distinct from old.owner_uid then
    new.id          := old.id;
    new.owner_uid   := old.owner_uid;
    new.member_uids := old.member_uids;
    new.viewer_uids := old.viewer_uids;
    new.share_token := old.share_token;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trips_guard_trg on public.trips;
create trigger trips_guard_trg before update on public.trips
  for each row execute function public.trips_guard();


-- ---------------------------------------------------------------------
-- 4. PUBLIC SHARE LINK: ?view=<id>&k=<share_token>
--    Returns one trip, and only when the secret token matches.
-- ---------------------------------------------------------------------
create or replace function public.shared_trip(p_id text, p_token text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('trip', data, 'updated_at', updated_at)
  from   public.trips
  where  id = p_id and p_token is not null and p_token <> '' and share_token = p_token;
$$;

revoke all on function public.shared_trip(text, text) from public;
grant execute on function public.shared_trip(text, text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. MIGRATE existing trips out of the shared blob
--    (the blob is left untouched as a backup)
-- ---------------------------------------------------------------------
insert into public.trips (id, owner_uid, member_uids, viewer_uids, data)
select t->>'id',
       own.auth_uid,
       coalesce((select array_agg(distinct p.auth_uid)
                 from   jsonb_array_elements(coalesce(t->'members', '[]'::jsonb)) m
                 join   public.profiles p on p.user_id = m->>'userId'
                 where  p.auth_uid is not null), '{}'::uuid[]),
       coalesce((select array_agg(distinct p.auth_uid)
                 from   jsonb_array_elements(coalesce(t->'viewers', '[]'::jsonb)) v
                 join   public.profiles p on p.user_id = v->>'userId'
                 where  p.auth_uid is not null), '{}'::uuid[]),
       t
from   public.travel_data d
cross  join lateral jsonb_array_elements(d.trips::jsonb) t
join   public.profiles own on own.user_id = t->>'ownerId'
where  d.id = 'shared'
  and  own.auth_uid is not null
  and  t->>'id' is not null
on conflict (id) do nothing;

-- Make sure the owner is always in their own member list.
update public.trips
set    member_uids = array_append(member_uids, owner_uid)
where  not (owner_uid = any(member_uids));

-- VERIFY: trips_migrated and trips_in_old_blob must MATCH (expect 4 and 4).
-- If migrated is lower, a trip's ownerId has no matching profile row — tell
-- Claude before running Part 2.
select (select count(*) from public.trips) as trips_migrated,
       (select jsonb_array_length(d.trips::jsonb)
        from   public.travel_data d where d.id = 'shared') as trips_in_old_blob;


-- =====================================================================
--  PART 2 — run this ONLY after the app shows all your trips again.
--  It closes the old hole by removing anonymous access to the shared
--  blob. The data stays as a backup; nothing reads it after migration.
-- =====================================================================
-- alter table public.travel_data enable row level security;
-- do $$
-- declare r record;
-- begin
--   for r in select policyname from pg_policies
--            where schemaname = 'public' and tablename = 'travel_data'
--   loop execute format('drop policy %I on public.travel_data', r.policyname);
--   end loop;
-- end $$;
-- revoke all on public.travel_data from anon;
