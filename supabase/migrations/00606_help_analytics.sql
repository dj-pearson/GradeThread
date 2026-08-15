-- US-2592: counting what the help center is actually doing.
--
-- ══════════════════════════════════════════════════════════
-- WHY THERE IS A TABLE HERE AT ALL, WHEN WE ALREADY PAY FOR POSTHOG
-- ══════════════════════════════════════════════════════════
--
-- PostHog cannot see the pages that matter most. Every public help URL is
-- server-rendered by a Cloudflare Pages Function (functions/help/[[path]].ts)
-- and the React app never mounts on it -- that is the whole reason those pages
-- index well. posthog-js is loaded only after a visitor opts into the analytics
-- consent category inside the app, so on a cold search-engine visit to
-- /help/grading/the-photos-we-need there is no posthog object, no consent
-- decision, and no event.
--
-- So a "top articles" list built from PostHog would rank the in-app reader's
-- traffic and silently omit the organic traffic the epic exists to earn. This
-- table is the server-side count for that surface. PostHog still carries the
-- in-app interaction events, where the app is running and consent has been
-- asked for; the two are reported side by side and never added together.
--
-- DAILY COUNTERS, NOT ONE ROW PER VIEW. A help center that works generates far
-- more pageviews than it does anything else, and a row per view would be the
-- largest table in the database within a month to answer a question that only
-- needs a daily number. The upsert is a single statement and the primary key is
-- the dedupe.
--
-- NO IDENTITY, of any kind. No user id, no session, no IP, no referrer. The
-- grain is (article, surface, day) and nothing in this table can be joined back
-- to a person, which is what lets it be written on an anonymous public page
-- without a consent prompt.

create table if not exists public.help_article_views (
  -- By value, not a foreign key: a view of an article that is later renamed or
  -- deleted is still a view that happened, and a cascade would erase the record
  -- of it at exactly the moment somebody wants to know why traffic dropped.
  article_slug text not null,
  -- 'public' = the server-rendered page a search engine sent someone to.
  -- 'app'    = the in-app reader at /dashboard/help.
  -- Kept apart because they answer different questions and mixing them makes
  -- an internally popular article look like an SEO win.
  surface      text not null default 'public'
    check (surface in ('public', 'app')),
  day          date not null default current_date,
  views        bigint not null default 0,
  primary key (article_slug, surface, day)
);

create index if not exists idx_help_article_views_day
  on public.help_article_views (day desc, views desc);

alter table public.help_article_views enable row level security;

comment on table public.help_article_views is
  'US-2592: daily help article view counters, written server-side because the '
  'public help pages are server-rendered and PostHog never loads on them. '
  'Grain is (article, surface, day); holds no identity of any kind, which is '
  'what makes it writable from an anonymous page with no consent prompt. '
  'Deny-all RLS, service-role only.';

-- ══════════════════════════════════════════════════════════
-- THE INCREMENT
-- ══════════════════════════════════════════════════════════
--
-- An RPC because PostgREST cannot express `views = views + 1` on conflict, and
-- a read-then-write from the edge would lose counts under concurrency, which on
-- a popular article is every request.
--
-- SECURITY DEFINER with a locked search_path: the caller is the service-role
-- edge client, but defining it this way means the function is the only write
-- path even if a policy is ever added to the table by mistake.
create or replace function public.record_help_article_view(
  p_slug    text,
  p_surface text default 'public'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_surface text := case when p_surface = 'app' then 'app' else 'public' end;
  v_slug    text := lower(trim(coalesce(p_slug, '')));
begin
  -- Guard the shape here rather than trusting the caller. This function is
  -- reachable from a public page, so an unbounded slug would let anyone write
  -- arbitrary text into the table one row at a time.
  if v_slug !~ '^[a-z0-9-]{1,80}$' then
    return;
  end if;

  -- And require the article to be real. Without this the counter endpoint is a
  -- way to fill the table with invented slugs, and the "top articles" list stops
  -- being a list of articles. The existence test lives here rather than in the
  -- edge so that counting a view stays ONE round trip.
  insert into public.help_article_views (article_slug, surface, day, views)
  select v_slug, v_surface, current_date, 1
  where exists (
    select 1 from public.help_articles a
    where a.slug = v_slug and a.status = 'published'
  )
  on conflict (article_slug, surface, day)
  do update set views = public.help_article_views.views + 1;
end;
$$;

comment on function public.record_help_article_view(text, text) is
  'US-2592: increments today''s view counter for a help article. Validates the '
  'slug shape AND the article''s existence internally, because it is reachable '
  'from an anonymous public page and would otherwise be a way to invent rows. '
  'An RPC rather than a PostgREST upsert because views = views + 1 cannot be '
  'expressed there, and a read-then-write loses counts under concurrency.';

-- ══════════════════════════════════════════════════════════
-- THE BACKLOG, RANKED
-- ══════════════════════════════════════════════════════════
--
-- help_search_misses (00603) is a log. A log is not a backlog: it is ordered by
-- when somebody typed, so the thing forty people asked for sits interleaved with
-- forty one-off typos. This groups by the normalized query so the ranking is by
-- how many people wanted it.
--
-- `sample` is the raw text of the most recent instance, kept because the
-- normalized form loses the capitalisation and punctuation that sometimes say
-- what the person actually meant.
create or replace function public.help_zero_result_queries(
  p_since timestamptz default (now() - interval '30 days'),
  p_limit integer default 50
)
returns table (
  normalized  text,
  sample      text,
  misses      bigint,
  last_seen   timestamptz,
  anon_misses bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.normalized,
    (array_agg(m.query order by m.created_at desc))[1] as sample,
    count(*)                                            as misses,
    max(m.created_at)                                   as last_seen,
    count(*) filter (where m.viewer_tier = 'anon')      as anon_misses
  from public.help_search_misses m
  where m.created_at >= coalesce(p_since, now() - interval '30 days')
  group by m.normalized
  order by count(*) desc, max(m.created_at) desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function public.help_zero_result_queries(timestamptz, integer) is
  'US-2592: help_search_misses grouped into a ranked backlog. A log is ordered '
  'by when somebody typed; this is ordered by how many people wanted it, which '
  'is the order an author needs. anon_misses splits out the signed-out share, '
  'because a miss from a search-engine visitor is an SEO gap and a miss from a '
  'signed-in customer is usually a product one.';

-- ══════════════════════════════════════════════════════════
-- WHO MAY CALL THEM (US-2282 AC4)
-- ══════════════════════════════════════════════════════════
--
-- Both functions are SECURITY DEFINER, which means they run as their owner and
-- bypass RLS. On a Supabase stack, saying nothing about EXECUTE does NOT leave
-- them closed: the bootstrap grants anon and authenticated directly, so silence
-- here would publish a counter and a query-log reader to every browser.
--
-- REVOKE FROM PUBLIC alone would be a no-op, because PUBLIC is not in the ACL.
-- The roles have to be named.
--
-- Only the edge calls either one. The public view counter is reachable from an
-- anonymous page, but through the edge route, never directly from the browser —
-- which is what keeps the rate limiter and the origin check in front of it.

revoke all on function public.record_help_article_view(text, text) from public, anon, authenticated;
grant execute on function public.record_help_article_view(text, text) to service_role;

revoke all on function public.help_zero_result_queries(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.help_zero_result_queries(timestamptz, integer) to service_role;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
insert into public.applied_migrations (version) values ('00606') on conflict do nothing;
