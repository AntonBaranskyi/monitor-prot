-- =====================================================================
--  My Travel Hub — lock down push_subscriptions (run AFTER the new
--  subscribe() function + client are deployed).
--
--  Subscribe/unsubscribe now go through the subscribe() Netlify function,
--  which uses the SERVICE key (bypasses RLS). So the anonymous role no
--  longer needs — and should not have — any access to this table. This
--  makes follower endpoints fully private: nothing but the service-key
--  functions (subscribe + notify) can read or write them.
-- =====================================================================

-- Remove every anon/authenticated policy...
drop policy if exists push_select on public.push_subscriptions;
drop policy if exists push_insert on public.push_subscriptions;
drop policy if exists push_update on public.push_subscriptions;
drop policy if exists push_delete on public.push_subscriptions;

-- ...and every table privilege. RLS stays ON; with no policies and no
-- grants, anon + authenticated have zero access. service_role bypasses RLS.
revoke all on public.push_subscriptions from anon, authenticated;

-- VERIFY (both should come back EMPTY):
select policyname from pg_policies
where schemaname='public' and tablename='push_subscriptions';

select grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name='push_subscriptions'
  and grantee in ('anon','authenticated');
