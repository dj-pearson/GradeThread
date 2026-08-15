-- US-2585: did the help centre answer it, or did they open a ticket anyway?
--
-- Two numbers decide whether the help centre was worth building. One is organic
-- traffic (US-2578 puts it in the sitemap). The other is tickets prevented, and
-- that one is invisible without recording the moment somebody was about to
-- write a ticket and did not.
--
-- Two halves, because they are two different events:
--
--   support_tickets.help_articles_shown / help_article_opened
--       The ticket that WAS filed, and what we offered first. The failure this
--       measures is an article that gets shown, gets opened, and does not stop
--       the ticket -- which is a wrong or incomplete article, not a missing one,
--       and no other signal tells them apart.
--
--   help_deflections
--       The ticket that was NOT filed. There is no row anywhere else to hang
--       this on, which is exactly why deflection normally goes unmeasured.
--
-- Both record the SUBJECT LINE, because "what were they trying to ask" is the
-- question US-2592 has to answer, and a slug alone cannot answer it.

-- ══════════════════════════════════════════════════════════
-- THE TICKET THAT WAS FILED ANYWAY
-- ══════════════════════════════════════════════════════════

alter table public.support_tickets
  add column if not exists help_articles_shown text[] not null default '{}';

alter table public.support_tickets
  add column if not exists help_article_opened text;

comment on column public.support_tickets.help_articles_shown is
  'US-2585: the help article slugs offered above the submit button when this '
  'ticket was written. Empty means none matched, which is a content gap.';

comment on column public.support_tickets.help_article_opened is
  'US-2585: the slug the user opened before filing anyway, or null. A ticket '
  'with a slug here is the most valuable row in the table: the article was '
  'found, was read, and did not answer the question.';

-- ══════════════════════════════════════════════════════════
-- THE TICKET THAT WAS NOT FILED
-- ══════════════════════════════════════════════════════════
--
-- Deny-all RLS: the edge writes it service-role and the admin report reads it
-- the same way. It carries owner_user_id rather than user_id on purpose -- the
-- rls-guard discovery in services/edge-functions/src/tests/rls-guard_test.ts
-- classifies a table by that literal column name, and this is an ANALYTICS row
-- about a session, not a tenant-owned resource a customer may read back.

create table if not exists public.help_deflections (
  id             uuid primary key default gen_random_uuid(),
  -- Who was about to write the ticket. Nullable: the same flow can run for a
  -- session whose token has lapsed, and losing the row would bias the number
  -- toward "nobody was deflected".
  owner_user_id  uuid references auth.users(id) on delete set null,
  -- What they had typed. This is the content backlog, same as
  -- help_search_misses.normalized (US-2577).
  subject        text not null default '',
  -- What we offered, and what they read.
  articles_shown text[] not null default '{}',
  article_opened text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_help_deflections_created_at
  on public.help_deflections (created_at desc);

create index if not exists idx_help_deflections_article_opened
  on public.help_deflections (article_opened, created_at desc)
  where article_opened is not null;

alter table public.help_deflections enable row level security;

comment on table public.help_deflections is
  'US-2585: somebody opened the ticket form, was shown help articles, read one '
  'and did not file. Deny-all RLS, service-role only. There is no other row in '
  'the database this event could hang on -- which is why deflection is normally '
  'unmeasured and why this table exists.';

insert into public.applied_migrations (version) values ('00604') on conflict do nothing;
