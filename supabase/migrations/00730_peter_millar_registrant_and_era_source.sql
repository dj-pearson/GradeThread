-- US-3128: build out Peter Millar, and seed Johnnie-O's registered number.
--
-- Reasoning lives in vault/20-domain/brands/brand-kb-negative-findings.md and in
-- 00467's header, which this file closes two open questions from.
--
-- ── 1. PETER MILLAR'S REGISTRANT IS NOW KNOWN ──────────────────────────────
--
-- 00467 seeded 'RN 100308' and said exactly what it did not know:
--
--   "RN 100308 IS THE ONLY SOURCED RN IN THIS PACK, and it came from PETER
--    MILLAR'S OWN help centre rather than the FTC register -- an aside in a
--    shipping FAQ noting that the number by the country of origin 'is not the
--    style number. eg. rn100308'. The FTC registrant name could not be
--    confirmed, so treat 100308 as 'the RN that appears on PM tags'."
--
-- It is confirmed now. `search=100308` on the register returns:
--
--   RN 100308  CHESTER GREGG, L.L.C.  [KNIT SHIRTS]
--
-- TWO INDEPENDENT SOURCES MEETING FROM OPPOSITE DIRECTIONS, which is stronger
-- than either alone: the brand's own help centre says this number is on its
-- tags, and the federal register says the number is registered to CHESTER
-- GREGG, L.L.C. for knit shirts -- Peter Millar being a knit-polo house. Neither
-- was derived from the other.
--
-- ⚠ AND THE REASON 00467 COULD NOT CONFIRM IT WAS A FALSE PREMISE, recorded in
-- that header as "the FTC RN database is a JS/ServiceNow shell that returns
-- nothing to automated lookup". That is the same wrong belief as
-- "auth-gated" in registered-numbers.ts and brand-kb-negative-findings.md, in a
-- third form and a third place. https://www.ftc.gov/rn-database/search answers
-- 200 to a plain GET and returns an ordinary HTML table. Nothing was gated and
-- nothing needed JavaScript.
--
-- IT STILL DOES NOT NAME THE BRAND. CHESTER GREGG, L.L.C. is the registrant, and
-- the existing rule holds unchanged: an RN corroborates, it never proves, and a
-- counterfeit prints it too.
--
-- ── 2. THE ERA THAT BLOCKED THE EDIT ───────────────────────────────────────
--
-- Peter Millar could not be updated at all until this ran.
-- `brand_knowledge_tag_eras_sourced` is NOT VALID -- it never checked existing
-- rows -- but it checks any row an UPDATE touches, and PM carries one DATABLE
-- era ("~2019 or later") with no source_url and no confidence. So the row was
-- frozen: no RN work, no notes, nothing, until that era was sourced.
--
-- The source was never missing, only unrecorded. The era's own description
-- quotes Peter Millar's press release verbatim ("Crown Crafted products are
-- differentiated from Crown & Crown Sport products with a dark navy label..."),
-- so the claim is brand-authored. The exact press-release URL was not captured
-- by 00467, so this records the brand site -- the same convention the rest of
-- this table uses (bonobos.com/, zara.com/) -- and says so rather than
-- inventing a deep link that cannot be checked.

update public.brand_knowledge
   set tag_eras = (
     select jsonb_agg(
       case
         when coalesce(e ->> 'years','') ~ '(\d{4}|\d0s)'
              and (not (e ? 'source_url') or jsonb_typeof(e -> 'confidence') is distinct from 'number')
         then e
              || jsonb_build_object('source_url', 'https://www.petermillar.com/')
              || jsonb_build_object('confidence', 0.85)
              || jsonb_build_object(
                   'source_note',
                   'Brand-authored: the description quotes Peter Millar''s own Crown Crafted press release verbatim. 00467 did not capture the release''s URL, so the brand site is recorded rather than a deep link nobody can verify. Confidence matches the row''s own 0.85.')
         else e
       end
       order by ord
     )
     from jsonb_array_elements(tag_eras) with ordinality as t(e, ord)
   )
 where brand_key = 'petermillar'
   and not public.tag_eras_all_sourced(tag_eras);

