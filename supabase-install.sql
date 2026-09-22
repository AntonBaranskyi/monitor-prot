-- =====================================================================
--  Trip Monitor — clean install.
--
--  Run ONCE, top to bottom, in a NEW Supabase project's SQL editor. Safe to
--  re-run: everything here is `if not exists`, `create or replace`, or a drop
--  followed by a create.
--
--  This replaces the supabase-*.sql files for a fresh project. Those were
--  written as migrations over a database that already existed, and they will
--  not run in order here — supabase-rls.sql begins by ALTERing public.profiles,
--  a table nothing in this repository ever creates. They are kept because their
--  comments explain why several policies are shaped the way they are; this file
--  is what you actually run.
--
--  What this installs is the END STATE, not the sequence. That distinction
--  matters most for push_subscriptions: one file grants anonymous callers
--  insert and delete, and a later one takes it all away again. Concatenating
--  them would leave a window — or, if the order slipped, a permanent hole.
--
--  BEFORE YOU START, in Storage, create two buckets by hand. Creating them from
--  here does not work: depending on how the project was provisioned the editor's
--  role does not own storage.buckets, and the statement fails in a way that
--  looks like the bucket already existing.
--
--      trip-media     PUBLIC   — documents, so a share link can render them
--      trip-stories   PRIVATE  — story photos, never anonymously readable
-- =====================================================================


-- =====================================================================
--  1. PROFILES — who someone is
--
--  Reconstructed rather than copied: no file in this repository creates this
--  table. The shape comes from how the app reads and writes it.
--
--  user_id is the PRIMARY KEY, and that is load-bearing. Both writers upsert
--  with `Prefer: resolution=merge-duplicates` and pass no on_conflict, so
--  PostgREST resolves the conflict against the primary key. Give this table a
--  surrogate id instead and every profile save inserts a new row rather than
--  updating the existing one.
-- =====================================================================
create table if not exists public.profiles (
  user_id  text  primary key,                       -- the app's own id, always lowercased
  name     text  not null default '',
  -- The private side: notes, to-dos, avatar. Never world-readable — the view
  -- below is what the rest of the world sees.
  profile  jsonb not null default '{}'::jsonb,
  -- The real, un-spoofable auth id. Nullable because a row can exist before it
  -- is linked, but every policy below keys on it, so an unlinked row is inert.
  auth_uid uuid  references auth.users(id) on delete cascade
);

create unique index if not exists profiles_auth_uid_key
  on public.profiles(auth_uid) where auth_uid is not null;

alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

-- Your full row, including the private side, is yours alone.
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth_uid = auth.uid());
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth_uid = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

-- The public directory: name and avatar, nothing else. Used to look someone up
-- by User ID and to put faces on a shared status link.
--
-- Deliberately NOT security_invoker. A view without it runs as its owner, so it
-- reads past the row policies above — which is the entire point: those policies
-- restrict the base table to its owner, and this exposes the two columns that
-- are meant to be public. Add security_invoker=true and anonymous callers get
-- an empty result and the share links quietly stop showing anybody.
create or replace view public.profiles_public as
  select user_id, name, auth_uid, profile->>'pic' as pic
  from   public.profiles;
grant select on public.profiles_public to anon, authenticated;


