-- US-3125: give 2184 more colorways an eBay colour bucket.
--
-- THE OWNER'S BRIEF, in their words: "Coffee Bean for 7 For All Mankind is a
-- brown... Optical White is in the Title and Description but then translates to
-- White in the eBay Color". A colorway has to carry both names -- the brand's,
-- which is what a buyer searches, and eBay's, which is what the item specific
-- will accept.
--
-- 00737 built that split and resolved what the existing table could. 00738
-- filled more from the brands' own facet tags. What was left was 6004 rows
-- whose names no table knew: Kalamata, Coffee Bean, Anthracite, Sandstone, Oat.
-- House vocabulary.
--
-- -- THE FIX IS IN THE CODE, NOT IN THIS FILE --------------------------------
--
-- The obvious move was a lookup table inside this migration. That would have
-- been wrong. 00737 established that base_color comes from
-- services/edge-functions/src/lib/aspect-normalize.ts precisely so the KB and
-- the live normaliser CANNOT DISAGREE -- a colour resolved one way when seeding
-- and another way when publishing is a bug that only shows up on a listing.
--
-- So the vocabulary was added to COLOR_FAMILY in that file instead, and this
-- migration re-derives through it. The listing path gets the same benefit at
-- the same moment: a garment the AI describes as "Espresso" now normalises to
-- Brown when eBay asks for a Color, whether or not the brand is in this KB.
-- The web copy at src/lib/aspect-normalize.ts is patched identically.
--
-- -- HOW THE WORDS WERE CHOSEN ----------------------------------------------
--
-- Counted, not brainstormed. Every candidate was measured across the 6004
-- unresolved names first, and what earned a place is what several brands use
-- INDEPENDENTLY -- "coffee" in 21 brands, "orchid" in 29, "heather" in 48. A
-- word one brand uses once is a per-brand fact and belongs in brand_colorways,
-- not in a table shared by every listing.
--
-- ⚠ SEVEN FREQUENT WORDS WERE DELIBERATELY LEFT OUT: ice, garden, wild,
-- vintage, clear, sea and mist. Each is ambiguous alone -- "Ice Blue" is blue,
-- bare "Ice" is white-ish; "Sea Salt" is off-white and "Sea Green" is green.
-- The resolver reads right-to-left and takes the LAST colour-bearing token, so
-- omitting a modifier lets the real colour win. Adding it makes the modifier
-- win, which is worse than the NULL it replaces.
--
-- -- RESULT ------------------------------------------------------------------
--
-- 2184 of 6004 resolved (36%). Buckets:
-- Multicolor 457, Brown 330, Gray 324, Blue 247, Green 182, Beige 182, Black 108, Red 105, Purple 82, White 78, Pink 45, Gold 13, Orange 12, Ivory 11, Yellow 8.
--
-- 3820 still resolve to nothing and stay NULL, which remains the
-- correct answer rather than a guess: 104 of them did pick up a SHADE
-- (a "Dark" or "Light" in the name) with no colour to attach it to.
--
-- Worst remaining: frame (138), kith (128), thursdayboots (117), rothys (109), americangiant (105), warpweft (101), dakine (96), rails (93).
-- Sample: Titan, Assortment, Bering Sea, Bungee Cord, Celestial, Cement, Clearwater, Naval, OG Bottomland, Pelican, Splish Splash, Cordovan, Kalamata, Naval Academy, PRISTINE, AFFECTION SMALL, ALMOND, ALWAYS FOREVER MULTI, ANTIQUE SCROLL, APPLE, AZURE, BE STILL, BISCOTTI, BLK MULTI.
--
-- These are single-brand house names with no shared vocabulary to exploit, and
-- a per-brand decoder is the only thing that would move them. Only rows where
-- base_color IS NULL are touched, so nothing earlier is overwritten and a
-- re-run changes nothing.

