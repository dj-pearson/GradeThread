-- US-2577: search for the Help Center, and a record of what it failed to find.
--
-- Search runs in Postgres, not in the browser. A client-side filter means
-- shipping every article body to every visitor, which stops being viable long
-- before the corpus is finished and is useless to the SSR search page, which has
-- to answer with no JavaScript at all.
--
-- Weighting mirrors support_kb_articles (00183): title A, then summary, then
-- body. Indexed from body_markdown rather than body_html, because a tsvector
-- built over markup matches on tag names and attribute values -- searching for
-- "class" would hit every article with a styled paragraph.
--
-- to_tsvector(regconfig, text) is IMMUTABLE when the config is a literal, which
-- is what makes it legal in a GENERATED ALWAYS ... STORED expression.

alter table public.help_articles
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_markdown, '')), 'C')
  ) stored;

create index if not exists idx_help_articles_search_tsv
  on public.help_articles using gin (search_tsv);

comment on column public.help_articles.search_tsv is
  'Weighted FTS vector (title A, summary B, body_markdown C), maintained by '
  'Postgres. Built from body_markdown, NOT body_html: a vector over markup '
  'matches tag names and attribute values, so "class" would hit every styled '
  'article. Visibility filtering is NOT part of this column -- the caller still '
  'passes visibilitiesFor(viewer), or search becomes the way around the wall.';

-- ══════════════════════════════════════════════════════════
-- WHAT SEARCH COULD NOT ANSWER
-- ══════════════════════════════════════════════════════════
--
-- A zero-result query is the single best signal for what to write next: someone
-- wanted an answer badly enough to type it and got nothing. US-2592 turns this
-- into a ranked backlog.
--
-- No identity is recorded. Not a caller id, not an IP, not a session -- only the
-- text typed, the viewer TIER, and how many hits it got. A help query can carry
-- anything a frustrated person types, so the row is deliberately not joinable to
-- a person. Deny-all RLS: the edge writes it service-role and the admin report
-- reads it the same way.

create table if not exists public.help_search_misses (
  id           uuid primary key default gen_random_uuid(),
  query        text not null,
  -- Lowercased and whitespace-collapsed, so "eBay  Fees" and "ebay fees" rank
  -- together in the backlog instead of as two separate misses.
  normalized   text not null,
  -- 'anon' | 'member' | 'admin'. The TIER, never the person.
  viewer_tier  text not null default 'anon',
  hits         integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists idx_help_search_misses_normalized
  on public.help_search_misses (normalized, created_at desc);

create index if not exists idx_help_search_misses_created_at
  on public.help_search_misses (created_at desc);

alter table public.help_search_misses enable row level security;

comment on table public.help_search_misses is
  'US-2577: help searches that returned nothing, as the backlog for what to '
  'write next (US-2592 ranks them). Deny-all RLS, service-role only. Stores no '
  'identity of any kind -- only the query text, the viewer tier and the hit '
  'count -- because a help query can carry anything a frustrated person types '
  'and this row must not be joinable to a person.';

-- ══════════════════════════════════════════════════════════
-- THE SEARCH ITSELF
-- ══════════════════════════════════════════════════════════
--
-- An RPC rather than a PostgREST filter, because ranking is the point: without
-- ts_rank the results come back in table order, which for a help center means
-- alphabetical by category. PostgREST cannot order by a computed expression.
--
-- `p_visibilities` has NO DEFAULT, deliberately. A default would make the safe
-- call and the unsafe call look identical at the call site, and the unsafe one
-- would be the shorter to type. The caller must pass visibilitiesFor(viewer).
--
-- websearch_to_tsquery is the forgiving parser: it accepts quotes, OR and -term
-- from a human, and it does not raise on the punctuation a real question
-- contains. plainto_tsquery would drop the quotes; to_tsquery would error.

create or replace function public.help_search(
  p_query        text,
  p_visibilities text[],
  p_limit        integer default 20
)
returns table (
  slug         text,
  title        text,
  summary      text,
  category_key text,
  visibility   public.help_visibility,
  rank         real
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.slug,
    a.title,
    a.summary,
    a.category_key,
    a.visibility,
    ts_rank(a.search_tsv, websearch_to_tsquery('english', p_query)) as rank
  from public.help_articles a
  where a.status = 'published'
    and a.visibility = any (p_visibilities::public.help_visibility[])
    and a.search_tsv @@ websearch_to_tsquery('english', p_query)
  order by rank desc, a.sort_order asc, a.title asc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

comment on function public.help_search(text, text[], integer) is
  'US-2577: ranked Help Center search. p_visibilities has no default on '
  'purpose -- pass visibilitiesFor(viewer). SECURITY INVOKER, so a direct call '
  'by an anon session is still filtered by the table policies in 00602; the '
  'edge calls it service-role, where the argument is the only filter there is.';

insert into public.applied_migrations (version) values ('00603') on conflict do nothing;