-- Now the row can be written to. Record the registrant beside the number.
update public.brand_knowledge
   set updated_by = 'migration:00730',
       notes = case
         when coalesce(notes,'') like '%CHESTER GREGG%' then notes
         else coalesce(notes,'') || E'\n\n' ||
              'REGISTRANT CONFIRMED 2026-09-06 (US-3128): RN 100308 is registered to ' ||
              'CHESTER GREGG, L.L.C., product line "KNIT SHIRTS", per ' ||
              'https://www.ftc.gov/rn-database/search. This closes the gap 00467 ' ||
              'named -- it seeded 100308 from Peter Millar''s own help centre and ' ||
              'could not confirm the registrant, because the register was believed ' ||
              'to return nothing to automated lookup. It does. The brand''s FAQ and ' ||
              'the federal register agree on the same number from opposite ' ||
              'directions, neither derived from the other. The RN still names the ' ||
              'REGISTRANT and not the brand.'
       end
 where brand_key = 'petermillar';

-- ── 3. JOHNNIE-O ───────────────────────────────────────────────────────────
-- Registrant IS the label, so it clears the bar the eight in 00729 cleared.
-- Its tag_eras already satisfy the constraint.
update public.brand_knowledge
   set registered_numbers = ARRAY['RN 121927']::text[],
       updated_by         = 'migration:00730',
       notes = case
         when coalesce(notes,'') like '%RN 121927%' then notes
         else coalesce(notes,'') || E'\n\n' ||
              'REGISTERED NUMBER, FTC-record sourced 2026-09-06 (US-3128): RN 121927 ' ||
              '-- registrant "JOHNNIE-O", product line "BELTS SHIRTS PANTS SHORTS", ' ||
              'per https://www.ftc.gov/rn-database/search. 00467 could not verify ' ||
              'any RN in its pack because the register was believed closed to ' ||
              'automated lookup; it is not. An RN names the REGISTRANT and never ' ||
              'the brand.'
       end
 where brand_key = 'johnnieo';

-- ── what this file deliberately does NOT do ────────────────────────────────
--
--   BROOKS BROTHERS  RN 99458  BROOKS BROTHERS, INC.  -- confirmed, HELD.
--     ⚠ AND IT VINDICATES 00467's REFUSAL RATHER THAN OVERTURNING IT. That pack
--     refused a widely-circulating "RN 93986" because it traced only to eBay
--     sellers' free-text. The register says Brooks Brothers is 99458. So the
--     circulating number was simply WRONG, and declining to seed it was right.
--     Held only because Brooks Brothers carries THREE datable eras with no
--     provenance (Black Fleece/Red Fleece, Brooksgate, Golden Fleece), each
--     needing its own source. That is US-3126 work, not a line in this file.
--
--   BUCK MASON  RN 146050  SIMPLE MAN LLC  -- REFUSED for now.
--     Product line "MEN'S CLOTHING" and a plausible entity, but the registrant
--     name is not the label and the corporate link is not sourced here. Same
--     treatment as Beyond Yoga's I AM BEYOND LLC in 00729.
--
--   TODD SNYDER, UNTUCKIT -- the register returns NOTHING for either. A
--     legitimate absence, not a failed lookup.
--
--   PETER MILLAR COLORWAYS -- still zero rows, and NOT filled here.
--     petermillar.com is behind bot protection: an automated request gets an
--     Imperva "Pardon Our Interruption" page, and it arrives as HTTP **200**, so
--     a status-code check reads it as success and a scraper would seed the block
--     page's contents. The brand's colour names cannot be sourced from the brand
--     this way, and a retailer's colour name is second-hand. Recorded as a
--     sourcing block rather than filled with guesses -- see US-3127.

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00730') on conflict do nothing;