do $$
begin
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Athletic Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Azure Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Bay Leaf Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Bering Sea Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Corsair Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'aftco' and color_name = 'Dark Sea Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Dusk Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'aftco' and color_name = 'Midnight Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Splish Splash Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aftco' and color_name = 'Steel Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'JAZZ BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR JAZZ BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'aimleondore' and color_name = 'Coconut Milk' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'aimleondore' and color_name = 'Coffee Bean' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'aimleondore' and color_name = 'MID WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'aimleondore' and color_name = 'Pine Grove' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'AMERICANA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'ATRIUM FLORAL SM' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'AVOCADO' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'BASIL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'BEACH DAY STRIPE SM' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'BOUNDLESS PAISLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'BOYSENBERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'BRIGHT POPPY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'CAMO GIRL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'CHAMBRAY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'CHERI FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'CHILI PEPPER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'CINNAMON' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'aliceandolivia' and color_name = 'DARK FERN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'aliceandolivia' and color_name = 'DARK RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'DAWN FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'DREAM FLORAL ROYALTY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'ERIKA WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'ESSENTIAL FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'FANCY FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'FLORAL FEST' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'FLORAL RADIANCE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'GARDEN FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'GARNET' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'GEORGIA FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'GOLDEN COAST' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'GOLDEN HOUR' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'GOLDEN ROD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'HAMPTONS FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'HIGH TEA FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'HRLOM STRIPE CROLNA BLU/GRN AP' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'IN THE WIND FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'LATTE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'LUNA FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'MORNINGSIDE FLORAL PISTACHIO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'OCEAN FLOOR' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'PAPRIKA' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'PERFECT POPPY' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'PETAL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'PISTACHIO' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'POPPY' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'RASPBERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'ROYAL LEOPARD SM' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'ROYALTY PAISLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'SPICE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'SPOTTED LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'SPOTTED LEOPARD MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'STORM FLORAL SM' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'SUMMER POPPY' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'SWEET PEONY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'aliceandolivia' and color_name = 'VENUS FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'allbirds' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'allbirds' and color_name = 'Blizzard/Hazy Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'allbirds' and color_name = 'Hazy Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'allbirds' and color_name = 'Mushroom' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'allbirds' and color_name = 'Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'allbirds' and color_name = 'Sunny Marigold' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'allbirds' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'almondsurf' and color_name = 'Kelp' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'aloyoga' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'altra' and color_name = 'Dark Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'altra' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'altra' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Aloe Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Athletic Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Athletic Heather Monument' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'americangiant' and color_name = 'Atlantic Deep' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Beauty Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Boysenberry' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Buckwheat Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Burnt Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Canyon Clay Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Cast Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Cattleya Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Chicory Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Cinnamon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Cocoa Creme' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Coffee Quartz' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Cork Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'americangiant' and color_name = 'Dark Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'americangiant' and color_name = 'Dark Vintage Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Dill Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Golden Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Golden Palm' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Holly Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Hydro Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Loden' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Maritime Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'americangiant' and color_name = 'Medium Vintage Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'americangiant' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Mineral Wash Pomegranate' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Morning Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Mulled Basil' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Ocean Cavern' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Oxblood Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Pine Bark' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Pomegranate' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Pomegranate Spellbound' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Potting Soil' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Quiet Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'americangiant' and color_name = 'Rinse Dark Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Silent Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Silent Storm Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Smoked Paprika' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Stealth Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Straw' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Sweet Grape' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Syrah Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Tea Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Tiger Lily' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Tiramisu Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Turkish Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Very Grape' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'americangiant' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'CACTUS' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'COCONUT MILK' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'CYPRESS' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'JUNIPER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'MINERAL MOONLIT OCEAN' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'PINE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'POOLSIDE PAISLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'SPOTTED LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'SUNSET PAISLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'THYME' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'WISTERIA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'away' and color_name = 'Tide Line Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Cheetah' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Cloud Dancer' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Desert Baddies' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Double Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Frosty Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Frosty Petal Sleeveless' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Light')
   where brand_key = 'badbirdie' and color_name = 'Light Clay' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Salt Shaker' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'badbirdie' and color_name = 'Super Duper Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'baleaf' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'baleaf' and color_name = 'Cocoa Crème' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'baleaf' and color_name = 'Weathered Teak' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Coffee Bean' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Growing Grid - Lagoon / Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Growing Grid - Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Growing Grid - Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Lagoon / Copal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Lagoon Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Mist / Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Orchid Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Orchid Bloom Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Plaster / Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Poppy / Azalea' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Poppy Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Steel Horizon' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Uneven Gradient - Lagoon / Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Uneven Gradient - Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'banditrunning' and color_name = 'Uneven Gradient - Poppy Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'bape' and color_name = '1st Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'bape' and color_name = 'ABC Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'bape' and color_name = 'City Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'bape' and color_name = 'Woodland Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Coal' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'bearbottom' and color_name = 'Dark Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Flint' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'bearbottom' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'beyondclothing' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Berry Bliss Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Birch Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Bright Citrus Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Brilliant Blackberry Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Dreamsicle Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Dusk Basil' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Fresh Snow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Legacy Pine Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Malibu Lagoon Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Mushroom' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Pomegranate Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Sangria Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Storm Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'beyondyoga' and color_name = 'Woodland Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'bigbudpress' and color_name = 'Dark Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'bigbudpress' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'bigbudpress' and color_name = 'Faded Grape' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'bigbudpress' and color_name = 'Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'bigbudpress' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'bigbudpress' and color_name = 'Paprika' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'billabong' and color_name = 'DEEP LAGOON' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'billabong' and color_name = 'DOVE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Cloud Break' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'birddogs' and color_name = 'Midnight Static Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Night Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Roasted Bean Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Stonewash Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Subzero Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Waverunner Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Weekend Tally Zebra' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'birddogs' and color_name = 'Whistle Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birdwell' and color_name = 'Woodland Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'ALMOND DREAMY FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'BRIGHT MARTINI DREAMY FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'CACTUS' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'CAFÉ NOIR' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'EUCALYPTUS WHIMSICAL BLOOMS' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'FIG' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'GUAVA' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'HAZELNUT MOODY BLOOMS' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'MARIGOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'MATCHA' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'ORCHID' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Light')
   where brand_key = 'birdygrey' and color_name = 'PALE PISTACHIO' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'PISTACHIO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'PISTACHIO GARDEN BLOOM' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'PRESSED FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'SPICE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'THYME' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'THYME DREAMY FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'TWILIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'birdygrey' and color_name = 'WISTERIA' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Flax' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Glacier' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Mushroom' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'blackdiamond' and color_name = 'Nickel Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'bodyglove' and color_name = 'Bubble Gum' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'bodyglove' and color_name = 'Cactus' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'bodyglove' and color_name = 'Iris' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'bodyglove' and color_name = 'Latte' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'bodyglove' and color_name = 'Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'bodyglove' and color_name = 'Snow' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'bosca' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brahmin' and color_name = 'Driftwood Melbourne' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brahmin' and color_name = 'Latte San Lorenzo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brahmin' and color_name = 'Pecan Melbourne' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'BB Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Desert Tiger Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Golden Hour/Coco' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Honey/Lion' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Italian Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Italian Clay Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'brixton' and color_name = 'Medium Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'brixton' and color_name = 'Medium Wash Chambrey' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Moonlit Ocean/Bison/Mojave' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Multi Blanket Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Multi Neutral Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Multi Racing Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Multi Retro Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Multi Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Ocean Breeze' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Tree Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'brixton' and color_name = 'Two Boot Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'burberry' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Bluestone' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Cyanotype Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Desert Rock' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Floral Blur' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Graffiti Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Iris Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Keel Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Paint Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Pop Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Seersucker Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Shockwave Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Very Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'burton' and color_name = 'Wildcat Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Animal' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Cloud Dancer' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Coffee Bean' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'carbon38' and color_name = 'Dark Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'carbon38' and color_name = 'Deep Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Fig Toile' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'LATTE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Leopard Print' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'carbon38' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Moonbeam Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'NOIR' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Ponderosa Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Quiet Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Snow Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carbon38' and color_name = 'Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Birch Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Biscuit' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Bloom Texture' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Captain Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud Mezcal' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud Multifloral' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud Taj' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud Texture' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cloud Wildflower' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'carvedesigns' and color_name = 'Dark Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Folk Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Golden' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Golden Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'carvedesigns' and color_name = 'Light Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Melon Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Teak' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'carvedesigns' and color_name = 'Zinnia Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'christydawn' and color_name = 'Alabaster' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'christydawn' and color_name = 'Dotted Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'christydawn' and color_name = 'Noir Daisy' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'christydawn' and color_name = 'Oak Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'christydawn' and color_name = 'Spring Mushroom Medley' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'christydawn' and color_name = 'Vintage Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'christydawn' and color_name = 'Wild Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'citizensofhumanity' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'citizensofhumanity' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'citizensofhumanity' and color_name = 'Inky Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'citizensofhumanity' and color_name = 'Juniper' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'coalheadwear' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'colehaan' and color_name = 'Golden Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'colehaan' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'colorfulstandard' and color_name = 'Faded Grape' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'colorfulstandard' and color_name = 'Snow Melange' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'corridornyc' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'corridornyc' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Carbon Stripes' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Chalk/Mineral' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'cotopaxi' and color_name = 'Deep Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Honeycomb' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Ink Stripes' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Juniper' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'cotopaxi' and color_name = 'Juniper/Deep Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Live Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Nutmeg' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Orchid Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Sepia' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Spruce' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cotopaxi' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Alabaster' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Ballet' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Brook Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Classic Stripe in Dew' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Classic Stripe in Laurel' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Classic Stripe in Pacific' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Clover' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Coal Heather' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Coconut and Sandalwood Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Dew Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Garden Toile in Sea Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Harbor Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Heathered Harbor Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Market Stripe in Cinnamon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Mulberry Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Obsidian' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Obsidian Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Pacific Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Peony' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'River and Sea Salt Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Sailor Mini Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Sea Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Spruce/Eclipse' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'cozyearth' and color_name = 'Sunset Mini Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Bluestone' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Canyon Stripe Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Coal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Glacier' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Iron Horse' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'criquet' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'criquet' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'criquet' and color_name = 'Midnight Toker' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'criquet' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'cultgaia' and color_name = 'DOVE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = '8 Bit Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Aloha Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Ashcroft Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Bracken Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Carbon Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Cascade Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Classic Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Crescent Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Cypress' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Dark')
   where brand_key = 'dakine' and color_name = 'Dark Ashcroft Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Dawn To Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Earth Topo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Eucalyptus Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Faded Grape' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Flare Acid Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Full Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Golden Glow' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Grape Vine' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Haiku Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Juniper' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Kelp Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'dakine' and color_name = 'Midnight Blooms' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Misty Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Mojave Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Mulled Basil' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Mushroom Wonderland' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Muted Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Petal Maze' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Poppy Griffin' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Poppy Iceberg' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'dakine' and color_name = 'Poppy Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Solstice Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Sunset Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Tandoori Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Tiger Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Tropic Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Twilight Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Vintage Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'dakine' and color_name = 'Woodland Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'denimtears' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'dickies' and color_name = 'Eucalyptus (L44)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'diesel' and color_name = 'Dark Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'districtvision' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'districtvision' and color_name = 'Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'districtvision' and color_name = 'Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'districtvision' and color_name = 'Linen' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'districtvision' and color_name = 'Spruce' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'districtvision' and color_name = 'Umber' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Bubble Gum' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Clementine' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Cranberry' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Marine' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Mushroom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Persimmon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'dooneybourke' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Blaze/Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Heather Clear Skies' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Pin Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Pin Oak / Wetland' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Pin Oak/Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Raven' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Raven/Woodland' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duckcamp' and color_name = 'Wheat/Blaze' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'duer' and color_name = 'Dark Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Eucalyptus' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Light')
   where brand_key = 'duer' and color_name = 'Evergreen/Light Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Garment Dye Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Glacier' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Heather Peat' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Kelp' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Light')
   where brand_key = 'duer' and color_name = 'Light Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'London Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Marine Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'duer' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Ocean Swell' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Stout Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Thyme Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Washed Glacier' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'duer' and color_name = 'Washed Kelp' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'edikted' and color_name = 'LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'elizabethsuzann' and color_name = 'Flax' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'elizabethsuzann' and color_name = 'Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'elizabethsuzann' and color_name = 'Umber' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Acorn' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Bubblegum' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Canvas' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Coal' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Cocoa Tiger Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Coffee Bean' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Cornstalk Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'everlane' and color_name = 'Dark Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'everlane' and color_name = 'Deep Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'everlane' and color_name = 'Deep Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Elm Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Eucalyptus' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Fennel Seed Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Goji Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Golden Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Golden Palm' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heather Beech' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heather Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heathered Canvas' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heathered Fudge' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heathered Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heathered Soot' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heathered Toasted Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heather Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Heather Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Honey Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Iced Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Iced Coffee Grid' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Lily Pad' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Moonlit Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Ocean Cavern' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Parchment' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Pomegranate' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Salt Lake' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Snow' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Toasted Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'everlane' and color_name = 'Tungsten Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'faherty' and color_name = 'Deepwater Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'faherty' and color_name = 'Granite Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Banner Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Beach Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Beach Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Beachwood Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Beachwood Waffle Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'fairharbor' and color_name = 'Deep Sea Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Dusk Diamonds' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Fair Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'fairharbor' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Marina Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Maritime Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Nautical Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Oak Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Ocean Tie-Dye' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Ocean Wave' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Plaid Crabs' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Sandbar Waffle Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Shell Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'fairharbor' and color_name = 'Sunset Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'faithfullthebrand' and color_name = 'MILK' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'faithfullthebrand' and color_name = 'PERLA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'faithfullthebrand' and color_name = 'SIFNOS STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'faithfullthebrand' and color_name = 'VALENCIA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'farmrio' and color_name = 'ANIMAL' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Concrete Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Dune Pearl' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Faded Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Homestead Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Seal Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Warm Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'fearofgod' and color_name = 'Washed Seal Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'fearofgodessentials' and color_name = 'Concrete' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'fearofgodessentials' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'feetures' and color_name = 'Glacier Mist Mix' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'feetures' and color_name = 'Wild Bloom Mix' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'filson' and color_name = 'Raven' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'filson' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'filson' and color_name = 'Tundra Shrub Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'filson' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'firstlite' and color_name = 'Athletic Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'firstlite' and color_name = 'Dry Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'firstlite' and color_name = 'Military Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'firstlite' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'flylow' and color_name = 'Currant' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'flylow' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'flylow' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'flylow' and color_name = 'Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'flylow' and color_name = 'Leaf/Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'flylow' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'flylow' and color_name = 'Ocean/Abyss' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Bleached Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Canvas Abstract Flower' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Carnation Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Clay Cast Print' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Clay Chunky Cord' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Clay Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Clay Mix' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Heavy Bleach Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Marigold Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'folkclothing' and color_name = 'Midnight Mix' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, 'Dark')
   where brand_key = 'folkclothing' and color_name = 'Midnight Slub Linen' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Monochrome Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Multistitch Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Light')
   where brand_key = 'folkclothing' and color_name = 'Pale Ticking Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'folkclothing' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'foraygolf' and color_name = 'Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Antique Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'BLANC' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Bubble Gum' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Currant' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Dune Oxide' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Flax' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Flax Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Frost Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Garnet Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Glossy Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Light')
   where brand_key = 'frame' and color_name = 'Light Leopard Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'NOIR' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'PAPRIKA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'SADDLE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'SHEEN NOIR' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, 'Light')
   where brand_key = 'frame' and color_name = 'Soft Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Light')
   where brand_key = 'frame' and color_name = 'Soft Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'THYME' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'TRUFFLE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'WHISKEY' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'frame' and color_name = 'Wisteria' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'frankandeileen' and color_name = '1968 Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'frankandeileen' and color_name = '1984 Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'frankandeileen' and color_name = '1999 Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'frankandeileen' and color_name = 'Marine' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'frankandeileen' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'frankandeileen' and color_name = 'Yacht Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Bluestone' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Floral Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'French Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Heather Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Heather Sea Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Ocean Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Sea Pine' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Sea Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Storm Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Vintage Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'freefly' and color_name = 'Woodland Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'goodamerican' and color_name = 'CAFE CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'goodamerican' and color_name = 'FIG007' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'goorinbros' and color_name = 'BISCUIT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'goorinbros' and color_name = 'Camouflage' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'goorinbros' and color_name = 'DUST' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'goorinbros' and color_name = 'DUST / VOID' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'goorinbros' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'ANTHRACITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'ARCTIC' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'BLOOM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'BLUESTONE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'CLAY HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'CLAY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'DOVE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'greysonclothiers' and color_name = 'MIDNIGHT MALTESE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'SHADOW' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'greysonclothiers' and color_name = 'SUNRISE/ARCTIC' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'grundens' and color_name = 'Athletic Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'grundens' and color_name = 'Loden' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'grundens' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'halfdays' and color_name = 'Oat Milk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'halfdays' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'halfdays' and color_name = 'Spiked Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'harperwilde' and color_name = 'Cinnamon' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'harperwilde' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'harperwilde' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'hatchcollection' and color_name = 'Oat Melange' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'herms' and color_name = 'Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Light')
   where brand_key = 'herschelsupplyco' and color_name = 'Digi Leopard Light' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'herschelsupplyco' and color_name = 'Eucalyptus' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'herschelsupplyco' and color_name = 'Grid Naval Academy/Magnet' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'herschelsupplyco' and color_name = 'Raven Crosshatch' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'herschelsupplyco' and color_name = 'Realtree APX™ Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'herschelsupplyco' and color_name = 'Woodland Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'herschelsupplyco' and color_name = 'Zebra' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'hillhouse' and color_name = 'Berry Paisley Scarf' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'hillhouse' and color_name = 'Camo Fish' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'hillhouse' and color_name = 'Cornflower Ditsy Thistle' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'hillhouse' and color_name = 'Lagoon Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'hillhouse' and color_name = 'Peony Chintz' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'hillhouse' and color_name = 'Poppy Damask Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'hillhouse' and color_name = 'Sunset Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Arctic' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Bolan Classic Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'howlerbrothers' and color_name = 'Bouquets : Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Canyon Distortion : Earth' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Cohen Plaid : Stargazer' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Eyelet Stripe : Cadet' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'howlerbrothers' and color_name = 'Garth Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Grice Plaid : Hayride' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Honey Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Isley Plaid : Hemp' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Kempton Plaid : Stargazer' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Kent Plaid : Tradewinds' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Lily Negatives' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Los Longhorns Stripe : Riverbed Oxford' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Mega Plaid : Petrol' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Merle Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'howlerbrothers' and color_name = 'Mesa Plaid : Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'howlerbrothers' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Ocean Dip' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Ocean Motion : Oil Slick' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Ocean Motion : Shimmer' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Old Bill Stripe : Limestone' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Old Bill Stripe : Otter' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Owens Oaker Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Parrot Patrol : Dune Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Pathway Stripe : Dawn' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Pathway Stripe : Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Pine Needle' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Putty' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Ripples : Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'howlerbrothers' and color_name = 'Seersucker : Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Supernova Stripe : Leche' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'howlerbrothers' and color_name = 'Tropic Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'huf' and color_name = 'Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'huf' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Anchor Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Coastal Drift Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'huk' and color_name = 'Dark Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Egret Tideloom Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Harbor Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Mossy Oak Bottomland' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Mossy Oak Regatta' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Mossy Oak Seagrass' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Mossy Oak Seagull' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'North Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'River Rock Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Seagull Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Sea Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Sea Storm Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Sharkskin Estuary Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Sharkskin Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'huk' and color_name = 'Starfish Tideloom Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'AQUIFER HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Floral Chamomile' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Iron Ore' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Obsidian' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'hurley' and color_name = 'Seashore Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'ibex' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'ibex' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, 'Dark')
   where brand_key = 'icebreaker' and color_name = 'Dark Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'icebreaker' and color_name = 'Dark Loden' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'icebreaker' and color_name = 'Gritstone Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'icebreaker' and color_name = 'Metro Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'icebreaker' and color_name = 'Obsidian' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'ingridandisabel' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'ingridandisabel' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'ironheart' and color_name = 'Flamingo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ironheart' and color_name = 'Frogskin Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ironheart' and color_name = 'NWU Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'ironheart' and color_name = 'Texture Matte Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ironheart' and color_name = 'Tiger Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ironheart' and color_name = 'Woodland Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ironheart' and color_name = 'Woodlands Camouflage' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'jaanuu' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'jaanuu' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'jaanuu' and color_name = 'Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'jaanuu' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'jaanuu' and color_name = 'Wild Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'janji' and color_name = 'Arctic' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'janji' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'janji' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'janji' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'jetty' and color_name = 'Athletic Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'jetty' and color_name = 'Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'jetty' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'jetty' and color_name = 'Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'jetty' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'jetty' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'jetty' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'jkboots' and color_name = 'Bison Pebbled/Rough Leather' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'jkboots' and color_name = 'Coal' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'jkboots' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'jkboots' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'CHALK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'COCONUT MILK' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'COFFEE BEAN' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'FLAX' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'MACCHIATO GINGHAM' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'MILK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'SEA SALT' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'TEA LEAF' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'joesjeans' and color_name = 'WHISKEY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'johnnieo' and color_name = 'Coal' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'jonessnowboards' and color_name = 'Peak Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'jungmaven' and color_name = 'Coffee Bean' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'jungmaven' and color_name = 'Oat Milk' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'jungmaven' and color_name = 'Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'jungmaven' and color_name = 'Wisteria' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kancan' and color_name = 'Acid Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'kancan' and color_name = 'Dark Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'kancan' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'kancan' and color_name = 'Medium Dark Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'kancan' and color_name = 'Medium Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'kancan' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'kancan' and color_name = 'Super Dark Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kangol' and color_name = 'Cocoa Powder' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kangol' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Clover Vintage Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'French Roast Vintage Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Lead Vintage Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'katin' and color_name = 'Midnight Tide' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Pelican Vintage Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Sea Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'katin' and color_name = 'Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Alloy/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Atmosphere Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Brindle' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Cabbage' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Chipmunk' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Cork' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Curry' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Daffodil' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Birch/Dark Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Huckleberry' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Lily Pad' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Naval Academy' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Roasted Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch/Safari' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Birch Smooth Lea' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Bison/Beaujolais' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Bison/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Bison/Brindle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Bison/Huckleberry' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Bison/Mulch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Bison/Safari' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Blk Raven Paisley' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Brindle/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Brindle/Dark Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Canteen/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Checkered Mohair/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Chipmunk/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Chipmunk/Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Chipmunk/Dark Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Cork/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth/Chipmunk' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth/Dark Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth/Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth/Mulch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth/Roasted Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Dark Earth Velour' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Fig/Lilas' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Grenadine/Ocean Depths' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Huckleberry/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'keen' and color_name = 'Java/Dark Earth' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Lily Pad' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Lily Pad/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Magnet/Evening Primrose' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Magnet/Gum' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Monochrome/Lily Pad' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Naval Academy/Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Safari/Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Scarab/Arctic' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Sea Turtle/Roasted Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Terrain Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'keen' and color_name = 'Tri-Block Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'kerrits' and color_name = 'BERRY BLAST' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'kerrits' and color_name = 'BERRY BRUSHSTROKES' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kerrits' and color_name = 'CARBON' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'kerrits' and color_name = 'JASPER HORSESHOE HONEYCOMB' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kerrits' and color_name = 'PINE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kimesranch' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'kimesranch' and color_name = 'Dark Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'kimesranch' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'kimesranch' and color_name = 'Mid Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kimesranch' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kimesranch' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Alabaster' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Aurora / Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Blooming Heirloom Ditsy' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Cactus' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Canvas' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Cheetah Patch' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Clementine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Concrete' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Concrete Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Cypress' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, 'Dark')
   where brand_key = 'kith' and color_name = 'Dark Dust' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Dust' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'kith' and color_name = 'Eira Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Grease / Milk' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Greige' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Guava Eco' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Honey Bug' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Juniper' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Laila Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Lily' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Magnet' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'kith' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'kith' and color_name = 'Midnight Wishes' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Night Iris' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Obsidian' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Ocean Dip' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Sea Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Soot' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Spring Juniper' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Spring Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Straw' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Vintage Cheetah' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kith' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Berry Blossom/Polka Dot Patch/Strawberry Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Cheetah Print' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Cypress' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, 'Dark')
   where brand_key = 'knix' and color_name = 'Deep Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Ditsy Blossom' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Ditsy Blossom/Bluebell/Cosmo' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Electric Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Eucalyptus' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Ivy Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Jasmine Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'knix' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Nautical Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Poppy Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'knix' and color_name = 'Seaside Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Biscuit' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Candy Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'komodo' and color_name = 'Dark Marine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Linen Shirt Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'komodo' and color_name = 'Mid Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Mushroom Crossstich' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Oat Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Organic Cotton Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'komodo' and color_name = 'Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Arctic Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Ballet' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Battleship Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Bourbon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Buckbrush Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Cast Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Cedar Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'kuiu' and color_name = 'Dark Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'kuiu' and color_name = 'Dark Iron Tonal' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Dune Gritstone' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Dusk Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Evergreen Chest Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Evergreen Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Flint' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Fog Topo Print' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Glacier Topo Print' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Granite Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Gravel Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Grizzly Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Heather Buckbrush' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Heather Resin' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Lake Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'kuiu' and color_name = 'Midnight Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Saddle Blockline' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Saddle Trio' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Shadow Blockline' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Tempest Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Valo-Bourbon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Valo Check Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Valo Crosscheck Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Valo Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Verde' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Verde Check Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Verde Crosscheck Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Verde Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Vias Check Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Vias Crosscheck Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Vias Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Vias Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kuiu' and color_name = 'Woodsmoke Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Basil' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Currant' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Latte' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'kytebaby' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Dark')
   where brand_key = 'kytebaby' and color_name = 'Midnight Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'kytebaby' and color_name = 'Midnight Wildflower' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Peony' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Small Mist Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Small Sakura Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Snow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Thistle Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'kytebaby' and color_name = 'Toile Ballet' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'linksoul' and color_name = 'agave heather' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'linksoul' and color_name = 'midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'linksoul' and color_name = 'midnight heather' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'linksoul' and color_name = 'mushroom' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'loandsons' and color_name = 'Cabernet - Eco Friendly Canvas' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'loandsons' and color_name = 'Leaf Print - Tyvek' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'loandsons' and color_name = 'Thistle - Eco Friendly Canvas' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'longchamp' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Ditsy' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Dusty Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Heavy Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Hibiscus Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Leaf It To Me' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Sail Along Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'lspace' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'lunya' and color_name = 'Napping Dove Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Camouflage Print' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Carbon Mix' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Guava' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Muted Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Papaya' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mackage' and color_name = 'Umber' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Basil' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Cactus' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Clear Day Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, 'Dark')
   where brand_key = 'mackweldon' and color_name = 'Dark Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Desert Spring' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Fig Pudding' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Froth Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Gulfstream Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Ice Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Ice Storm Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Lambrusco Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Latte Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'mackweldon' and color_name = 'Midnight Pine Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Minted Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Mission Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Moonlighting Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Nomad Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Porcelain Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Rum Raisin Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Seaplane Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mackweldon' and color_name = 'Tannenbaum Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'madewell' and color_name = 'Lunar Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'malbongolf' and color_name = 'BARK CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'malbongolf' and color_name = 'MIDNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'manduka' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'India Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'marinelayer' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Marigold Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'marinelayer' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'North Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'marinelayer' and color_name = 'Soft Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Twilight' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'marinelayer' and color_name = 'Warm Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'medelita' and color_name = 'Wrought Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Abstract Zebra Print' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Basil' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Floral Ditsy Print' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Houndstooth' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Koi Orchid Print' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Latte' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Leopard Print' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Nutmeg' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Oat Marle' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Pomegranate' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'meshki' and color_name = 'Wheat Marle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'minus33' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'minus33' and color_name = 'Mossy Oak Country Roots' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'monos' and color_name = 'Obsidian' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'monos' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Cynthia Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Florencia Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Joan Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Liz Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Rooted Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Sienna Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Veronica Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'montce' and color_name = 'Winona Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOSAIC SPICE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MUSHROOM' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'WILDFLOWER SPICE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'INDIA INK' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'INDIA INK/FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK BOTTOMLAND' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK BREAK UP' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK BREAK UP COUNTRY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK COUNTRY ROOTS' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK FULL FOLIAGE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK GREENLEAF' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK ORIGINAL BOTTOMLAND' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK ORIGINAL TREESTAND' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MOSSY OAK SHADOW GRASS HABITAT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'MUDDY GIRL CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'muckboot' and color_name = 'TURKISH COFFEE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'naadam' and color_name = 'Dark Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'naadam' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'naadam' and color_name = 'Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'naadam' and color_name = 'Invisible Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'naadam' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'negativeunderwear' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'negativeunderwear' and color_name = 'Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'negativeunderwear' and color_name = 'Glacier' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'negativeunderwear' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'negativeunderwear' and color_name = 'Shell Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'negativeunderwear' and color_name = 'Zebra' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'ALICE WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'BEDFORD WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'CAMO ZEBRA' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'CARBON' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'CHALK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'CIENNA WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'CLASSIC WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'HAZELNUT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'LEOPARD PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'nililotan' and color_name = 'LIGHT WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'nililotan' and color_name = 'MIDNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'RAILROAD STRIPE RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'RESIN RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'ROSEBOWL WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'SIMON WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'SUMMER WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'VINTAGE LEOPARD PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'VINTAGE ROSEBOWL WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'VINTAGE WASHED - THYME' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'nililotan' and color_name = 'WHISKEY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'noahny' and color_name = 'Athletic Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'nobull' and color_name = 'Acorn' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'nobull' and color_name = 'Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'nobull' and color_name = 'Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'nobull' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'obermeyer' and color_name = 'Burnt Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'obermeyer' and color_name = 'Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'obermeyer' and color_name = 'Shadow Mountain' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'obermeyer' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'obey' and color_name = 'DUSTY VINTAGE WOOD CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'obey' and color_name = 'FENCE CAMO MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'oiselle' and color_name = 'Cool Down Aquila Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'oiselle' and color_name = 'Juniper' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'oiselle' and color_name = 'Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'oiselle' and color_name = 'Twilight' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'oiselle' and color_name = 'Wild Spruce' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'onia' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'onia' and color_name = 'Midnight/Egret' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, 'Dark')
   where brand_key = 'orage' and color_name = 'Dark Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'orage' and color_name = 'juniper' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Cranberry' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Golden Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Hazelnut / Hazelnut / Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Himalayan Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Nutmeg' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Papaya' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Seaweed' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Seaweed / Seaweed / Seaweed' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'organicbasics' and color_name = 'Truffle' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Cool Matcha' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Neptune/Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Snow' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Storm Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'outdoorresearch' and color_name = 'Verde' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Bubblegum' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Desert Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Floral Aura' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Guava' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Orchid Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Soil' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Steel Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'outdoorvoices' and color_name = 'Twilight' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pactimo' and color_name = 'Mountain Twilight' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Adobe Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Coal' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Dusk Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Pebble Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'parachute' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Arctic' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Arctic Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Baked Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Birch Beach Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Biscuit' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Biscuit/Oat' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Cranberry' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'passengerclothing' and color_name = 'Dark Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'passengerclothing' and color_name = 'Deep Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'passengerclothing' and color_name = 'Deep Ocean Jacquard' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Feather/Biscuit' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Fig/Wild Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Frost Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Geo Stripe Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Geo Stripe Mediterranean' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Grape Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Heather Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Milky Marl' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Pistachio Marl' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Redwood Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'passengerclothing' and color_name = 'Scenic Dark Fern' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'passengerclothing' and color_name = 'Spearmint/Deep Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Sun Patch Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'passengerclothing' and color_name = 'Vista Patchwork Arctic' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pathprojects' and color_name = 'Glacier' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'pathprojects' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pearlizumi' and color_name = 'ARCTIC' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pearlizumi' and color_name = 'ARCTIC/NIGHTFALL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'pearlizumi' and color_name = 'CACTUS FLOWER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'pearlizumi' and color_name = 'CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'pearlizumi' and color_name = 'DARK INK' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'pearlizumi' and color_name = 'GOJI BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'pearlizumi' and color_name = 'GOLDEN PALM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pearlizumi' and color_name = 'TWILIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pelagic' and color_name = 'North Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'pelagic' and color_name = 'Premium Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pendleton' and color_name = 'Glacier National Park' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'percival' and color_name = 'Earth Suede' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'percival' and color_name = 'Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'percival' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'percival' and color_name = 'Oat Marl' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'percival' and color_name = 'Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Alabaster' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'peruvianconnection' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Paprika' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Parchment' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Persimmon' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Porcelain' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Putty' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Snow' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Truffle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'peruvianconnection' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Acorn' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Arashi Camo Print' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Bloom Print' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Chicory Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Clover' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Golden Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Grape Jam' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Grape Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Grape Leaf Melange' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Grape Nectar' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Grape Royal' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Ponderosa Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Sea Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Snowy Pine Print' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'pictureorganic' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'polarskate' and color_name = 'Anthracite Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'polarskate' and color_name = 'One Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'polarskate' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'blossom-clementine-stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'blueberry-camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'blueberry-strawberry-stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'boysenberry' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'bubblegum' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'bubblegum-mix' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'classic-wash' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'clementine' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'clover' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'clover-mix' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'primarykids' and color_name = 'dark-wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'flamingo' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'grape' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'guava' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'heather-blueberry' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'heather-boysenberry' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'heather-hydrangea' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'heather-spruce' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'iris' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'matcha' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'mist-spring-stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'oat' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'peony' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'petal' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'pomegranate' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'raspberry-mix' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'spruce' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'storm' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'primarykids' and color_name = 'vintage-grape' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'primitiveskate' and color_name = 'ATHLETIC HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'primitiveskate' and color_name = 'CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'quiksilver' and color_name = 'ANTHRACITE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'quiksilver' and color_name = 'IRON GATE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'quiksilver' and color_name = 'PINE BARK' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'quiksilver' and color_name = 'SKYWAY HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'quiksilver' and color_name = 'THYME' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'radmor' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'ADMIRAL STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'rails' and color_name = 'AFTER MIDNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'ALABASTER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'AMALFI STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'ANTIBES STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'ATLANTIC' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'ATLANTIS STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'AVALON STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'AZURE GINGHAM' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'BALLET' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'BARLETTA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'BERRY HIBISCUS EMBROIDERY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'BERRY STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'BLUEBELL EMBROIDERED STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CABANA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CANYON STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CARDINAL FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CERAMIC FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CHICORY STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CINNAMON' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CLOVER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'COCOA DAISY EMBROIDERY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'COCOA FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'COCOA FLORAL EMBROIDERY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'COCOA POLKA DOTS' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CORDOBA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'CRETE STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'DELFINE STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'DUSK ORCHID' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'FLAX' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'FLORAL LASER' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'GARNET' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'GINGHAM TOMATOES' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'HARBOR BLANKET STITCH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'HAVANA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'HEATHERED FLAX' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'HEATHER LATTE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'HEATHER OAT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'HEATHER OAT STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'HIGHLAND PLAID' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'INK' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'JALISCO STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'LACE FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'LAGOON' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'LAKE VIEW STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'MALIBU STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'MARGARITA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'MARINA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'rails' and color_name = 'MEDIUM CLOUD WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'rails' and color_name = 'MEDIUM VINTAGE WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'rails' and color_name = 'MIDNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'rails' and color_name = 'MIDNIGHT BLUES' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Dark')
   where brand_key = 'rails' and color_name = 'MIDNIGHT MEADOW FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, 'Dark')
   where brand_key = 'rails' and color_name = 'MIDNIGHT PEONY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Dark')
   where brand_key = 'rails' and color_name = 'MIDNIGHT SILHOUETTE FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'rails' and color_name = 'MIDNIGHT VERBENA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'NAUTICAL STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'NOIR FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'OAT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'OCEAN STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'PALMA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'PAPAYA' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'PINE NEEDLE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'PRIMAVERA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'RAVELLO STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'RINSE WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'SALERNO STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'SALINO STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'SEQUOIA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'SONOMA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'SPICE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'STRIPED EYELET' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'STRIPED SEASHELLS' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'UMBER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'WINDWARD STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rails' and color_name = 'ZEBRA HAIRCALF' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'rains' and color_name = 'Ember' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rains' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'reebok' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Light')
   where brand_key = 'reebok' and color_name = 'Light Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'reebok' and color_name = 'Linen' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'ridgemerino' and color_name = 'Cinnamon' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ridgemerino' and color_name = 'Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'roark' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'robertgraham' and color_name = 'BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Acorn' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Blackberry Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Blueberry Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Bubblegum' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Bubblegum Pop' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Butterscotch Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Carbon Herringbone' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Chantilly Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Cinnamon Crochet' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Cinnamon Mesh' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Cinnamon Open-Knit' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Cinnamon Raffia-Knit' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Classic Cheetah' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Clover' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Clover Mesh' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Coconut Crochet' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Coffee Market Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Cranberry Chain' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Daffodil Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Dark')
   where brand_key = 'rothys' and color_name = 'Deep Sea Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Desert Cat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Dune Mesh' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Dusk Open-Knit' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Fig Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Fig Zig Zag' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Harbor Cabana Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Harbor Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Hickory Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Iron Herringbone' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Lagoon Open-Knit' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Latte' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Lollipop Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Marigold' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Marine Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'rothys' and color_name = 'Midnight Song' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Noir Mesh' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Oak Herringbone' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Oat Latte' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Optic' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Parchment' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Pebble Herringbone' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Poppy Mesh' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Poppy Raffia-Knit' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Raspberry Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Berry Pop' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Cheetah' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Cinnamon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Cinnamon Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Fog Herringbone' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Pecan Herringbone' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Umber' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'ReVelvet™ Umber Check' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sailor Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Salt Air' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sandstone Raffia-Knit' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sea Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Shortbread Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, 'Light')
   where brand_key = 'rothys' and color_name = 'Soft Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sorbet Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Spruce Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sunbeam Market Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sunkiss Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Sunshine Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Terra Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Tidal Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Watermelon Market Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Wheat Raffia-Knit' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'rothys' and color_name = 'Wild Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Animal Print' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Anthracite Island Escape' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Anthracite Solid' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Cloud Dancer Solid' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Coconut Milk' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Coconut Milk Solid' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'roxy' and color_name = 'Deep Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Four Leaf Clover Solid' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Golden Rod' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Holly Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Ocean Spray' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Parchment' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Parchment Solid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'roxy' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'rvca' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'rvca' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'rvca' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'rvca' and color_name = 'Marine' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'rvca' and color_name = 'Mushroom' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'rvca' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'rvca' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Azure Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Berry Marl' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Boysenberry Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Bubblegum' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Chalk Marl' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Cranberry' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'ryderwear' and color_name = 'Dark Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Eucalyptus' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Fawn Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Fern Marl' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Fern Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Iris Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Latte Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Matcha' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Matcha Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Oat Marl' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Oat Milk' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Papaya' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Petrol Stonewash' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Snow Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Snow Marl' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Snow Marle' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Sugar Dust' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'ryderwear' and color_name = 'Truffle' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'satisfyrunning' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'satisfyrunning' and color_name = 'Camo Overland Trek' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'satisfyrunning' and color_name = 'Camo Sublimation' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'satisfyrunning' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'satisfyrunning' and color_name = 'Dark Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'satisfyrunning' and color_name = 'Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'satisfyrunning' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'schott' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'schott' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'schott' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'setactive' and color_name = 'Blanc' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'setactive' and color_name = 'Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'setactive' and color_name = 'Confetti' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'setactive' and color_name = 'DRIFTWOOD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'setactive' and color_name = 'Lagoon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'setactive' and color_name = 'Sepia' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'shredly' and color_name = 'Clementine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'shredly' and color_name = 'Flora Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'shredly' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'shredly' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'shredly' and color_name = 'Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'shredly' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Bay Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Burnished Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Hickory' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Loden' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Loden Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Military Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Light')
   where brand_key = 'simms' and color_name = 'Pale Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Pebble Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Sepia' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'simms' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'sirthelabel' and color_name = 'Eira Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'sirthelabel' and color_name = 'Sommer Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'sirthelabel' and color_name = 'Sorbet Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'skims' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'skims' and color_name = 'Cocoa' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'skims' and color_name = 'Umber' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'smartwool' and color_name = 'Currant' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'smartwool' and color_name = 'Iron Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'smartwool' and color_name = 'Mink Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'smartwool' and color_name = 'Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'smithoptics' and color_name = 'Matte Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'smithoptics' and color_name = 'Matte Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'snowpeak' and color_name = 'GREIGE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Brule / Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Cranberry Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Floral Doodle Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Gelato Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Guava' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Noir / Brule' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Noir Gingham' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Pineapple / Brule Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Pineapple Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, 'Light')
   where brand_key = 'solidandstriped' and color_name = 'Soft Iris' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'South Beach Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'St. Barths Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'solidandstriped' and color_name = 'Symi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Atlantic' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Cappuccino Heather' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Ditsy Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Eucalyptus' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Fawn Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Flamingo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Glacier' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Lead Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Leopard Print' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Light')
   where brand_key = 'splendid' and color_name = 'Light Cedar Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Moonstone Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Oat Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Light')
   where brand_key = 'splendid' and color_name = 'Pale Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Light')
   where brand_key = 'splendid' and color_name = 'Pale Oak/Eucalyptus' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Light')
   where brand_key = 'splendid' and color_name = 'Pale Oak Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Pine Bark' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Snow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Snow Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Spruce' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Tawny Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Truffle' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Twilight' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'splendid' and color_name = 'Wheat Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'splits59' and color_name = 'Heather Military' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'splits59' and color_name = 'Latte' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stance' and color_name = 'BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stance' and color_name = 'CANVAS' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stance' and color_name = 'FIG' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stance' and color_name = 'ORCHID' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stance' and color_name = 'PINE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stance' and color_name = 'SPICE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'statebags' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'statebags' and color_name = 'Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'ARTIST STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'CHEETAH' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'staud' and color_name = 'DARK OAK' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'DESERT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'EARTH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'HOUNDSTOOTH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'HUNTINGTON STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'MONDAY STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'ORCHID' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'REDONDO STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'SEAPORT STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'SKATE STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'TRUFFLE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'TRUFFLE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'VINTAGE WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'staud' and color_name = 'WISTERIA' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stetson' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'stetson' and color_name = 'Light Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'stetson' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stetson' and color_name = 'Mushroom' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stetson' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Abyss Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Alloy Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Bold Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Bold Bloom Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Boundless Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Canyon Rock Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Cowboy Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Faded Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Forestline Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Magnet' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Magnet Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Mountain Goat Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Mountain Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Mountain Shadow Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Raven' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stio' and color_name = 'Windchill Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Camo Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Camo Petrol' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Chambray' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Coconut' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, 'Dark')
   where brand_key = 'straightdown' and color_name = 'Dark Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'New Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Ocean' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'straightdown' and color_name = 'Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'sundry' and color_name = 'Latte' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'sundry' and color_name = 'Loden' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'tannergoods' and color_name = 'Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'tannergoods' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Cosmic Berry' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Mosaic Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Nouveau Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Orchid Ditsy' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Oversized Tropical Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'teacollection' and color_name = 'Poppy Poppies' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tenthousand' and color_name = 'Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tenthousand' and color_name = 'Iron (Old SKU)' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'tenthousand' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'tenthousand' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'tenthousand' and color_name = 'Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tenthousand' and color_name = 'Serpentine Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'ASHWOOD HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'BAKED CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'CLAY TILE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'CLAY TILE HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'CRUSHED BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'CRUSHED BERRY HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'tentree' and color_name = 'DARK ELKWOOD HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'tentree' and color_name = 'DARK OAK' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'DUSKY ORCHID' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'EUCALYPTUS' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'FALCON HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'FIG' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'FIG HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'FOSSIL HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'ITALIAN CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'JASPER HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'tentree' and color_name = 'LIGHT WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'tentree' and color_name = 'MID WASH' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'MINERAL HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'MOONLIT OCEAN' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'MOONLIT OCEAN HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'MULBERRY HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'MUSHROOM' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'OASIS HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Light')
   where brand_key = 'tentree' and color_name = 'PALE OAK' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Light')
   where brand_key = 'tentree' and color_name = 'PALE OAK HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Light')
   where brand_key = 'tentree' and color_name = 'PALE OAK HEATHER FLECK' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'PINE BARK' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'SEPIA' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'SEPIA HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'SUGAR PINE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'SUNRAY HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'WARM OAK NEP' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tentree' and color_name = 'ZINC' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'thirdlove' and color_name = 'bluestone' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'thirdlove' and color_name = 'leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'thirdlove' and color_name = 'petal' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'thirdlove' and color_name = 'sea-salt' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'thirdlove' and color_name = 'twilight' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Biscuit' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Bourbon' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Bubble Gum' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Burnt Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Burnt Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Cactus' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Cinnamon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Cinnamon Suede' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Coffee Shinki Cordovan' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'thursdayboots' and color_name = 'Dark Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'thursdayboots' and color_name = 'Dark Truffle' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Desert Sun' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Earth Tones' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Flint' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Ginger Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Golden Hour' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Granite' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Hickory' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Hickory Vachetta' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Honey Suede' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Latte' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Light')
   where brand_key = 'thursdayboots' and color_name = 'Light Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'thursdayboots' and color_name = 'Medium Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'thursdayboots' and color_name = 'Midnight Suede' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Milk Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Nutmeg' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Ocean Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Pebbled Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Saddle' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Striped' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Timber Canvas' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Truffle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Umber' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Vintage Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Vintage Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Vintage Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Whiskey' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'thursdayboots' and color_name = 'Zebra' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Bar Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Carbon' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Dust' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Ink Print' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Iron' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'toadandco' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'toadandco' and color_name = 'Midnight Dobby' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'toadandco' and color_name = 'Midnight Pattern' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'toadandco' and color_name = 'Midnight Print' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Salt Ditsy Print' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Salt Dobby' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Salt Print' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Soil' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'toadandco' and color_name = 'Soot' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'tomboyx' and color_name = 'Bluestone' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'tomboyx' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'tomboyx' and color_name = 'Future Dusk' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tomboyx' and color_name = 'Stripe Unbound' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tomboyx' and color_name = 'Stripe Up MP' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tomboyx' and color_name = 'TENCEL Modal Animal Constellation' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Almond Milk' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Cabernet Fireside Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Chili Pepper' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Coconut Milk' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Coconut Milk Fireside Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Coconut Milk Ski Mountain' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Dove' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Dove Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Dress Blues Diamond Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Dress Blues Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Dress Blues Rugby Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Golden Haze' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Monument Camo Skin' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Raspberry Sorbet' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tommyjohn' and color_name = 'Simple Leopard' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'topodesigns' and color_name = 'Dark Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'topodesigns' and color_name = 'Desert Palm' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'topodesigns' and color_name = 'Duck Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'topodesigns' and color_name = 'Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'topodesigns' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'topodesigns' and color_name = 'Spruce' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Chili Pepper' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Clover' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Coffee Grounds' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Grape Leaf' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Heather Allure' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Heather Microchip' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Heather Quiet Shade' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Heather Sleet' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Heather Total Eclipse' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Quiet Harbor' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Straw' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Turkish Coffee' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'travismathew' and color_name = 'Weathered Teak' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'trew' and color_name = 'Anthracite' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'trew' and color_name = 'Mighty Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'troyleedesigns' and color_name = 'BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'troyleedesigns' and color_name = 'CARBON' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'troyleedesigns' and color_name = 'CHALK' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'troyleedesigns' and color_name = 'DARK CLOUD' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, 'Dark')
   where brand_key = 'troyleedesigns' and color_name = 'DARK EARTH' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'troyleedesigns' and color_name = 'GOLDEN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'troyleedesigns' and color_name = 'HONEY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'troyleedesigns' and color_name = 'MIDNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'troyleedesigns' and color_name = 'OAK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'truereligion' and color_name = 'Body Rinse' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'truewerk' and color_name = 'Heathered Putty' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'tumi' and color_name = 'Deep Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'tumi' and color_name = 'Thyme' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Light')
   where brand_key = 'tyr' and color_name = '254 Light Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'tyr' and color_name = '290 Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'tyr' and color_name = '305 Evergreen' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'tyr' and color_name = '396 Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'tyr' and color_name = '593 Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'tyr' and color_name = '927 Dark Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'unboundmerino' and color_name = 'Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'unboundmerino' and color_name = 'Heather Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'unboundmerino' and color_name = 'Heather Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'Beach Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'British Plaid' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'Clover' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'Mayfair Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'Poppy' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'Raspberry' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'universalstandard' and color_name = 'Zen Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'velasca' and color_name = 'Hazelnut' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'velvet' and color_name = 'BERRY-PRNTVOILE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'velvet' and color_name = 'CHALK-WOVLINEN' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'velvet' and color_name = 'COCONUT-COTGAUZE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'velvet' and color_name = 'INK-COTSLUB' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'velvet' and color_name = 'INK-WOVLINEN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'velvet' and color_name = 'MIDNIGHT-GZYWHSNOV' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'velvet' and color_name = 'MIDNIGHT-VELORIGIN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'velvet' and color_name = 'MIDNIGHT-WHISPER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'velvet' and color_name = 'SHADOW-VELORIGIN' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'velvet' and color_name = 'SHADOW-WOVLINEN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'verabradley' and color_name = 'Hollyhock Paisley' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'verabradley' and color_name = 'Poppy Fields' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'verabradley' and color_name = 'Rachel Ditsy' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'verabradley' and color_name = 'Vibrant Paisley' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Acorn' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Acorn Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Cactus' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Cypress' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Loden' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'veronicabeard' and color_name = 'Midnight Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Orchid Haze Multi' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Persimmon' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Pistachio' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'veronicabeard' and color_name = 'Tobacco' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'volcom' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'volcom' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'BIRCH' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'CLOVER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'EARTH MOTHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'FOUR LEAF CLOVER' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'GARNET' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'HAZELNUT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, 'Dark')
   where brand_key = 'warpweft' and color_name = 'MIDNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'NIGHTFALL RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'NOIR' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'NOIR WAX COATED' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'OPTIC' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'RAVEN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'RIVER RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'SHADOW' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'SPLIT RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'TEAK' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'THYME' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'TWILIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'warpweft' and color_name = 'TWISTED OPTIC' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Berry Ice Pop' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Buttercream Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Cinnamon Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Coastal Mini Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Coastal Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, 'Dark')
   where brand_key = 'woolx' and color_name = 'Deep Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'French Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Grape Harvest' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Morning Fog' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Nutmeg' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Ocean Cavern' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Pebble' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Pinot Noir' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Poppy Spark' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Raspberry Fizz' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Rhubarb Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Sable Heather' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Toasted Garnet' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Wildberry Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Woodland Mini Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woolx' and color_name = 'Woodland Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'woxer' and color_name = 'Arctic' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'woxer' and color_name = 'Desert Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'woxer' and color_name = 'Dusk Deluxe' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'woxer' and color_name = 'Latte 3.0' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'woxer' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'woxer' and color_name = 'Sandstone' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, 'Light')
   where brand_key = 'woxer' and color_name = 'Soft Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'woxer' and color_name = 'Tidal Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'xirena' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'xirena' and color_name = 'Parchment' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'BUBBLE GUM' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Camouflage' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'CLOUD' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'CLOUD MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'xtratuf' and color_name = 'Deep Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, 'Dark')
   where brand_key = 'xtratuf' and color_name = 'Deep Storm Swirl' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'DUCK CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'DUCK CAMO SWIRL' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Ginger Spice' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Ice Duck Camo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Legacy Marine' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'MOSSY OAK BOTTOMLAND' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'MOSSY OAK COUNTRY DNA' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Orchid' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Skyway Floral' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'xtratuf' and color_name = 'Stormy Duck Camo' and base_color is null;
end $$;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00759') on conflict do nothing;
