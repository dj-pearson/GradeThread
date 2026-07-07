-- Advisory content-safety review (2026-07): the pre-publish safety gate
-- (US-486, migration 00151) used to HOLD any AI-generated blog/social post whose
-- reviewer verdict was not "pass" — the post stayed a draft (safety_status
-- 'held') until a human published it. Per product decision (2026-07) that gate
-- is now ADVISORY on the auto-publish path: the post publishes immediately and
-- is tagged safety_status='flagged' (reasons in safety_notes) for after-the-fact
-- review, instead of being withheld. This adds the 'flagged' value the edge
-- writes on that path.
--
-- 'held' is retained (still a valid state; nothing writes it on the auto-publish
-- path anymore, and manual holds could reuse it later). Filter live-but-flagged
-- posts with: status='published' AND safety_status='flagged'.
--
-- Idempotent (ADD VALUE IF NOT EXISTS). NOTE: a newly-added enum value cannot be
-- USED in the same transaction that adds it — the edge only writes 'flagged'
-- from a later deploy (boot-guarded on this schema version), so the order holds.

ALTER TYPE public.content_safety_status ADD VALUE IF NOT EXISTS 'flagged';

-- US-1108 self-record: keep the edge boot guard truthful regardless of how the
-- SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00388')
ON CONFLICT (version) DO NOTHING;
