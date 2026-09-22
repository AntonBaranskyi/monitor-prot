-- =====================================================================
--  Trip Stories — fix the upload refusal.
--
--  Uploads were refused with "new row violates row-level security policy".
--  The bucket exists and is private; the three policies are installed. What
--  fails is the insert policy's own test.
--
--  It read the trip id as split_part(name, '/', 1) — the first path segment.
--  That assumed storage.objects.name holds the path WITHOUT the bucket. If
--  it holds "trip-stories/<trip>/<session>/1.jpg" instead, that expression
--  returns "trip-stories", no trip matches, and every upload is refused —
--  which is exactly the symptom.
--
--  Rather than guess which shape it is, the policies below look for the trip
--  id among ALL the folder tokens. Correct either way. Trip ids are seven
--  random characters and session ids are uuids, so nothing else in the path
--  can be mistaken for one, and the caller must still be on that trip.
--
--  Run this whole file. Then post a photo, and run the query at the bottom
--  so we can see the real shape and tighten this back to one exact segment.
-- =====================================================================

drop policy if exists "trip can read its live stories"  on storage.objects;
drop policy if exists "members upload their stories"    on storage.objects;
drop policy if exists "author or captain deletes story" on storage.objects;

-- Read: on the trip, and the story still live.
create policy "trip can read its live stories"
on storage.objects for select to authenticated
using (
  bucket_id = 'trip-stories'
  and public.story_is_live(name)
  and exists (
    select 1 from public.trips t
    where  t.id = any(storage.foldername(name))
      and (t.owner_uid = auth.uid()
           or auth.uid() = any(t.member_uids)
           or auth.uid() = any(t.viewer_uids))
  )
);

-- Post: members of that trip. Viewers watch, they do not contribute.
create policy "members upload their stories"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'trip-stories'
  and exists (
    select 1 from public.trips t
    where  t.id = any(storage.foldername(name))
      and (t.owner_uid = auth.uid() or auth.uid() = any(t.member_uids))
  )
);

-- Delete: whoever owns the row pointing at this file, or a captain.
-- Membership alone is not enough, or one traveller could delete another's.
create policy "author or captain deletes story"
on storage.objects for delete to authenticated
using (
  bucket_id = 'trip-stories'
  and (
    exists (select 1 from public.trip_stories s
            where  s.storage_path = name and s.author_uid = auth.uid())
    or exists (select 1 from public.trips t
               where  t.id = any(storage.foldername(name))
                 and  public.is_trip_captain(t.id, auth.uid()))
  )
);

-- =====================================================================
--  AFTER a photo posts, run this and send me the output. It settles what
--  name actually holds, and whether the folder tokens are what I expect:
--
--    select name,
--           storage.foldername(name) as folders,
--           split_part(name, '/', 1) as first_segment
--    from   storage.objects
--    where  bucket_id = 'trip-stories';
--
--  If first_segment already equals the trip id, the original policy was
--  right and something else was wrong — worth knowing either way.
-- =====================================================================
