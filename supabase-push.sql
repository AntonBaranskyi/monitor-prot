-- =====================================================================
--  My Travel Hub — follower push-notification subscriptions
--  Run ONCE in Supabase -> SQL Editor. Safe to re-run.
--
--  A follower who opens a trip's shared status link and taps
--  "Notify me" stores their browser push subscription here, keyed to
--  the trip. The notify() Netlify function reads this table with the
--  SERVICE key (past RLS) to fan a status update out to every follower.
-- =====================================================================

create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  trip_id    text        not null,
  endpoint   text        not null unique,   -- one row per browser; upsert on this
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_trip_idx
  on public.push_subscriptions(trip_id);

alter table public.push_subscriptions enable row level security;

-- Reset any prior policies (names unknown -> loop).
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'push_subscriptions'
  loop execute format('drop policy %I on public.push_subscriptions', r.policyname);
  end loop;
end $$;

-- A follower is anonymous (they only have the share link), so anon may
-- SUBSCRIBE (insert) and UNSUBSCRIBE (delete their row by endpoint).
-- There is deliberately NO select policy: endpoints are never readable
-- by clients — only the service-key function reads them to send.
create policy push_insert on public.push_subscriptions
  for insert to anon, authenticated with check (true);

create policy push_delete on public.push_subscriptions
  for delete to anon, authenticated using (true);

-- VERIFY: should list exactly the two policies above.
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'push_subscriptions'
order by policyname;
