-- US-3443: the category_match precision pass, for the rows already in prod.
--
-- WHY A MIGRATION AND NOT JUST THE SEED. 00498 is applied, so regenerating it
-- updates the repo and reaches production never. The three-part shape US-3324
-- established is what actually lands a corpus edit: the TypeScript seed, the
-- regenerated 00498 that keeps the parity guard honest, and this file, which is
-- the only one prod reads.
--
-- WHAT IT CHANGES, and what it deliberately does not. narrowChartsByCategory
-- keeps the charts whose category_match the asked-for category contains, and
-- falls back to the family when none matches. 254 of the resolver's brand and
-- category asks fell through that step; 113 of them did so only because a
-- chart's own word list was short, such as a brand's generic "Tops" chart that
-- never says "blouse". Those words are added here. The other 141 are refused on
-- purpose: a jeans chart may not claim "skirt", a leggings chart may not claim
-- "jeans", and a men's chart may not claim either, because that asserts a
-- product the brand does not publish. That was US-3405's reason for not doing
-- this pass by rule, and it still holds for those rows.
--
-- IDEMPOTENT BY CONSTRUCTION: each statement appends only the tokens the row
-- does not already carry, so a second run appends the empty array. It also
-- never overwrites a word a later migration added by hand.
--
-- ONE ROW OF THE 88 IS DELIBERATELY ABSENT, and it is the constraint working
-- rather than a gap. `brand_size_charts_sourced` is a NOT VALID check demanding
-- a source_url and a confidence on every row, so the nine unsourced rows
-- grandfathered in 00578 are readable but not writable until somebody sources
-- them. Exactly one target is among those nine: express / Women / "Tops &
-- outerwear (US numeric 00-18 / alpha)", which would have gained "hoodie". The
-- seed carries the word, so it lands the day that row gets a source; inventing
-- one here to get past the check is the provenance defect the check exists to
-- prevent. Until then an Express hoodie ask keeps falling through to the family
-- filter, which is what it does today.

do $$
declare
  missing int;
  covered int;
