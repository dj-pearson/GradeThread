-- US-3201: the seller's own listing voice.
--
-- ai-listing.ts hardcodes a per-PLATFORM tone map ("casual Gen-Z tone, hashtags,
-- no title" for Depop) and has no per-SELLER instruction anywhere, so every
-- GradeThread seller's descriptions read the same. The standing LINES are
-- already the seller's (listing_snippets, 00678); the VOICE was not.
--
-- ONE COLUMN, NOT A TONE/LENGTH/FORMALITY TRIO. A seller describing how they
-- want to sound writes a sentence, not three dropdown picks, and every enum we
-- could offer is a guess at which axis they care about.
--
-- NULL MEANS "USE THE PROMPT AS SHIPPED" and is the deliberate default, so an
-- account that never opens the setting gets byte-identical output to today.
-- The CHECK REFUSES an empty or all-whitespace value rather than normalising
-- it, so there is exactly one way to say "off" and the client has to mean it:
-- use-listing-voice.ts writes NULL when the box is cleared.
--
-- THE 2000-CHARACTER CAP IS NOT COSMETIC. This text is appended to a VERSIONED
-- prompt (ai_prompt_versions, gated by listing-eval.ts) as its own trailing
-- block, and it rides on every listing generation. Unbounded seller text would
-- be an unbounded per-call token cost on a path that runs in batches, and a
-- long enough instruction can crowd out the prompt it follows.
--
-- DEPLOY ORDER: database first. The edge SELECTs this column when it builds the
-- listing prompt; against a database without it the read fails with 42703 and
-- AutoLister throws. EXPECTED_SCHEMA_VERSION moves to 00773 in this commit.

alter table public.flipdesk_settings
  add column if not exists listing_voice_prompt text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'flipdesk_settings_listing_voice_sane'
  ) then
    alter table public.flipdesk_settings
      add constraint flipdesk_settings_listing_voice_sane
      check (listing_voice_prompt is null
             or (length(listing_voice_prompt) between 1 and 2000
                 and btrim(listing_voice_prompt) <> ''));
  end if;
end $$;

comment on column public.flipdesk_settings.listing_voice_prompt is
  'US-3201: how this seller wants their listing copy to sound, in their own words. Appended to the versioned listing_gen prompt as a separate trailing block, never edited into it, and never sent on an eval run. NULL means use the prompt as shipped.';

insert into public.applied_migrations (version) values ('00773') on conflict do nothing;
