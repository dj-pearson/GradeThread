-- US-2215: give brand_size_charts a size SYSTEM and a size CLASS.
--
-- GENERATED FILE — do not hand-edit. Regenerate with:
--   deno run --allow-read --allow-write scripts/gen-size-systems-migration.mjs
--
-- WHY: the chart shape had department and a free-text garment scope and nowhere
-- to record WHICH NATIONAL SYSTEM a size label is written in, so the corpus
-- encoded it inside the label itself — "UK 10 (US 6)", "IT 48 (US 38)",
-- "FR 36 (US 4)", "JP L (=US M)". 115 of 292 charts do this. Every one of
-- those parentheses is a workaround for a missing field.
--
-- The prose is KEPT. This migration adds the structured field beside it; it
-- does not rewrite a single size label or note, because those strings are what
-- the model actually reads and re-authoring 115 of them is a separate, riskier
-- change that deserves its own eval.
--
-- Values are DERIVED, not asserted: size-systems.ts:detectSizeSystem reads the
-- system off the labels only when they state it, and returns NULL otherwise. A
-- chart of bare numbers stays NULL because a bare "6" could be US or UK and
-- nothing in the row says which. NULL means "not recorded", never "US".
--
-- Derived here: 137 charts with a readable system, 0 non-standard size class,
-- 1 with an ambiguous class (a scope naming several — the Talbots case, whose
-- scope reads "Misses / Petite / Plus" and which is exactly the folding the
-- size_class column exists to end).
--
-- Risk: LOW. Two additive nullable text columns on a global reference table
-- with deny-all RLS, plus an UPDATE that only sets them. No tenant data, no
-- trigger, no view change. Idempotent and re-run safe.

alter table public.brand_size_charts
  add column if not exists size_system text;
alter table public.brand_size_charts
  add column if not exists size_class  text;

comment on column public.brand_size_charts.size_system is
  'US-2215 national system the size labels are written in (US|UK|EU|IT|FR|JP|AU|alpha). NULL = not recorded, NOT an implied US.';
comment on column public.brand_size_charts.size_class is
  'US-2215 extended size class (standard|plus|petite|tall|big_and_tall|maternity). NULL = the chart names several and cannot be reduced to one.';

