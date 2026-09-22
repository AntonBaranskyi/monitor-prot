-- =====================================================================
--  Trip Stories — why uploads were refused, and the fix.
--
--  The insert policy asked "does a trips row exist with this id where I am
--  owner or member". Evaluated in the SQL editor that is true. Evaluated
--  inside the policy it is not, because there the query runs as
--  `authenticated` and `public.trips` has row level security of its own —
--  so the subquery is filtered by the trips SELECT policy before the
--  storage policy ever sees a row.
--
--  is_trip_captain() and story_is_live() were already written as security
--  definer for exactly this reason. The insert and select policies were
--  not, and that inconsistency is the bug.
--
--  PART A tests it. PART B fixes it. Run A first if you want to see the
--  difference; B is safe to run on its own.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PART A — optional. The same condition, evaluated as the user rather
-- than as the editor's own role. Nothing is changed; it rolls back.
-- ---------------------------------------------------------------------
begin;
  select set_config('role', 'authenticated', true);
  select set_config('request.jwt.claims',
    '{"sub":"0611deea-3c2d-49db-968d-344c9eca88c4","role":"authenticated"}', true);

  select auth.uid()                                as uid_seen,
         (select count(*) from public.trips)       as trips_i_can_see,
         exists (
           select 1 from public.trips t
           where  t.id = any(storage.foldername('bu2er44/aaaa-bbbb/1.jpeg'))
             and (t.owner_uid = auth.uid() or auth.uid() = any(t.member_uids))
         )                                         as inline_subquery_passes;
rollback;

-- ---------------------------------------------------------------------
-- PART B — the fix.
--
-- Two helpers that answer the membership question with the trips table's
-- RLS out of the way. They take the caller's uid as an argument and decide
-- only about that person, so they widen nothing: they cannot be used to
-- read a trip, only to answer yes or no about one path.
-- ---------------------------------------------------------------------
create or replace function public.story_path_is_mine(p_path text, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where  t.id = any(storage.foldername(p_path))
      and (t.owner_uid = p_uid or p_uid = any(t.member_uids))
  );
$$;

-- Watching is open to invited viewers as well; posting is not.
create or replace function public.story_path_is_visible(p_path text, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where  t.id = any(storage.foldername(p_path))
      and (t.owner_uid = p_uid
           or p_uid = any(t.member_uids)
           or p_uid = any(t.viewer_uids))
  );
$$;

grant execute on function public.story_path_is_mine(text, uuid)    to authenticated;
grant execute on function public.story_path_is_visible(text, uuid) to authenticated;

drop policy if exists "trip can read its live stories"  on storage.objects;
drop policy if exists "members upload their stories"    on storage.objects;
drop policy if exists "author or captain deletes story" on storage.objects;

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

-- The app sends x-upsert, so a re-post to the same slot needs UPDATE as well
-- as INSERT. Without it that path fails the same opaque way.
drop policy if exists "members replace their own story file" on storage.objects;
create policy "members replace their own story file"
on storage.objects for update to authenticated
using      (bucket_id = 'trip-stories' and public.story_path_is_mine(name, auth.uid()))
with check (bucket_id = 'trip-stories' and public.story_path_is_mine(name, auth.uid()));

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

-- =====================================================================
--  WHAT PART A SETTLES, and what is still open.
--
--  If inline_subquery_passes is FALSE, the diagnosis above is right: the
--  trips subquery is being filtered by that table's own RLS, and the
--  security definer helpers in PART B are the fix.
--
--  If it is TRUE, the diagnosis is wrong and PART B will not help either.
--  In that case the refusal is not about this expression at all, and the
--  next thing to look at is whether the request reaches Postgres as
--  `authenticated` — say so and I will go after the request itself rather
--  than the policy.
--
--  The row policies on public.trip_stories carry the same inline-subquery
--  shape. Whether they work has NOT been established, because the upload
--  fails first and the insert is never reached. If PART A comes back false
--  they will need the same treatment, and posting will still fail after
--  PART B — at the row rather than the file. That would be progress, not a
--  new problem, and the error message will say which.
-- =====================================================================