begin
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'aloyoga' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['sweater']::text[]) except select unnest(category_match))
  where brand_key = 'aloyoga' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','shirt','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'sweatybetty' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'gymshark' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['sweater']::text[]) except select unnest(category_match))
  where brand_key = 'gymshark' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['sweater']::text[]) except select unnest(category_match))
  where brand_key = 'underarmour' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'underarmour' and department = 'Men' and garment = 'Bottoms';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'beyondyoga' and department = 'Women' and garment = 'Tops & outerwear';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'fabletics' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['sweater']::text[]) except select unnest(category_match))
  where brand_key = 'vuori' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'lululemon' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['sweater']::text[]) except select unnest(category_match))
  where brand_key = 'lululemon' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['sweater']::text[]) except select unnest(category_match))
  where brand_key = 'nike' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'nike' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'athleta' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['sweater']::text[]) except select unnest(category_match))
  where brand_key = 'columbia' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'columbia' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'columbia' and department = 'Men' and garment = 'Bottoms';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['shirt','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'arcteryx' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','shirt','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'arcteryx' and department = 'Women' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['shirt','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'marmot' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['shirt','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'mountainhardwear' and department = 'Men' and garment = 'Tops';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'chanel' and department = 'Women' and garment = 'Dresses & tops (FR sizing)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'michaelkors' and department = 'Women' and garment = 'Tops & dresses (US sizing)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'toryburch' and department = 'Women' and garment = 'Tops & dresses (US numeric)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'fearofgodessentials' and department = 'Unisex' and garment = 'Tops (OVERSIZED, alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean','skirt']::text[]) except select unnest(category_match))
  where brand_key = 'fearofgodessentials' and department = 'Unisex' and garment = 'Bottoms (OVERSIZED, alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'anthropologie' and department = 'Women' and garment = 'Tops & dresses (US alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'szane' and department = 'Women' and garment = 'Tops & dresses (FRENCH sizing)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'aritzia' and department = 'Women' and garment = 'Tops & dresses (alpha, RUNS SMALL)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'reformation' and department = 'Women' and garment = 'Dresses & tops (US numeric)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'theory' and department = 'Women' and garment = 'Tops & tailoring (US alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'eileenfisher' and department = 'Women' and garment = 'Tops & knits (alpha, RUNS LARGE)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'eileenfisher' and department = 'Women' and garment = 'Bottoms (alpha, RUNS LARGE)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'uniqlo' and department = 'Women' and garment = 'Tops (alpha, RUNS SMALL)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'uniqlo' and department = 'Men' and garment = 'Tops (alpha, RUNS SMALL)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'bananarepublic' and department = 'Women' and garment = 'Tops (alpha/numeric)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'bananarepublic' and department = 'Men' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'woolrich' and department = 'Men' and garment = 'Outerwear, tops & bottoms';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','hoodie','skirt']::text[]) except select unnest(category_match))
  where brand_key = 'woolrich' and department = 'Women' and garment = 'Outerwear, tops & bottoms';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse']::text[]) except select unnest(category_match))
  where brand_key = 'offwhite' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse']::text[]) except select unnest(category_match))
  where brand_key = 'chromehearts' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse']::text[]) except select unnest(category_match))
  where brand_key = 'aimleondore' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'gallerydept' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['short','skirt']::text[]) except select unnest(category_match))
  where brand_key = 'denimtears' and department = 'Unisex' and garment = 'Bottoms (LEVI''S WAIST-SIZED)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'rhude' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'sp5der' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'hellstar' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'antisocialsocialclub' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'fila' and department = 'Unisex' and garment = 'Tops (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','jean','skirt','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'outdoorvoices' and department = 'Women' and garment = 'Tops, dresses & bottoms (alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','jean','shirt','skirt','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'girlfriendcollective' and department = 'Women' and garment = 'Tops & bottoms (alpha XXS-6XL — the widest run in the KB)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'zara' and department = 'Women' and garment = 'Tops & dresses (EU numeric 34-42 / alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'anntaylor' and department = 'Women' and garment = 'Tops & dresses (US numeric 00-18 — shared Ann Taylor / LOFT grade)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie','skirt']::text[]) except select unnest(category_match))
  where brand_key = 'untuckit' and department = 'Women' and garment = 'Tops, bottoms, outerwear & dresses (ALPHA XS-XL)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'vineyardvines' and department = 'Men' and garment = 'Tops (ALPHA XS-XXL — body measurements)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'vineyardvines' and department = 'Women' and garment = 'Tops & dresses (US numeric 00-24 + alpha XXS-3X)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'faherty' and department = 'Men' and garment = 'Tops (ALPHA XS-XXXL — body measurements)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'faherty' and department = 'Women' and garment = 'Tops & dresses (ALPHA XS-XL + US numeric 0-16)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'filson' and department = 'Men' and garment = 'Tops & outerwear (alpha, CHEST inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'pendleton' and department = 'Men' and garment = 'Wool shirts & tops (alpha, CHEST inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'orvis' and department = 'Men' and garment = 'Tops & outerwear (alpha, CHEST inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['bottom','jean','short','sweater']::text[]) except select unnest(category_match))
  where brand_key = 'khl' and department = 'Men' and garment = 'Apparel (US alpha tops; pants by WAIST inch)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse','jean','skirt']::text[]) except select unnest(category_match))
  where brand_key = 'canadagoose' and department = 'Women' and garment = 'Tops & bottoms (Standard fit, body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'canadagoose' and department = 'Men' and garment = 'Tops & bottoms (Standard fit, body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'champion' and department = 'Men' and garment = 'Bottoms (alpha, body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'champion' and department = 'Women' and garment = 'Bottoms (alpha/numeric, body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['blouse']::text[]) except select unnest(category_match))
  where brand_key = 'denimtears' and department = 'Unisex' and garment = 'Tops & outerwear (alpha — GARMENT FLAT specs, inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'uniqlo' and department = 'Unisex' and garment = 'Bottoms (inch-sized — the number IS the waist)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'aimleondore' and department = 'Unisex' and garment = 'Bottoms (system conversion only — no body measurements)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'arcteryx' and department = 'Women' and garment = 'Bottoms, alpha (body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'arcteryx' and department = 'Women' and garment = 'Bottoms, US numeric (body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'nike' and department = 'Men' and garment = 'Bottoms (body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'nike' and department = 'Women' and garment = 'Bottoms (body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'nike' and department = 'Women' and garment = 'Bottoms, plus (body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'gallerydept' and department = 'Unisex' and garment = 'Bottoms (GARMENT waist — the tag is 2in under it)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean','skirt']::text[]) except select unnest(category_match))
  where brand_key = 'reebok' and department = 'Unisex' and garment = 'Bottoms (body inches)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'woolrich' and department = 'Women' and garment = 'Bottoms (INCH waist, not a body measurement)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'marmot' and department = 'Women' and garment = 'Bottoms (alpha + US numeric)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'marmot' and department = 'Women' and garment = 'Bottoms, plus (1X-3X)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean']::text[]) except select unnest(category_match))
  where brand_key = 'mountainhardwear' and department = 'Men' and garment = 'Bottoms (alpha, with the pant-size tag in the label)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['jean','skirt']::text[]) except select unnest(category_match))
  where brand_key = 'mountainhardwear' and department = 'Women' and garment = 'Bottoms (alpha, with the US numeric tag in the label)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'orvis' and department = 'Women' and garment = 'Tops (alpha ↔ US numeric)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'hellstar' and department = 'Unisex' and garment = 'Bottoms (alpha, waist + inseam)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'sp5der' and department = 'Unisex' and garment = 'Bottoms (FLAT garment specs, alpha)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['skirt']::text[]) except select unnest(category_match))
  where brand_key = 'sp5der' and department = 'Women' and garment = 'Bottoms (FLAT garment specs, alpha XS-L)';
  update public.brand_size_charts set category_match = category_match || array(
    select unnest(ARRAY['hoodie']::text[]) except select unnest(category_match))
  where brand_key = 'frame' and department = 'Women' and garment = 'Tops & outerwear (alpha ↔ US numeric, body inches)';

  -- A statement that matches nothing is silent, and 87 of them being silent
  -- would read exactly like a clean apply. Name the rows and check them.
  create temporary table us3443_targets (
    brand_key text, department text, garment text, words text[]
  ) on commit drop;
  insert into us3443_targets values
    ('aloyoga', 'Women', 'Tops', ARRAY['blouse','sweater']::text[]),
    ('aloyoga', 'Men', 'Tops', ARRAY['sweater']::text[]),
    ('sweatybetty', 'Women', 'Tops', ARRAY['blouse','shirt','sweater']::text[]),
    ('gymshark', 'Women', 'Tops', ARRAY['blouse','sweater']::text[]),
    ('gymshark', 'Men', 'Tops', ARRAY['sweater']::text[]),
    ('underarmour', 'Men', 'Tops', ARRAY['sweater']::text[]),
    ('underarmour', 'Men', 'Bottoms', ARRAY['jean']::text[]),
    ('beyondyoga', 'Women', 'Tops & outerwear', ARRAY['blouse','sweater']::text[]),
    ('fabletics', 'Women', 'Tops', ARRAY['blouse','sweater']::text[]),
    ('vuori', 'Men', 'Tops', ARRAY['sweater']::text[]),
    ('lululemon', 'Women', 'Tops', ARRAY['blouse','sweater']::text[]),
    ('lululemon', 'Men', 'Tops', ARRAY['sweater']::text[]),
    ('nike', 'Men', 'Tops', ARRAY['sweater']::text[]),
    ('nike', 'Women', 'Tops', ARRAY['blouse','sweater']::text[]),
    ('athleta', 'Women', 'Tops', ARRAY['blouse','sweater']::text[]),
    ('columbia', 'Men', 'Tops', ARRAY['sweater']::text[]),
    ('columbia', 'Women', 'Tops', ARRAY['blouse','sweater']::text[]),
    ('columbia', 'Men', 'Bottoms', ARRAY['jean']::text[]),
    ('arcteryx', 'Men', 'Tops', ARRAY['shirt','sweater']::text[]),
    ('arcteryx', 'Women', 'Tops', ARRAY['blouse','shirt','sweater']::text[]),
    ('marmot', 'Men', 'Tops', ARRAY['shirt','sweater']::text[]),
    ('mountainhardwear', 'Men', 'Tops', ARRAY['shirt','sweater']::text[]),
    ('chanel', 'Women', 'Dresses & tops (FR sizing)', ARRAY['hoodie']::text[]),
    ('michaelkors', 'Women', 'Tops & dresses (US sizing)', ARRAY['hoodie']::text[]),
    ('toryburch', 'Women', 'Tops & dresses (US numeric)', ARRAY['hoodie']::text[]),
    ('fearofgodessentials', 'Unisex', 'Tops (OVERSIZED, alpha)', ARRAY['blouse','sweater']::text[]),
    ('fearofgodessentials', 'Unisex', 'Bottoms (OVERSIZED, alpha)', ARRAY['jean','skirt']::text[]),
    ('anthropologie', 'Women', 'Tops & dresses (US alpha)', ARRAY['hoodie']::text[]),
    ('szane', 'Women', 'Tops & dresses (FRENCH sizing)', ARRAY['hoodie']::text[]),
    ('aritzia', 'Women', 'Tops & dresses (alpha, RUNS SMALL)', ARRAY['hoodie']::text[]),
    ('reformation', 'Women', 'Dresses & tops (US numeric)', ARRAY['hoodie']::text[]),
    ('theory', 'Women', 'Tops & tailoring (US alpha)', ARRAY['hoodie']::text[]),
    ('eileenfisher', 'Women', 'Tops & knits (alpha, RUNS LARGE)', ARRAY['hoodie']::text[]),
    ('eileenfisher', 'Women', 'Bottoms (alpha, RUNS LARGE)', ARRAY['jean']::text[]),
    ('uniqlo', 'Women', 'Tops (alpha, RUNS SMALL)', ARRAY['hoodie']::text[]),
    ('uniqlo', 'Men', 'Tops (alpha, RUNS SMALL)', ARRAY['hoodie']::text[]),
    ('bananarepublic', 'Women', 'Tops (alpha/numeric)', ARRAY['hoodie']::text[]),
    ('bananarepublic', 'Men', 'Tops (alpha)', ARRAY['hoodie']::text[]),
    ('woolrich', 'Men', 'Outerwear, tops & bottoms', ARRAY['hoodie']::text[]),
    ('woolrich', 'Women', 'Outerwear, tops & bottoms', ARRAY['blouse','hoodie','skirt']::text[]),
    ('offwhite', 'Unisex', 'Tops (alpha)', ARRAY['blouse']::text[]),
    ('chromehearts', 'Unisex', 'Tops (alpha)', ARRAY['blouse']::text[]),
    ('aimleondore', 'Unisex', 'Tops (alpha)', ARRAY['blouse']::text[]),
    ('gallerydept', 'Unisex', 'Tops (alpha)', ARRAY['blouse','sweater']::text[]),
    ('denimtears', 'Unisex', 'Bottoms (LEVI''S WAIST-SIZED)', ARRAY['short','skirt']::text[]),
    ('rhude', 'Unisex', 'Tops (alpha)', ARRAY['blouse','sweater']::text[]),
    ('sp5der', 'Unisex', 'Tops (alpha)', ARRAY['blouse','sweater']::text[]),
    ('hellstar', 'Unisex', 'Tops (alpha)', ARRAY['blouse','sweater']::text[]),
    ('antisocialsocialclub', 'Unisex', 'Tops (alpha)', ARRAY['blouse','sweater']::text[]),
    ('fila', 'Unisex', 'Tops (alpha)', ARRAY['blouse','sweater']::text[]),
    ('outdoorvoices', 'Women', 'Tops, dresses & bottoms (alpha)', ARRAY['blouse','jean','skirt','sweater']::text[]),
    ('girlfriendcollective', 'Women', 'Tops & bottoms (alpha XXS-6XL — the widest run in the KB)', ARRAY['blouse','jean','shirt','skirt','sweater']::text[]),
    ('zara', 'Women', 'Tops & dresses (EU numeric 34-42 / alpha)', ARRAY['hoodie']::text[]),
    ('anntaylor', 'Women', 'Tops & dresses (US numeric 00-18 — shared Ann Taylor / LOFT grade)', ARRAY['hoodie']::text[]),
    ('untuckit', 'Women', 'Tops, bottoms, outerwear & dresses (ALPHA XS-XL)', ARRAY['hoodie','skirt']::text[]),
    ('vineyardvines', 'Men', 'Tops (ALPHA XS-XXL — body measurements)', ARRAY['hoodie']::text[]),
    ('vineyardvines', 'Women', 'Tops & dresses (US numeric 00-24 + alpha XXS-3X)', ARRAY['hoodie']::text[]),
    ('faherty', 'Men', 'Tops (ALPHA XS-XXXL — body measurements)', ARRAY['hoodie']::text[]),
    ('faherty', 'Women', 'Tops & dresses (ALPHA XS-XL + US numeric 0-16)', ARRAY['hoodie']::text[]),
    ('filson', 'Men', 'Tops & outerwear (alpha, CHEST inches)', ARRAY['hoodie','sweater']::text[]),
    ('pendleton', 'Men', 'Wool shirts & tops (alpha, CHEST inches)', ARRAY['hoodie']::text[]),
    ('orvis', 'Men', 'Tops & outerwear (alpha, CHEST inches)', ARRAY['hoodie']::text[]),
    ('khl', 'Men', 'Apparel (US alpha tops; pants by WAIST inch)', ARRAY['bottom','jean','short','sweater']::text[]),
    ('canadagoose', 'Women', 'Tops & bottoms (Standard fit, body inches)', ARRAY['blouse','jean','skirt']::text[]),
    ('canadagoose', 'Men', 'Tops & bottoms (Standard fit, body inches)', ARRAY['jean']::text[]),
    ('champion', 'Men', 'Bottoms (alpha, body inches)', ARRAY['jean']::text[]),
    ('champion', 'Women', 'Bottoms (alpha/numeric, body inches)', ARRAY['jean']::text[]),
    ('denimtears', 'Unisex', 'Tops & outerwear (alpha — GARMENT FLAT specs, inches)', ARRAY['blouse']::text[]),
    ('uniqlo', 'Unisex', 'Bottoms (inch-sized — the number IS the waist)', ARRAY['skirt']::text[]),
    ('aimleondore', 'Unisex', 'Bottoms (system conversion only — no body measurements)', ARRAY['skirt']::text[]),
    ('arcteryx', 'Women', 'Bottoms, alpha (body inches)', ARRAY['skirt']::text[]),
    ('arcteryx', 'Women', 'Bottoms, US numeric (body inches)', ARRAY['skirt']::text[]),
    ('nike', 'Men', 'Bottoms (body inches)', ARRAY['jean']::text[]),
    ('nike', 'Women', 'Bottoms (body inches)', ARRAY['jean']::text[]),
    ('nike', 'Women', 'Bottoms, plus (body inches)', ARRAY['jean']::text[]),
    ('gallerydept', 'Unisex', 'Bottoms (GARMENT waist — the tag is 2in under it)', ARRAY['skirt']::text[]),
    ('reebok', 'Unisex', 'Bottoms (body inches)', ARRAY['jean','skirt']::text[]),
    ('woolrich', 'Women', 'Bottoms (INCH waist, not a body measurement)', ARRAY['skirt']::text[]),
    ('marmot', 'Women', 'Bottoms (alpha + US numeric)', ARRAY['skirt']::text[]),
    ('marmot', 'Women', 'Bottoms, plus (1X-3X)', ARRAY['skirt']::text[]),
    ('mountainhardwear', 'Men', 'Bottoms (alpha, with the pant-size tag in the label)', ARRAY['jean']::text[]),
    ('mountainhardwear', 'Women', 'Bottoms (alpha, with the US numeric tag in the label)', ARRAY['jean','skirt']::text[]),
    ('orvis', 'Women', 'Tops (alpha ↔ US numeric)', ARRAY['hoodie']::text[]),
    ('hellstar', 'Unisex', 'Bottoms (alpha, waist + inseam)', ARRAY['skirt']::text[]),
    ('sp5der', 'Unisex', 'Bottoms (FLAT garment specs, alpha)', ARRAY['skirt']::text[]),
    ('sp5der', 'Women', 'Bottoms (FLAT garment specs, alpha XS-L)', ARRAY['skirt']::text[]),
    ('frame', 'Women', 'Tops & outerwear (alpha ↔ US numeric, body inches)', ARRAY['hoodie']::text[]);

  select count(*) into missing
  from us3443_targets t
  where not exists (
    select 1 from public.brand_size_charts c
    where c.brand_key = t.brand_key and c.department = t.department
      and c.garment = t.garment);
  if missing > 0 then
    raise exception 'US-3443: % of % target chart rows are not in this database, so the pass did not land', missing, (select count(*) from us3443_targets);
  end if;

  select count(*) into covered
  from us3443_targets t
  join public.brand_size_charts c
    on c.brand_key = t.brand_key and c.department = t.department
   and c.garment = t.garment
  where t.words <@ c.category_match;
  if covered <> (select count(*) from us3443_targets) then
    raise exception 'US-3443: only % of % rows carry every word this migration adds', covered, (select count(*) from us3443_targets);
  end if;
  raise notice 'US-3443: % chart rows carry the added category words', covered;
end $$;

insert into public.applied_migrations (version) values ('00814') on conflict do nothing;