update public.brand_size_charts AS t
   set size_system = v.size_system,
       size_class  = v.size_class,
       updated_at  = now()
  from (values
  ('aloyoga', 'Women', 'Bottoms (leggings / pants)', 'alpha', 'standard'),
  ('aloyoga', 'Women', 'Tops', 'alpha', 'standard'),
  ('aloyoga', 'Men', 'Tops', 'alpha', 'standard'),
  ('sweatybetty', 'Women', 'Bottoms (leggings / pants)', 'UK', 'standard'),
  ('sweatybetty', 'Women', 'Tops', 'UK', 'standard'),
  ('gymshark', 'Women', 'Bottoms (leggings / shorts)', 'alpha', 'standard'),
  ('gymshark', 'Women', 'Tops', 'alpha', 'standard'),
  ('vuori', 'Men', 'Bottoms (shorts / joggers)', 'alpha', 'standard'),
  ('vuori', 'Men', 'Tops', 'alpha', 'standard'),
  ('vuori', 'Women', 'Bottoms (leggings / shorts)', 'alpha', 'standard'),
  ('jcrew', 'Men', 'Shirts (alpha)', 'alpha', 'standard'),
  ('freepeople', 'Women', 'Tops & dresses (alpha)', 'alpha', 'standard'),
  ('lululemon', 'Men', 'Tops', 'alpha', 'standard'),
  ('nike', 'Men', 'Tops', 'alpha', 'standard'),
  ('nike', 'Women', 'Tops', 'alpha', 'standard'),
  ('athleta', 'Women', 'Tops', 'alpha', 'standard'),
  ('athleta', 'Women', 'Bottoms (leggings / pants)', 'alpha', 'standard'),
  ('wrangler', 'Unisex', 'Denim jackets (alpha)', 'alpha', 'standard'),
  ('lee', 'Unisex', 'Denim jackets (alpha)', 'alpha', 'standard'),
  ('diesel', 'Unisex', 'Denim jackets (alpha)', 'alpha', 'standard'),
  ('gstarraw', 'Unisex', 'Denim jackets (alpha)', 'alpha', 'standard'),
  ('columbia', 'Men', 'Tops', 'alpha', 'standard'),
  ('columbia', 'Women', 'Tops', 'alpha', 'standard'),
  ('arcteryx', 'Men', 'Tops', 'alpha', 'standard'),
  ('arcteryx', 'Women', 'Tops', 'alpha', 'standard'),
  ('marmot', 'Men', 'Tops', 'alpha', 'standard'),
  ('reicoop', 'Men', 'Tops', 'alpha', 'standard'),
  ('llbean', 'Men', 'Tops', 'alpha', 'standard'),
  ('mountainhardwear', 'Men', 'Tops', 'alpha', 'standard'),
  ('thenorthfacepatagoniaouterwear', 'Unisex', 'Outerwear / jackets (alpha)', 'alpha', 'standard'),
  ('chanel', 'Women', 'Jackets & tweed (FR sizing)', 'FR', 'standard'),
  ('chanel', 'Women', 'Dresses & tops (FR sizing)', 'FR', 'standard'),
  ('burberry', 'Women', 'Trench & outerwear (UK sizing)', 'UK', 'standard'),
  ('burberry', 'Men', 'Tailoring & outerwear (IT sizing)', 'IT', 'standard'),
  ('prada', 'Women', 'Ready-to-wear (IT sizing)', 'IT', 'standard'),
  ('prada', 'Men', 'Ready-to-wear (IT sizing)', 'IT', 'standard'),
  ('michaelkors', 'Women', 'Bottoms (US numeric)', 'US', 'standard'),
  ('katespade', 'Women', 'Dresses (US numeric)', 'US', 'standard'),
  ('toryburch', 'Women', 'Tops & dresses (US numeric)', 'US', 'standard'),
  ('toryburch', 'Women', 'Bottoms (US numeric)', 'US', 'standard'),
  ('supreme', 'Men', 'Tops (tees & hoodies, US alpha)', 'alpha', 'standard'),
  ('supreme', 'Men', 'Bottoms (US numeric waist)', 'US', 'standard'),
  ('stssy', 'Men', 'Tops (tees & fleece, US alpha)', 'alpha', 'standard'),
  ('bape', 'Men', 'Tops (JAPANESE sizing)', 'JP', 'standard'),
  ('kith', 'Men', 'Tops (tees & fleece, US alpha)', 'alpha', 'standard'),
  ('palace', 'Men', 'Tops (tees & fleece, US alpha)', 'alpha', 'standard'),
  ('anthropologie', 'Women', 'Bottoms (US numeric waist)', 'US', 'standard'),
  ('szane', 'Women', 'Tops & dresses (FRENCH sizing)', 'FR', 'standard'),
  ('aritzia', 'Women', 'Bottoms (US numeric waist)', 'US', 'standard'),
  ('reformation', 'Women', 'Dresses & tops (US numeric)', 'US', 'standard'),
  ('theory', 'Women', 'Bottoms (US numeric)', 'US', 'standard'),
  ('bananarepublic', 'Men', 'Tops (alpha)', 'alpha', 'standard'),
  ('abercrombiefitch', 'Men', 'Tops (alpha, cut SLIM)', 'alpha', 'standard'),
  ('tommyhilfiger', 'Men', 'Tops (alpha)', 'alpha', 'standard'),
  ('drmartens', 'Unisex', 'Footwear (UK-SIZED — the stamped number is a UK size)', 'UK', 'standard'),
  ('birkenstock', 'Unisex', 'Footwear (EU-SIZED ONLY — no US run exists)', 'EU', 'standard'),
  ('newbalance', 'Men', 'Footwear (US/UK/EU + WIDTH — D is STANDARD here)', 'US', 'standard'),
  ('newbalance', 'Women', 'Footwear (US/UK/EU + WIDTH — D is WIDE here)', 'US', 'standard'),
  ('converse', 'Unisex', 'Footwear (dual-tagged US M/W — offset TWO, RUNS LARGE)', 'US', 'standard'),
  ('vans', 'Unisex', 'Footwear (dual-tagged US M/W — offset ONE AND A HALF)', 'US', 'standard'),
  ('ugg', 'Women', 'Footwear (US/UK/EU — RUNS LARGE, whole sizes)', 'US', 'standard'),
  ('ugg', 'Men', 'Footwear (US/UK/EU — RUNS LARGE, whole sizes)', 'US', 'standard'),
  ('colehaan', 'Men', 'Footwear (US/UK/EU + width)', 'US', 'standard'),
  ('colehaan', 'Women', 'Footwear (US/UK/EU)', 'US', 'standard'),
  ('canadagoose', 'Men', 'Outerwear', 'alpha', 'standard'),
  ('canadagoose', 'Women', 'Outerwear', 'alpha', 'standard'),
  ('mackage', 'Men', 'Outerwear', 'alpha', 'standard'),
  ('mackage', 'Women', 'Outerwear', 'alpha', 'standard'),
  ('woolrich', 'Men', 'Outerwear & wool', 'alpha', 'standard'),
  ('woolrich', 'Women', 'Outerwear & wool', 'alpha', 'standard'),
  ('offwhite', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('chromehearts', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('aimleondore', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('gallerydept', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('rhude', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('sp5der', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('hellstar', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('antisocialsocialclub', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('genericwomensalpha', 'Women', 'Tops & dresses (alpha)', 'alpha', 'standard'),
  ('genericmensalpha', 'Men', 'Tops (alpha)', 'alpha', 'standard'),
  ('champion', 'Men', 'Tops (alpha — vintage runs BOXY)', 'alpha', 'standard'),
  ('champion', 'Women', 'Tops (alpha)', 'alpha', 'standard'),
  ('fila', 'Men', 'Footwear (US/UK/EU — the size is STAMPED, not measured)', 'US', 'standard'),
  ('fila', 'Women', 'Footwear (US/UK/EU — the size is STAMPED, not measured)', 'US', 'standard'),
  ('fila', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('puma', 'Men', 'Footwear (US/UK/EU — RUNS SMALL, size is STAMPED)', 'US', 'standard'),
  ('puma', 'Women', 'Footwear (US/UK/EU — RUNS SMALL, size is STAMPED)', 'US', 'standard'),
  ('puma', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('reebok', 'Men', 'Footwear (US/UK/EU — classics RUN LARGE, size is STAMPED)', 'US', 'standard'),
  ('reebok', 'Women', 'Footwear (US/UK/EU — classics RUN LARGE, size is STAMPED)', 'US', 'standard'),
  ('reebok', 'Unisex', 'Tops (alpha)', 'alpha', 'standard'),
  ('asics', 'Men', 'Footwear (US/UK/EU + width — RUNS SMALL AND NARROW)', 'US', 'standard'),
  ('asics', 'Women', 'Footwear (US/UK/EU + width — RUNS SMALL AND NARROW)', 'US', 'standard'),
  ('onrunning', 'Men', 'Footwear (US/UK/EU — RUNS SMALL AND NARROW)', 'US', 'standard'),
  ('onrunning', 'Women', 'Footwear (US/UK/EU — RUNS SMALL AND NARROW)', 'US', 'standard'),
  ('hoka', 'Men', 'Footwear (US/UK/EU — the size is STAMPED, not measured)', 'US', 'standard'),
  ('hoka', 'Women', 'Footwear (US/UK/EU — the size is STAMPED, not measured)', 'US', 'standard'),
  ('zara', 'Women', 'Bottoms (EU numeric 34-42 — an EU SIZE, never inches)', 'EU', 'standard'),
  ('zara', 'Women', 'Tops & dresses (EU numeric 34-42 / alpha)', 'EU', 'standard'),
  ('hm', 'Women', 'Bottoms (EU numeric 32-44 — an EU SIZE, never inches)', 'EU', 'standard'),
  ('hm', 'Women', 'Tops & dresses (EU numeric 32-44 / alpha)', 'EU', 'standard'),
  ('talbots', 'Women', 'Misses (US numeric 2-18) / Petite (0P-16P) / Plus (14W-26W)', NULL, NULL),
  ('untuckit', 'Men', 'Button-down shirts (ALPHA S-XXXL) — but dress shirts are NECK x SLEEVE, see note', 'alpha', 'standard'),
  ('untuckit', 'Women', 'Tops & dresses (ALPHA XS-XL)', 'alpha', 'standard'),
  ('johnnieo', 'Men', 'Tops (ALPHA S-XXXL — body measurements)', 'alpha', 'standard'),
  ('vineyardvines', 'Men', 'Tops (ALPHA XS-XXL — body measurements)', 'alpha', 'standard'),
  ('faherty', 'Men', 'Tops (ALPHA XS-XXXL — body measurements)', 'alpha', 'standard'),
  ('filson', 'Men', 'Tops & outerwear (alpha, CHEST inches)', 'alpha', 'standard'),
  ('redwing', 'Men', 'Boots (US men''s shoe size)', 'US', 'standard'),
  ('timberland', 'Men', 'Boots (US men''s shoe size)', 'US', 'standard'),
  ('pendleton', 'Men', 'Wool shirts & tops (alpha, CHEST inches)', 'alpha', 'standard'),
  ('barbour', 'Men', 'Waxed & quilted jackets (UK alpha / CHEST inches)', 'alpha', 'standard'),
  ('orvis', 'Men', 'Tops & outerwear (alpha, CHEST inches)', 'alpha', 'standard'),
  ('clarks', 'Unisex', 'Footwear (US/UK/EU + letter width fittings)', 'UK', 'standard'),
  ('merrell', 'Men', 'Footwear (US/UK/EU — hiking, the size is STAMPED)', 'US', 'standard'),
  ('merrell', 'Women', 'Footwear (US/UK/EU — hiking, the size is STAMPED)', 'US', 'standard'),
  ('keen', 'Men', 'Footwear (US/UK/EU — RUNS ROOMY, the size is STAMPED)', 'US', 'standard'),
  ('keen', 'Women', 'Footwear (US/UK/EU — RUNS ROOMY, the size is STAMPED)', 'US', 'standard'),
  ('sorel', 'Women', 'Footwear (US/UK/EU — winter boots, the size is STAMPED)', 'US', 'standard'),
  ('sorel', 'Men', 'Footwear (US/UK/EU — winter boots, the size is STAMPED)', 'US', 'standard'),
  ('brooks', 'Men', 'Footwear (US/UK/EU — running, the size is STAMPED)', 'US', 'standard'),
  ('brooks', 'Women', 'Footwear (US/UK/EU — running, the size is STAMPED)', 'US', 'standard'),
  ('saucony', 'Men', 'Footwear (US/UK/EU — running, the size is STAMPED)', 'US', 'standard'),
  ('saucony', 'Women', 'Footwear (US/UK/EU — running, the size is STAMPED)', 'US', 'standard'),
  ('stevemadden', 'Women', 'Footwear (US/UK/EU — women''s fashion, the size is STAMPED)', 'US', 'standard'),
  ('samedelman', 'Women', 'Footwear (US/UK/EU — women''s fashion, the size is STAMPED)', 'US', 'standard'),
  ('allenedmonds', 'Men', 'Footwear (US/UK/EU + width — dress, the size is STAMPED)', 'US', 'standard'),
  ('victoriassecret', 'Women', 'Panties / apparel (alpha XS-XL, body inches)', 'alpha', 'standard'),
  ('pink', 'Women', 'Loungewear / apparel (alpha XS-XL, body inches)', 'alpha', 'standard'),
  ('aerie', 'Women', 'Apparel / leggings / bralettes (alpha XXS-XXL, body inches)', 'alpha', 'standard'),
  ('calvinklein', 'Women', 'Bras / bralettes / undies (alpha XS-XL, body inches)', 'alpha', 'standard'),
  ('salomon', 'Men', 'Footwear (US/UK/EU — trail/hiking, the size is STAMPED)', 'US', 'standard'),
  ('salomon', 'Women', 'Footwear (US/UK/EU — trail/hiking, the size is STAMPED)', 'US', 'standard'),
  ('cotopaxi', 'Men', 'Apparel (US alpha, body inches)', 'alpha', 'standard'),
  ('cotopaxi', 'Women', 'Apparel (US alpha, body inches)', 'alpha', 'standard'),
  ('khl', 'Women', 'Apparel (US alpha, body inches)', 'alpha', 'standard'),
  ('outdoorresearch', 'Men', 'Apparel (US alpha, body inches)', 'alpha', 'standard'),
  ('outdoorresearch', 'Women', 'Apparel (US alpha, body inches)', 'alpha', 'standard')
  ) AS v(brand_key, department, garment, size_system, size_class)
 where t.brand_key  = v.brand_key
   and t.department = v.department
   and t.garment    = v.garment;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00499') on conflict do nothing;
