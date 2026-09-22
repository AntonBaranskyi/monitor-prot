-- =====================================================================
--  My Travel Hub — Trip Stories (step 1 of 5: the backend)
--  Run ONCE in Supabase → SQL Editor. Safe to re-run.
--
--  A traveller's first item starts a one-hour session. Up to three items
--  go in it; later ones do not extend the hour. At one hour the whole
--  session disappears. A further upload starts a fresh hour.
--
--  Who sees what:
--    owner / member / invited viewer  → can watch, while it is live
--    owner / member                   → can post
--    author, or a trip captain        → can delete
--    a ?view= share link              → nothing at all, deliberately
--
--  Two things are enforced here rather than in the app:
--    1. Expiry. The read policy itself requires expires_at > now(), so an
--       expired story is unreadable even to someone calling the REST API
--       directly with a good token. "Disappears immediately" is true
--       rather than a matter of the app remembering to filter.
--    2. The three-item cap, as a column constraint, so it holds even if
--       the app has a bug.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Is this person a captain of this trip?
--    The creator always is. Others are captains if the trip's own roster
--    says so — which is keyed by the app's user id, not the auth uid, so
--    it has to go through profiles. security definer because the policies
--    that call it must see rows the caller cannot.
-- ---------------------------------------------------------------------
create or replace function public.is_trip_captain(p_trip text, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
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

-- ---------------------------------------------------------------------
-- 2. The stories themselves.
--    One row per item. The session is carried on the row rather than in a
--    table of its own: with a three-item cap a join earns nothing, and it
--    makes expiry a single column, which is what the policy keys on.
-- ---------------------------------------------------------------------
create table if not exists public.trip_stories (
  id             uuid        primary key default gen_random_uuid(),
  trip_id        text        not null references public.trips(id) on delete cascade,
  author_uid     uuid        not null references auth.users(id)   on delete cascade,

  -- All items a traveller posts within one hour share a session_id, and
  -- every one of them carries the same expires_at: the hour runs from the
  -- FIRST item and later ones do not extend it.
  session_id     uuid        not null,
  session_start  timestamptz not null default now(),
  expires_at     timestamptz not null,

  -- Three per session, in order. Unique together, so the cap survives a
  -- double-tap or a retry as well as a bug.
  slot           smallint    not null check (slot between 1 and 3),

  kind           text        not null check (kind in ('photo','video')),
  storage_path   text        not null unique,
  caption        text        not null default '',
  -- Ten seconds each, thirty for the session. Enforced, not assumed.
  duration_ms    integer     not null default 10000
                             check (duration_ms > 0 and duration_ms <= 10000),
  created_at     timestamptz not null default now(),

  unique (session_id, slot)
);

-- The question asked on every trip open: who has something live right now?
create index if not exists trip_stories_live_idx
  on public.trip_stories (trip_id, expires_at desc);
-- And, when posting: do I already have a session running, and how full is it?
create index if not exists trip_stories_author_idx
  on public.trip_stories (trip_id, author_uid, expires_at desc);

-- ---------------------------------------------------------------------
-- 3. Is the story at this path still live?
--    Used by the storage policy below. security definer so it can see the
--    row regardless of who is asking — the caller's own access is decided
--    separately, by trip membership.
-- ---------------------------------------------------------------------
create or replace function public.story_is_live(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trip_stories s
    where  s.storage_path = p_path and s.expires_at > now()
  );
$$;

-- ---------------------------------------------------------------------
-- 4. Row policies
-- ---------------------------------------------------------------------
alter table public.trip_stories enable row level security;
revoke all on public.trip_stories from anon;
grant select, insert, delete on public.trip_stories to authenticated;

drop policy if exists "stories readable by the trip while live" on public.trip_stories;
drop policy if exists "members post their own stories"          on public.trip_stories;
drop policy if exists "author or captain removes a story"       on public.trip_stories;

-- Watch: anyone on the trip, including an invited viewer — but only while
-- it is live. There is deliberately no share-token route: a ?view= link
-- reaches this table by no path whatsoever.
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

-- Post: your own, and only if you are a member. Viewers watch, they do not
-- contribute — the same rule the Viewer role follows everywhere else.
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

-- No update policy at all: a story is posted or removed, never edited.

-- ---------------------------------------------------------------------
-- 5. The media. A private bucket of its own.
--    NOT trip-media: that one keeps an anon read policy so shared links
--    can render documents, which is exactly the audience stories exclude.
--    Nothing anonymous is granted here, ever.
--    Path convention: <trip_id>/<session_id>/<slot>.<ext>
-- ---------------------------------------------------------------------
-- NOTE: creating the bucket from here did NOT work — the editor role may not own
-- storage.buckets depending on how the project was provisioned, and the statement is
-- skipped without stopping the script. Create it in the dashboard instead (Storage →
-- New bucket, name trip-stories, Public OFF) and then run supabase-stories-storage.sql,
-- which checks it exists and is private before adding the policies below.
-- insert into storage.buckets (id, name, public)
-- values ('trip-stories', 'trip-stories', false)
-- on conflict (id) do nothing;

drop policy if exists "trip can read its live stories"  on storage.objects;
drop policy if exists "members upload their stories"    on storage.objects;
drop policy if exists "author or captain deletes story" on storage.objects;

-- Read: on the trip, and the story still live. The liveness check matters —
-- without it a path noted earlier would keep working until the cleanup job
-- next ran, up to fifteen minutes after the story was supposed to be gone.
create policy "trip can read its live stories"
on storage.objects for select to authenticated
using (
  bucket_id = 'trip-stories'
  and public.story_is_live(name)
  and exists (
    select 1 from public.trips t
    where  t.id = split_part(name, '/', 1)
      and (t.owner_uid = auth.uid()
           or auth.uid() = any(t.member_uids)
           or auth.uid() = any(t.viewer_uids))
  )
);

create policy "members upload their stories"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'trip-stories'
  and exists (
    select 1 from public.trips t
    where  t.id = split_part(name, '/', 1)
      and (t.owner_uid = auth.uid() or auth.uid() = any(t.member_uids))
  )
);

-- Delete: whoever owns the row that points at this file, or a captain.
-- Membership alone is not enough, or one traveller could delete another's.
create policy "author or captain deletes story"
on storage.objects for delete to authenticated
using (
  bucket_id = 'trip-stories'
  and (
    exists (select 1 from public.trip_stories s
            where  s.storage_path = name and s.author_uid = auth.uid())
    or public.is_trip_captain(split_part(name, '/', 1), auth.uid())
  )
);

-- =====================================================================
--  VERIFY after running:
--    select count(*) from public.trip_stories;                 -- 0
--    select public.is_trip_captain('<a trip id>', auth.uid()); -- true for you
--    select id, public from storage.buckets where id='trip-stories';
--                                                              -- public = false
--  The isolation itself is checked from outside, not from here.
-- =====================================================================
