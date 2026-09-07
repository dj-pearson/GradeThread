-- US-3128: registered numbers, sourced from the FTC register itself.
--
-- The knowledge behind this file lives in
-- vault/20-domain/brands/brand-kb-negative-findings.md. What follows is only
-- what was matched and what was refused.
--
-- WHY THIS COULD NOT BE DONE BEFORE, AND WHY IT CAN NOW: registered-numbers.ts
-- and the vault note both stated "the FTC RN database is auth-gated". That was
-- false. https://www.ftc.gov/rn-database/search answers 200 to a plain
-- unauthenticated GET and takes a `search=` query string. The premise, not the
-- registry, is what held this column at 6 brands of 230.
--
-- Every value below was read from that register on 2026-09-06 with
-- scripts/ops/ftc-rn-lookup.mjs, which is committed alongside this file so the
-- lookups can be repeated and disputed.
--
-- ── THE BAR: THE REGISTRANT MUST BE THE LABEL ──────────────────────────────
--
-- An RN names the COMPANY THAT REGISTERED IT, never a brand. Seeding the first
-- hit for a brand name is how a real federal record becomes an authoritative
-- lie. The register itself confirmed both traps this corpus already records --
-- 17257 returns LONGCHAMP FABRICS CORP (a fabric wholesaler, not the maison)
-- and 13765 returns UNION UNDERWEAR COMPANY (the parent, not Screen Stars) --
-- so the rule is not theoretical, and the REFUSALS below matter as much as the
-- seeds.
--
-- SEEDED: the registrant's legal name IS the label.
-- REFUSED: it is a different company, a different label, or a parent.

-- ── seeds ──────────────────────────────────────────────────────────────────
-- Idempotent by construction: registered_numbers is SET (not appended), and the
-- provenance sentence is added to notes only when that RN is not already named
-- there, so a second run changes nothing.

do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- brand_key,            registered numbers,                  registrant as the register returns it
      ('lululemon',        ARRAY['RN 106259'],                      'Lululemon USA Inc'),
      ('vuori',            ARRAY['RN 156509'],                      'Vuori, Inc.'),
      ('eileenfisher',     ARRAY['RN 78121'],                       'EILEEN FISHER, INC.'),
      ('faherty',          ARRAY['RN 140476'],                      'FAHERTY BRAND, LLC'),
      ('patagonia',        ARRAY['RN 51884'],                       'PATAGONIA INC.'),
      ('poloralphlauren',  ARRAY['RN 109514'],                      'POLO RALPH LAUREN CORPORATION'),
      -- Two registrations, both plainly the label. Athleta registered in its own
      -- name before the Gap acquisition and again after, so a garment may carry
      -- either; both are the brand and neither disambiguates an era on its own.
      ('athleta',          ARRAY['RN 109693','RN 115207'],          'ATHLETA / ATHLETA CORPORATION'),
      -- Same shape. CARHARTT, INC. and CARHARTT INC are the label itself.
      ('carhartt',         ARRAY['RN 14806','RN 40762'],            'CARHARTT, INC.')
    ) as t(brand_key, rns, registrant)
  loop
    update public.brand_knowledge k
       set registered_numbers = r.rns::text[],
           updated_by         = 'migration:00729',
           notes = case
             when coalesce(k.notes,'') like '%' || r.rns[1] || '%' then k.notes
             else coalesce(k.notes,'') ||
                  case when coalesce(k.notes,'') = '' then '' else E'\n\n' end ||
                  'REGISTERED NUMBER, FTC-record sourced 2026-09-06 (US-3128): ' ||
                  array_to_string(r.rns, ', ') || ' -- registrant "' || r.registrant ||
                  '" per https://www.ftc.gov/rn-database/search. An RN names the ' ||
                  'REGISTRANT and never the brand: a match corroborates, it never ' ||
                  'proves, and a counterfeit prints the number too.'
           end
     where k.brand_key = r.brand_key;
  end loop;
end $$;

