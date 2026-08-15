-- US-2591: was this article any good, and is it still true?
--
-- A help centre rots faster than marketing copy, because it describes a UI that
-- changes weekly. Two mechanisms, and they answer different questions:
--
--   help_feedback     Did this article work? Asked of the reader, per article,
--                     against the VERSION they read, so a rewrite starts a
--                     clean record rather than inheriting the old one's score.
--
--   content_version   Which version they read. A counter bumped whenever the
--                     body changes, so "we fixed it and the votes recovered" is
--                     an answerable claim instead of a hope.
--
-- reviewed_at and review_interval_days already exist (00602). What was missing
-- was anything that made a stale article VISIBLE, which is the whole failure:
-- an article nobody has re-read since a redesign looks identical to one that was
-- checked yesterday.

-- ══════════════════════════════════════════════════════════
-- WHICH VERSION THE READER SAW
-- ══════════════════════════════════════════════════════════

alter table public.help_articles
  add column if not exists content_version integer not null default 1;

comment on column public.help_articles.content_version is
  'US-2591: bumped by the trigger below whenever body_html changes. Feedback is '
  'recorded against it, so a rewritten article does not inherit the votes its '
  'previous wording earned or lost.';

-- Bump on a real body change only. Re-saving an article to fix its sort order
-- must not reset its feedback history, and touching updated_at is not the same
-- event as changing what the article says.
create or replace function public.bump_help_content_version()
returns trigger
language plpgsql
as $$
begin
  if new.body_html is distinct from old.body_html then
    new.content_version := old.content_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists bump_help_content_version on public.help_articles;
create trigger bump_help_content_version
  before update on public.help_articles
  for each row execute function public.bump_help_content_version();

-- ══════════════════════════════════════════════════════════
-- WAS IT HELPFUL
-- ══════════════════════════════════════════════════════════
--
-- Deny-all RLS: the edge writes it service-role and the admin report reads it
-- the same way. Owner column is `owner_user_id` per the convention, and it is
-- NULLABLE because the article is public and most readers are not signed in.
-- Requiring identity would collect feedback only from the minority who happened
-- to be logged in, which is a biased sample dressed as a measurement.

create table if not exists public.help_feedback (
  id              uuid primary key default gen_random_uuid(),
  article_slug    text not null,
  -- Which wording they were judging.
  content_version integer not null default 1,
  helpful         boolean not null,
  -- Optional, and the most useful field when it is filled in. Capped in the
  -- handler, not trusted from the client.
  comment         text,
  -- 'anon' | 'member' | 'admin'. The TIER, never the person.
  viewer_tier     text not null default 'anon',
  owner_user_id   uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_help_feedback_slug_version
  on public.help_feedback (article_slug, content_version, created_at desc);

create index if not exists idx_help_feedback_unhelpful
  on public.help_feedback (article_slug, created_at desc)
  where helpful = false;

alter table public.help_feedback enable row level security;

comment on table public.help_feedback is
  'US-2591: per-article helpfulness votes, recorded against the content_version '
  'the reader saw. Deny-all RLS, service-role only. owner_user_id is NULLABLE '
  'on purpose: the articles are public, and requiring a signed-in reader would '
  'collect a biased sample and call it a measurement.';

-- ══════════════════════════════════════════════════════════
-- WHAT IS STALE
-- ══════════════════════════════════════════════════════════
--
-- A view rather than a column, because staleness is a function of NOW() and a
-- stored flag would be wrong within a day of being written.
--
-- SECURITY INVOKER: a view over help_articles, so 00602's policies still apply
-- to whoever queries it. The admin report reaches it service-role.

create or replace view public.help_articles_stale
with (security_invoker = true)
as
select
  a.slug,
  a.title,
  a.category_key,
  a.visibility,
  a.reviewed_at,
  a.published_at,
  a.review_interval_days,
  coalesce(a.reviewed_at, a.published_at) as basis,
  (now() - coalesce(a.reviewed_at, a.published_at))
    > (a.review_interval_days * interval '1 day') as is_stale,
  extract(
    day from now() - coalesce(a.reviewed_at, a.published_at)
  )::integer as days_since_basis
from public.help_articles a
where a.status = 'published'
  and coalesce(a.reviewed_at, a.published_at) is not null;

comment on view public.help_articles_stale is
  'US-2591: published articles with how long since anybody re-read them. A VIEW '
  'rather than a stored flag, because staleness depends on now() and a stored '
  'boolean is wrong within a day. A stale article is FLAGGED, never unpublished '
  'and never dropped from the sitemap: a page that vanishes because nobody '
  'reviewed it is worse than a page that is slightly out of date.';

insert into public.applied_migrations (version) values ('00605') on conflict do nothing;