-- =====================================================================
--  2. TRIPS — one row per trip
-- =====================================================================
create table if not exists public.trips (
  id          text   primary key,
  owner_uid   uuid   not null,
  member_uids uuid[] not null default '{}',
  viewer_uids uuid[] not null default '{}',
  share_token text   not null default replace(gen_random_uuid()::text, '-', ''),
  data        jsonb  not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.trips enable row level security;
revoke all on public.trips from anon;
grant select, insert, update, delete on public.trips to authenticated;

drop policy if exists trips_select on public.trips;
drop policy if exists trips_insert on public.trips;
drop policy if exists trips_update on public.trips;
drop policy if exists trips_delete on public.trips;

-- READ: owner, members, and invited viewers.
create policy trips_select on public.trips
  for select to authenticated
  using (auth.uid() = owner_uid
      or auth.uid() = any(member_uids)
      or auth.uid() = any(viewer_uids));

-- CREATE: only ever as yourself.
create policy trips_insert on public.trips
  for insert to authenticated
  with check (auth.uid() = owner_uid);

-- WRITE: owner and members — a traveller must be able to tick their own status.
-- Viewers are absent on purpose: read-only, enforced here rather than in the UI.
create policy trips_update on public.trips
  for update to authenticated
  using      (auth.uid() = owner_uid or auth.uid() = any(member_uids))
  with check (auth.uid() = owner_uid or auth.uid() = any(member_uids));

-- DELETE: the creator only.
create policy trips_delete on public.trips
  for delete to authenticated
  using (auth.uid() = owner_uid);

-- Members may edit the itinerary; they may not edit the roster or hand the trip
-- to themselves. The update policy cannot express that — it decides whether a
-- row may be written, not which columns — so the trigger puts the identity
-- columns back to what they were.
create or replace function public.trips_guard()
returns trigger language plpgsql as $$
begin
  -- auth.uid() is null only for admin or server-side work (the SQL editor, the
  -- service key). Real requests without a login never reach here: every update
  -- policy is granted to `authenticated` alone.
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

-- The public share link: ?view=<id>&k=<share_token>. One trip, and only when
-- the secret matches. security definer because the caller is anonymous and has
-- no route to the table at all — the token is the whole of the authorisation.
create or replace function public.shared_trip(p_id text, p_token text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('trip', data, 'updated_at', updated_at)
  from   public.trips
  where  id = p_id and p_token is not null and p_token <> '' and share_token = p_token;
$$;

revoke all on function public.shared_trip(text, text) from public;
grant execute on function public.shared_trip(text, text) to anon, authenticated;


-- =====================================================================
--  3. PUSH SUBSCRIPTIONS — reachable only by the service key
--
--  Note what is NOT here: any policy at all. RLS is on and every privilege is
--  revoked, so neither anon nor a signed-in user can read, write or enumerate
--  this table. The subscribe() function reaches it with the service key, and
--  that is the only way in.
--
--  supabase-push.sql grants anon insert and delete; supabase-push-lockdown.sql
--  then drops those and revokes everything. Installing the first without the
--  second leaves a table anyone can write to and delete from — endpoints are
--  the addresses people's browsers are notified at.
-- =====================================================================
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  trip_id    text        not null,
  endpoint   text        not null unique,     -- one row per browser; upsert on this
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_trip_idx
  on public.push_subscriptions(trip_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- Clear any policy a previous run or an older script may have left.
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'push_subscriptions'
  loop execute format('drop policy %I on public.push_subscriptions', r.policyname);
  end loop;
end $$;


-- =====================================================================
--  4. LIVE LOCATION
-- =====================================================================
create table if not exists public.trip_locations (
  user_id    text not null,
  trip_id    text not null,
  -- Added by ALTER in the migration version, which then backfilled it from
  -- profiles and deleted the rows it could not fill. Neither step applies to an
  -- empty database, so it is simply a column here.
  auth_uid   uuid,
  lat        double precision,
  lon        double precision,
  sharing    boolean     not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, trip_id)
);

alter table public.trip_locations enable row level security;
revoke all on public.trip_locations from anon;
grant select, insert, update, delete on public.trip_locations to authenticated;

drop policy if exists loc_select on public.trip_locations;
drop policy if exists loc_insert on public.trip_locations;
drop policy if exists loc_update on public.trip_locations;
drop policy if exists loc_delete on public.trip_locations;

-- You write your own position and nobody else's. RLS keys on auth_uid, never on
-- user_id, because user_id arrives in the request body and can say anything.
create policy loc_insert on public.trip_locations
  for insert to authenticated with check (auth_uid = auth.uid());
create policy loc_update on public.trip_locations
  for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());
create policy loc_delete on public.trip_locations
  for delete to authenticated using (auth_uid = auth.uid());

-- Anyone on the trip can see where everyone is.
create policy loc_select on public.trip_locations
  for select to authenticated using (
    exists (select 1 from public.trips t
            where t.id = trip_locations.trip_id
              and (auth.uid() = t.owner_uid
                or auth.uid() = any(t.member_uids)
                or auth.uid() = any(t.viewer_uids)))
  );

-- The share link's view of the map: only travellers who are actively sharing,
-- and only with the trip's token.
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


-- =====================================================================
--  5. TRIP STORIES
--
--  A traveller's first photo starts a one-hour session. Up to three go in it,
--  and later ones do not extend it. At the hour the whole session disappears.
--
--  Expiry is enforced by the read policy itself (expires_at > now()), not by the
--  app remembering to filter — so an expired story is unreadable even to someone
--  calling the REST API directly with a good token.
-- =====================================================================
create or replace function public.is_trip_captain(p_trip text, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from   public.trips t
    where  t.id = p_trip
      and (t.owner_uid = p_uid
           or exists (
                select 1
                from   jsonb_array_elements(coalesce(t.data->'members', '[]'::jsonb)) m
                join   public.profiles p on p.user_id = m->>'userId'
                where  p.auth_uid = p_uid
                  and  m->>'role' = 'captain'
              ))
  );
$$;

create table if not exists public.trip_stories (
  id             uuid        primary key default gen_random_uuid(),
  trip_id        text        not null references public.trips(id) on delete cascade,
  author_uid     uuid        not null references auth.users(id)   on delete cascade,

  -- Everything posted within one hour shares a session_id, and every row in it
  -- carries the SAME expires_at, copied from the first. That is what makes
  -- "adding to a story does not extend it" true in the data rather than in code.
  session_id     uuid        not null,
  session_start  timestamptz not null default now(),
  expires_at     timestamptz not null,

  -- Three to a session. Unique together, so the cap survives a double-tap, a
  -- retry, and a bug in the app.
  slot           smallint    not null check (slot between 1 and 3),

  kind           text        not null check (kind in ('photo','video')),
  storage_path   text        not null unique,
  caption        text        not null default '',
  duration_ms    integer     not null default 10000
                             check (duration_ms > 0 and duration_ms <= 10000),
  created_at     timestamptz not null default now(),

  unique (session_id, slot)
);

-- Asked on every trip open: who has something live right now?
create index if not exists trip_stories_live_idx
  on public.trip_stories (trip_id, expires_at desc);
-- And when posting: do I have a session running, and how full is it?
create index if not exists trip_stories_author_idx
  on public.trip_stories (trip_id, author_uid, expires_at desc);

alter table public.trip_stories enable row level security;
revoke all on public.trip_stories from anon;
grant select, insert, delete on public.trip_stories to authenticated;

drop policy if exists "stories readable by the trip while live" on public.trip_stories;
drop policy if exists "members post their own stories"          on public.trip_stories;
drop policy if exists "author or captain removes a story"       on public.trip_stories;

-- Watch: anyone on the trip, viewers included — but only while it is live.
-- There is deliberately no share-token route: a ?view= link reaches this table
-- by no path whatsoever.
create policy "stories readable by the trip while live"
on public.trip_stories for select to authenticated
using (
  expires_at > now()
  and exists (
    select 1 from public.trips t
    where  t.id = trip_stories.trip_id
      and (t.owner_uid = auth.uid()
           or auth.uid() = any(t.member_uids)
           or auth.uid() = any(t.viewer_uids))
  )
);

-- Post: your own, and only as a member. Viewers watch, they do not contribute.
create policy "members post their own stories"
on public.trip_stories for insert to authenticated
with check (
  author_uid = auth.uid()
  and exists (
    select 1 from public.trips t
    where  t.id = trip_stories.trip_id
      and (t.owner_uid = auth.uid() or auth.uid() = any(t.member_uids))
  )
);

-- Remove: the author, or a captain moderating. No expiry check — a captain
-- taking something down must not be blocked by it having just expired.
create policy "author or captain removes a story"
on public.trip_stories for delete to authenticated
using (
  author_uid = auth.uid()
  or public.is_trip_captain(trip_id, auth.uid())
);

-- No update policy anywhere: a story is posted or removed, never edited.


-- =====================================================================
--  6. STORAGE POLICIES — trip-stories
--
--  Path convention: <trip_id>/<session_id>/<slot>.<ext>
--
--  These three helpers are security definer for a reason that cost a long
--  afternoon to find. A storage policy that asks "does a trips row exist where I
--  am owner or member" is evaluated as `authenticated`, and public.trips has row
--  level security of its own — so the subquery is filtered by the trips SELECT
--  policy before the storage policy ever sees a row. The helpers answer the same
--  question with that out of the way. They widen nothing: each takes the
--  caller's uid as an argument and answers yes or no about one path, so they
--  cannot be used to read a trip.
-- =====================================================================
create or replace function public.story_is_live(p_path text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.trip_stories s
    where  s.storage_path = p_path and s.expires_at > now()
  );
$$;

create or replace function public.story_path_is_mine(p_path text, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.trips t
    where  t.id = any(storage.foldername(p_path))
      and (t.owner_uid = p_uid or p_uid = any(t.member_uids))
  );
$$;

-- Watching is open to invited viewers as well; posting is not.
create or replace function public.story_path_is_visible(p_path text, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.trips t
    where  t.id = any(storage.foldername(p_path))
      and (t.owner_uid = p_uid
           or p_uid = any(t.member_uids)
           or p_uid = any(t.viewer_uids))
  );
$$;

grant execute on function public.story_is_live(text)               to authenticated;
grant execute on function public.story_path_is_mine(text, uuid)    to authenticated;
grant execute on function public.story_path_is_visible(text, uuid) to authenticated;

drop policy if exists "trip can read its live stories"       on storage.objects;
drop policy if exists "members upload their stories"         on storage.objects;
drop policy if exists "members replace their own story file" on storage.objects;
drop policy if exists "author or captain deletes story"      on storage.objects;

create policy "trip can read its live stories"
on storage.objects for select to authenticated
using (
  bucket_id = 'trip-stories'
  and public.story_is_live(name)
  and public.story_path_is_visible(name, auth.uid())
);

create policy "members upload their stories"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'trip-stories'
  and public.story_path_is_mine(name, auth.uid())
);

