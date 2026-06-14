-- US-879: close the loop — GSC search data feeds topic selection + refresh priority.
--
-- The per-query / per-page GSC metrics this closed loop needs ALREADY exist in
-- public.gsc_performance (US-308, migration 00056): one row per
-- (date, site_url, page, query, country, device) carrying impressions / clicks /
-- ctr / position, populated daily by the gsc-sync cron
-- (/api/admin/seo/jobs/gsc-sync) and admin-read only (RLS enabled, no anon /
-- authenticated grants — only the service-role edge reads it). Rather than stand
-- up a second, redundant ingestion table for the same data, US-879 reads
-- gsc_performance directly for:
--   * title/meta opportunities  (high-impression / low-CTR queries),
--   * content-gap detection      (high-impression queries with no matching post),
--   * striking-distance priority (pages ranking ~5-20 with rising impressions).
--
-- The one piece of schema the loop needs that does NOT yet exist is a way to
-- attribute a bank topic to a GSC content gap, so the autonomous engine, the
-- admin bank view, and the weekly digest can tell search-demand topics apart
-- from AI-brainstormed ('research') and human ('manual') ones. This migration
-- adds that enum value. (ADD VALUE is committed here and only USED at runtime by
-- the edge service, so the same-transaction restriction never applies.)

ALTER TYPE public.content_topic_source ADD VALUE IF NOT EXISTS 'gsc_opportunity';

COMMENT ON TYPE public.content_topic_source IS
  'How a content_topics row entered the bank: research (AI brainstorm), manual '
  '(human), history_derived, or gsc_opportunity (US-879: queued from a Google '
  'Search Console content gap — a high-impression query with no dedicated post).';
