-- US-2572: the Help Center store — one row that can render as an indexable
-- public page, as an in-app doc, or as an operator-only note.
--
-- Three visibilities, not two. The story said public|gated, but "gated" was
-- doing two different jobs: a billing walkthrough that any signed-in customer
-- should read, and an abuse-threshold runbook that only an operator should.
-- Collapsing those into one flag would have published the second to every
-- customer the moment the first needed to be readable in-app.
--
--   public   → anon SELECT, indexable, sitemapped, in llms.txt
--   members  → any authenticated user; never SSR'd, never in a sitemap
--   internal → is_admin() only; operator runbooks, abuse thresholds, unreleased
--
-- Why the gate lives in RLS and not only in the edge handler: the Cloudflare
-- Pages SSR worker reads with the ANON key (same as blog_posts in 00041), so
-- the anon policy IS the wall. A handler bug cannot leak a members/internal row
-- through the public renderer, because the anon role never sees the row.
--
-- Not tenant data: help_articles has no user_id and is not parent-scoped, so
-- rls-guard's discovery does not classify it, and it does NOT belong in
-- SERVICE_ROLE_ONLY (that list is for zero-policy deny-all tables; this one has
-- policies).

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_type where typname = 'help_visibility') then
    create type public.help_visibility as enum ('public', 'members', 'internal');
  end if;
  if not exists (select 1 from pg_type where typname = 'help_article_status') then
    create type public.help_article_status as enum ('draft', 'published', 'archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'help_audience') then
    create type public.help_audience as enum ('all', 'seller', 'buyer', 'developer', 'operator');
  end if;
end $$;

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

create table if not exists public.help_categories (
  key         text primary key,
  title       text not null,
  slug        text not null,
  summary     text not null default '',
  sort_order  integer not null default 0,
  icon        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists idx_help_categories_slug
  on public.help_categories (lower(slug));

create table if not exists public.help_articles (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null,
  title                text not null,
  summary              text not null default '',
  body_html            text not null default '',
  body_json            jsonb not null default '{}'::jsonb,  -- Tiptap doc
  body_markdown        text not null default '',            -- the /.md mirror (US-2580)
  category_key         text not null references public.help_categories(key) on delete restrict,
  audience             public.help_audience not null default 'all',
  visibility           public.help_visibility not null default 'public',
  status               public.help_article_status not null default 'draft',
  sort_order           integer not null default 0,
  hero_image_url       text,
  faq                  jsonb not null default '[]'::jsonb,  -- [{question, answer}] → FAQPage (US-2579)
  related_slugs        text[] not null default '{}',
  video_url            text,
  pillar_path          text,                                -- the marketing pillar this links up to (US-2582)
  published_at         timestamptz,
  reviewed_at          timestamptz,
  review_interval_days integer not null default 180,        -- US-2591 staleness clock
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Slug is the public URL segment; case-insensitively unique across the corpus,
-- not per category, so an article can be re-filed without breaking its URL.
create unique index if not exists idx_help_articles_slug
  on public.help_articles (lower(slug));

-- Hot path: the public index and every category landing.
create index if not exists idx_help_articles_public_listing
  on public.help_articles (category_key, sort_order, title)
  where status = 'published' and visibility = 'public';

create index if not exists idx_help_articles_status_visibility
  on public.help_articles (status, visibility);

-- US-2591: "which articles are past their review interval".
create index if not exists idx_help_articles_reviewed_at
  on public.help_articles (reviewed_at)
  where status = 'published';

drop trigger if exists set_help_categories_updated_at on public.help_categories;
create trigger set_help_categories_updated_at
  before update on public.help_categories
  for each row execute function public.set_updated_at();

drop trigger if exists set_help_articles_updated_at on public.help_articles;
create trigger set_help_articles_updated_at
  before update on public.help_articles
  for each row execute function public.set_updated_at();

comment on table public.help_articles is
  'Help Center articles (US-2572). One row serves the public SSR page, the '
  'in-app reader and the contextual help sheet. visibility is the wall: '
  'public = anon-readable and indexable, members = any signed-in user, '
  'internal = is_admin() only. Anything not ''public'' must never reach a '
  'sitemap, llms.txt, the prerender output or an og: card.';

comment on column public.help_articles.pillar_path is
  'Absolute path of the marketing pillar this article links up to (e.g. '
  '/condition-grading). Renders as the pillar link; keeps help articles inside '
  'the existing internal-link graph instead of orphaned off it.';

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

alter table public.help_categories enable row level security;
alter table public.help_articles   enable row level security;

-- Admins do everything, including reading drafts.
drop policy if exists "admins manage help_categories" on public.help_categories;
create policy "admins manage help_categories"
  on public.help_categories for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins manage help_articles" on public.help_articles;
create policy "admins manage help_articles"
  on public.help_articles for all
  using (public.is_admin()) with check (public.is_admin());

-- Categories are navigation labels, not content: readable by everyone. The
-- articles inside one are still filtered by their own policies, so a category
-- that happens to hold only internal articles renders as an empty section to
-- anon rather than leaking a title.
drop policy if exists "anon read help categories" on public.help_categories;
create policy "anon read help categories"
  on public.help_categories for select
  to anon
  using (true);

drop policy if exists "authenticated read help categories" on public.help_categories;
create policy "authenticated read help categories"
  on public.help_categories for select
  to authenticated
  using (true);

-- THE WALL. The SSR worker reads with the anon key, so this single predicate is
-- what keeps members/internal articles and drafts off the public web.
drop policy if exists "anon read published public help" on public.help_articles;
create policy "anon read published public help"
  on public.help_articles for select
  to anon
  using (status = 'published' and visibility = 'public');

-- Signed-in customers additionally get 'members'. NOT 'internal' — that is the
-- distinction this table exists to keep, and an authenticated session belongs
-- to a customer, not an operator.
drop policy if exists "authenticated read published help" on public.help_articles;
create policy "authenticated read published help"
  on public.help_articles for select
  to authenticated
  using (
    status = 'published'
    and visibility in ('public', 'members')
  );

-- ══════════════════════════════════════════════════════════
-- SEED: the category shelf
-- ══════════════════════════════════════════════════════════

insert into public.help_categories (key, title, slug, summary, sort_order, icon) values
  ('getting-started', 'Getting started', 'getting-started',
   'Create an account, run your first grade, and find your way around.', 10, 'Rocket'),
  ('grading', 'Grading', 'grading',
   'The 1.0-10.0 scale, the five factors, the photos we need, and what a grade does and does not claim.', 20, 'Ruler'),
  ('certificates', 'Certificates and passports', 'certificates',
   'Share a grade, print a tag, embed a badge, and follow a garment''s history.', 30, 'BadgeCheck'),
  ('flipdesk', 'FlipDesk', 'flipdesk',
   'The reseller pipeline, stage by stage: source, catalog, measure, photograph, grade, comp, draft, list, sell, ship, reconcile.', 40, 'LayoutGrid'),
  ('marketplaces', 'Marketplaces', 'marketplaces',
   'Connect eBay, set business policies, map condition, cross-post, and reconcile payouts.', 50, 'Store'),
  ('autolister', 'AutoLister and bulk work', 'autolister',
   'Generate and publish listings in batches, and read what a batch is doing.', 60, 'Layers'),
  ('extension', 'Browser extension', 'extension',
   'Install it, connect it, and use Condition Check, Compare, Flip, Scan and the Lister.', 70, 'Chrome'),
  ('mobile', 'iPhone and Android apps', 'mobile',
   'Install, sign in, shoot photos, share from another app, and stay signed in.', 80, 'Smartphone'),
  ('buyers', 'For buyers', 'buyers',
   'Verify a certificate, scan a garment before you buy, and use the buyer guarantee.', 90, 'ShieldCheck'),
  ('billing', 'Billing', 'billing',
   'Plans, credits, upgrades, cancellations, refunds and invoices.', 100, 'CreditCard'),
  ('team', 'Team and workspaces', 'team',
   'Invite people, set roles, and understand who owns what.', 110, 'Users'),
  ('integrations', 'API and integrations', 'integrations',
   'API keys, the REST API and SDK, the sandbox, webhooks, embeds and Google Sheets.', 120, 'Plug'),
  ('troubleshooting', 'Troubleshooting', 'troubleshooting',
   'What to do when something will not sign in, upload, publish or send.', 130, 'LifeBuoy'),
  ('account', 'Account and privacy', 'account',
   'Security, sign-in, your data, exports and deletion.', 140, 'Lock')
on conflict (key) do update set
  title      = excluded.title,
  slug       = excluded.slug,
  summary    = excluded.summary,
  sort_order = excluded.sort_order,
  icon       = excluded.icon;

insert into public.applied_migrations (version) values ('00602') on conflict do nothing;