-- ── TWO CONFIRMED RNs THIS FILE CANNOT SEED YET, AND WHY ───────────────────
--
--   vineyardvines  RN 134578  VINEYARD VINES, LLC
--   bonobos        RN 128054  BONOBOS, INC.
--
-- Both are clean matches: the registrant's legal name IS the label, to the same
-- standard as the eight above. They are held back by something unrelated.
--
-- ⚠ A `NOT VALID` CONSTRAINT IS NOT INERT, WHICH IS THE FINDING HERE.
-- `brand_knowledge_tag_eras_sourced` is NOT VALID, so it never checked the rows
-- that already existed -- but it DOES check any row an UPDATE touches, and this
-- migration touches these two. `tag_eras_all_sourced` requires that any era
-- whose `years` names a four-digit year or a decade carries both a source_url
-- and a numeric confidence. Vineyard Vines and Bonobos each carry two DATABLE
-- eras with neither, so the update is refused:
--
--   ERROR: new row for relation "brand_knowledge" violates check constraint
--          "brand_knowledge_tag_eras_sourced"
--
-- So old unsourced data blocks an unrelated, properly sourced edit to the same
-- row. That is an argument FOR finishing US-3126 rather than against the
-- constraint, and it was found by dry-running this file inside a transaction
-- that rolled back rather than by shipping it.
--
-- The other eight were each checked against public.tag_eras_all_sourced()
-- directly before being included; all eight return true.
--
-- ── refusals, recorded rather than silently dropped ────────────────────────
--
-- These are hits the register DID return and this file declines to seed. Written
-- down so the next person does not "find" them and think they were missed.
--
--   beyondyoga    RN 125963  I AM BEYOND LLC
--                 Product line is clothing and the entity is very likely Beyond
--                 Yoga's, but the registrant name is not the label and the
--                 corporate link is not sourced here. Confirm the link, then
--                 seed -- do not infer it from plausibility.
--
--   patagonia     RN 76119   PATAGONIA TRADING CO.
--                 A separate company sharing a place name. This is the RN 17257
--                 shape exactly: right string, wrong company.
--
--   poloralphlauren  RN 116718  CHAPS CHILDRENSWEAR, A DIVISION OF POLO RALPH LAUREN CORP
--                    RN 116756  CHAPS READY TO WEAR, A DIVISION OF POLO RALPH LAUREN
--                    RN 113338  RALPH LAUREN CHILDRENSWEAR, A DIVISION OF POLO RALPH LAUREN
--                 All three name a DIFFERENT LABEL under the same parent. Chaps
--                 is its own brand and a Chaps RN must never resolve to Polo.
--                 This is RN 13765's granularity failure in current form.
--
--   carhartt      RN 47762   CARHARTT SOUTH INC
--                 WPL 12525  CARHARTT OF TEXAS
--                 Affiliated entities rather than the label. Also note WPL is a
--                 THIRD identifier type (Wool Products Labeling) beside RN and
--                 CA, which nothing in this schema handles yet.
--
-- ── legitimate absences, which are NOT gaps ────────────────────────────────
--
--   bananarepublic, anthropologie, freepeople -- the register returns NOTHING
--   for any of them, and that is the correct answer rather than a failed lookup.
--   Anthropologie and Free People are URBN brands and this KB already records
--   URBN's RN 66170 as covering Urban Outfitters, Anthropologie AND Free People;
--   the register confirms 66170 -> URBAN OUTFITTERS, INC. Banana Republic sits
--   under THE GAP, INC. (RN 54023) the same way. A parent-held RN is `ambiguous`
--   by the existing rule -- consistent with the item, unable to pick between
--   siblings -- so seeding the parent's number onto the child would manufacture
--   a false precision.
--
-- ── one existing value that does NOT reconcile ─────────────────────────────
--
--   Peter Millar carries 'RN 100308' in brand_knowledge today and
--   `search=Peter Millar` returns NO RESULTS. Left untouched by this migration
--   rather than guessed at in either direction. US-3128 AC3 owns it.

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00729') on conflict do nothing;
