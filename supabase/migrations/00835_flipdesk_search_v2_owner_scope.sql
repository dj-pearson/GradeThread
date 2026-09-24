-- INV-D1 (search): flipdesk_search_v2 searches ONE workspace.
--
-- flipdesk_search (00248) is SECURITY INVOKER, and the SELECT policies on
-- inventory_items, listings and sales admit the caller's own rows OR any
-- workspace they are a member of. It had no owner predicate, so for a seller in
-- several workspaces it ranked across all of them, stopped at the limit, and
-- only then did the web client drop the rows from other workspaces. A member of
-- a big workspace searching a small one got a short or empty list: the big
-- workspace's rows had filled the page before the filter ran.
--
-- v2 takes the same arguments plus p_owner_id, the workspace on screen, and
-- filters every branch by user_id = owner BEFORE ranking and limiting. The id
-- is checked, not trusted, exactly as 00833 checks it: the caller must be that
-- owner, a member of that owner's workspace (public.is_workspace_member, any
-- role), or the service role. Anyone else gets 42501. RLS still applies on top,
-- since v2 stays SECURITY INVOKER like v1.
--
-- NULL p_owner_id means auth.uid(): the caller's own rows. For the service
-- role, which has no sub, NULL matches no rows.
--
-- v1 is left exactly as it is. The iOS and Android apps call it by name, and
-- changing its answer under them is a separate decision.
--
-- The body is 00248's verbatim apart from the guard, the owner predicate in
-- each branch, and plpgsql (a SQL function cannot raise). The two ' — '
-- separators inside ts_headline are v1's em dash kept on purpose: they are
-- part of the snippet text, and v2 must return the same snippet as v1 for the
-- same row. The grant is v1's:
-- authenticated, with PUBLIC coming from CREATE. No revokes, per US-2403 (a
-- denied call from a hinted role segfaults this image), the same reason 00831
-- and 00833 add none.
--
-- Proof: node scripts/check-search-owner-scope.mjs --dsn "postgresql://..."

create or replace function public.flipdesk_search_v2(
  p_query text,
  p_scope text default 'all',
  p_limit int default 50,
  p_fuzzy_threshold real default 0.3,
  -- The workspace on screen. NULL = the caller's own rows.
  p_owner_id uuid default null
)
returns table (
  result_type       text,
  result_id         uuid,
  inventory_item_id uuid,
  title             text,
  snippet           text,
  rank              real
)
language plpgsql
stable
as $$
#variable_conflict use_column
declare
  -- NULL falls back to the caller, never to "everything RLS admits", which is
  -- what mixed workspaces together in v1.
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  -- The owner, any member of the owner's workspace, or the service role.
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_search_v2: not a member of that workspace'
      using errcode = '42501';
  end if;

  return query
  with q as (
    select
      websearch_to_tsquery('english', p_query) as tsq,
      lower(btrim(coalesce(p_query, ''))) as needle,
      greatest(0.0::real, least(1.0::real, coalesce(p_fuzzy_threshold, 0.3))) as thr
  )
  select r.result_type, r.result_id, r.inventory_item_id, r.title, r.snippet, r.rank
  from (
    select
      'item'::text as result_type,
      i.id         as result_id,
      i.id         as inventory_item_id,
      i.title      as title,
      ts_headline(
        'english',
        coalesce(i.title, '') || ' — ' || coalesce(i.description, '') ||
          ' ' || coalesce(i.condition_notes, ''),
        q.tsq,
        'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=18,MinWords=5'
      )            as snippet,
      greatest(
        coalesce(ts_rank(i.search_vec, q.tsq), 0)::real,
        similarity(
          lower(coalesce(i.title, '') || ' ' || coalesce(i.brand, '')),
          q.needle
        )
      ) as rank
    from public.inventory_items i, q
    where i.user_id = v_owner
      and (p_scope = 'all' or p_scope = 'items')
      and (
        (q.tsq is not null and i.search_vec @@ q.tsq)
        or (
          q.needle <> ''
          and similarity(
            lower(coalesce(i.title, '') || ' ' || coalesce(i.brand, '')),
            q.needle
          ) >= q.thr
        )
      )

    union all

    select
      'listing'::text,
      l.id,
      l.inventory_item_id,
      l.listing_title,
      ts_headline(
        'english',
        coalesce(l.listing_title, '') || ' — ' ||
          coalesce(l.listing_description, ''),
        q.tsq,
        'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=18,MinWords=5'
      ),
      greatest(
        coalesce(ts_rank(l.search_vec, q.tsq), 0)::real,
        similarity(lower(coalesce(l.listing_title, '')), q.needle)
      )
    from public.listings l, q
    where l.user_id = v_owner
      and (p_scope = 'all' or p_scope = 'listings')
      and (
        (q.tsq is not null and l.search_vec @@ q.tsq)
        or (
          q.needle <> ''
          and similarity(lower(coalesce(l.listing_title, '')), q.needle) >= q.thr
        )
      )

    union all

    select
      'sale'::text,
      sa.id,
      sa.inventory_item_id,
      coalesce(sa.buyer_username, 'Sale'),
      ts_headline(
        'english',
        coalesce(sa.buyer_username, '') || ' ' || coalesce(sa.buyer_notes, ''),
        q.tsq,
        'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=18,MinWords=5'
      ),
      greatest(
        coalesce(ts_rank(sa.search_vec, q.tsq), 0)::real,
        similarity(lower(coalesce(sa.buyer_username, '')), q.needle)
      )
    from public.sales sa, q
    where sa.user_id = v_owner
      and (p_scope = 'all' or p_scope = 'sales')
      and (
        (q.tsq is not null and sa.search_vec @@ q.tsq)
        or (
          q.needle <> ''
          and similarity(lower(coalesce(sa.buyer_username, '')), q.needle) >= q.thr
        )
      )
  ) r
  order by r.rank desc
  limit greatest(1, least(p_limit, 200));
end;
$$;

comment on function public.flipdesk_search_v2(text, text, int, real, uuid) is
  'INV-D1 (00835): flipdesk_search for ONE workspace. Same arguments and rows '
  'as flipdesk_search plus p_owner_id (NULL = the caller''s own rows); every '
  'branch is filtered by owner before ranking and the limit. 42501 unless the '
  'caller is the owner, a member of that workspace, or the service role. '
  'SECURITY INVOKER. v1 is unchanged for the mobile apps.';

-- The same grant v1 has (PUBLIC comes from CREATE); see the header on revokes.
grant execute on function public.flipdesk_search_v2(text, text, int, real, uuid)
  to authenticated;

insert into public.applied_migrations (version) values ('00835') on conflict do nothing;