create policy "author or captain deletes story"
on storage.objects for delete to authenticated
using (
  bucket_id = 'trip-stories'
  and (
    exists (select 1 from public.trip_stories s
            where  s.storage_path = name and s.author_uid = auth.uid())
    or public.is_trip_captain((storage.foldername(name))[1], auth.uid())
  )
);

-- There is deliberately NO update policy on this bucket.
--
-- The migration version has one, added when uploads were failing and the app
-- was sending x-upsert. That turned out to be the bug rather than the fix: with
-- x-upsert the storage service must first decide whether the object already
-- exists, and deciding that evaluates the SELECT policy above — which requires a
-- live trip_stories row for the path. On a first post no such row exists and
-- none can, because the row is written after the upload succeeds. The check was
-- false by construction and the refusal arrived as an RLS violation on an insert
-- policy that was correct all along.
--
-- The app no longer sends x-upsert. A slot is written once; a retry into an
-- occupied slot should fail loudly rather than overwrite. So nothing needs
-- update, and granting it would only make the overwrite possible again.
--
-- (trip-media upserts happily because its SELECT policy is a bare bucket test
-- with nothing in it that can fail. The two are not comparable.)


-- =====================================================================
--  7. STORAGE POLICIES — trip-media
--
--  DIFFERENT FROM THE ORIGINAL, deliberately.
--
--  My Travel Hub's four policies are bare bucket tests with no ownership check
--  at all: any signed-in account may write anywhere in the bucket and delete
--  anything in it, including another trip's documents. That is not carelessness
--  in how they were written — it is the only thing expressible over paths like
--  "docs/<uuid>-<ts>.pdf", which say nothing about who the file belongs to.
--
--  Trip Monitor's uploads carry that in the path instead:
--
--      <trip_id>/docs/<uuid>-<ts>.<ext>       a trip's documents
--      profile/<auth_uid>/<uuid>-<ts>.<ext>   somebody's avatar
--
--  so the policy can ask the question. Changed here and not there because this
--  bucket is empty: in the original the same change means relocating every file
--  already uploaded and rewriting the URLs held in every trip's data.
--
--  What has NOT changed is anonymous read. It stays bucket-wide, because that
--  is what lets a ?view= share link render a document, and tightening it would
--  buy nothing anyway — these are public URLs, so anyone holding one can already
--  read it. The exposure worth closing was write and delete, not read.
-- =====================================================================
create or replace function public.media_path_is_mine(p_path text, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    -- <trip_id>/docs/... — a trip you are on. Viewers are absent on purpose:
    -- they read, they do not contribute, the same rule as everywhere else.
    exists (
      select 1 from public.trips t
      where  t.id = (storage.foldername(p_path))[1]
        and (t.owner_uid = p_uid or p_uid = any(t.member_uids))
    )
    -- profile/<auth_uid>/... — your own avatar, which belongs to no trip.
    or ((storage.foldername(p_path))[1] = 'profile'
        and (storage.foldername(p_path))[2] = p_uid::text);
$$;

grant execute on function public.media_path_is_mine(text, uuid) to authenticated;

drop policy if exists "trip-media anon read"    on storage.objects;
drop policy if exists "trip_media_select_auth"  on storage.objects;
drop policy if exists "trip_media_insert_auth"  on storage.objects;
drop policy if exists "trip_media_delete"       on storage.objects;

-- Read stays open: it is what makes documents render on a share link.
create policy "trip-media anon read"
on storage.objects for select to anon
using (bucket_id = 'trip-media');

create policy "trip_media_select_auth"
on storage.objects for select to authenticated
using (bucket_id = 'trip-media');

-- Write and delete are yours only.
create policy "trip_media_insert_auth"
on storage.objects for insert to authenticated
with check (bucket_id = 'trip-media' and public.media_path_is_mine(name, auth.uid()));

create policy "trip_media_delete"
on storage.objects for delete to authenticated
using (bucket_id = 'trip-media' and public.media_path_is_mine(name, auth.uid()));

-- No UPDATE policy, matching the original.
--
-- uploadToStorage() does send x-upsert, and unlike trip-stories that is safe
-- here: the existence probe it triggers evaluates the SELECT policies above,
-- which are bare bucket tests that always pass. The trip-stories trap needed a
-- read policy carrying a precondition that was false for a new object; there is
-- no such precondition here. And since every path holds a uuid and a timestamp,
-- a real collision does not arise and the upsert never replaces anything.


-- =====================================================================
--  8. WHAT ACTUALLY GOT CREATED
--
--  Reports rather than asserts. Read the three results: five tables, one view,
--  and the policy counts below.
-- =====================================================================
select 'tables' as checking, table_name, 'present' as status
from   information_schema.tables
where  table_schema = 'public'
  and  table_name in ('profiles','trips','push_subscriptions','trip_locations','trip_stories')
order  by table_name;

select 'row policies' as checking, tablename, count(*) as policies
from   pg_policies
where  schemaname = 'public'
group  by tablename
order  by tablename;
-- Expect: profiles 3, trips 4, trip_locations 4, trip_stories 3,
--         and push_subscriptions ABSENT from this list entirely — no policies
--         is the correct state for it, not an oversight.

select 'storage policies' as checking, policyname, cmd
from   pg_policies
where  schemaname = 'storage' and tablename = 'objects'
order  by policyname;
-- Expect seven: three for trip-stories (select, insert, delete) and four for
-- trip-media (anon select, auth select, insert, delete).
--
-- The original project has eight — it still carries "members replace their own
-- story file", an UPDATE policy added while the upload failures were being
-- chased, before x-upsert turned out to be the cause rather than something to
-- accommodate. The app no longer sends x-upsert for stories, so nothing uses it.
-- It is not installed here.
