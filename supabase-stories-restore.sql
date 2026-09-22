-- =====================================================================
--  Trip Stories — put the write policy back. Run this once.
--
--  The bisect loosened the insert check to a bare bucket test so we could
--  tell two causes apart. That answered the question and must not stay:
--  as written it lets ANY signed-in account, on any trip or none, write
--  files into the stories bucket.
--
--  Safe to run whether or not the bisect was applied — it simply asserts
--  the policy we want.
--
--  ---------------------------------------------------------------------
--  What the bug actually was, so it is not reintroduced:
--
--  The upload sent `x-upsert: true`. That makes the storage service first
--  decide whether the object already exists, and deciding that evaluates
--  the SELECT policy — which requires story_is_live(name), a live row in
--  trip_stories for that path. On a first post no such row exists, and
--  none can: the row is written only AFTER the upload succeeds. So the
--  check was false by construction and the refusal surfaced as an RLS
--  violation on an insert policy that was itself correct.
--
--  trip-media upserts happily because its SELECT policy is a bare bucket
--  test — nothing in it can fail. A read policy with a precondition and
--  one without behave completely differently under upsert.
--
--  Rule: do not send x-upsert to this bucket. A slot is written once; a
--  retry into an occupied slot should fail loudly rather than overwrite.
-- =====================================================================

drop policy if exists "members upload their stories" on storage.objects;

create policy "members upload their stories"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'trip-stories'
  and public.story_path_is_mine(name, auth.uid())
);

-- Confirm — expect one row, cmd = INSERT, and story_path_is_mine in the check.
select policyname, cmd, with_check
from   pg_policies
where  schemaname = 'storage'
  and  tablename  = 'objects'
  and  policyname = 'members upload their stories';

-- And the observation never actually taken: what the stored paths look like.
select name, owner, path_tokens, created_at
from   storage.objects
where  bucket_id = 'trip-stories'
order  by created_at;
