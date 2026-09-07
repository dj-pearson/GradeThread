-- US-3125: fill the unresolved colour buckets from each brand's OWN facet tags.
--
-- 00737 gave every colorway a base_color where the existing aspect-normalize
-- table could derive one, and left 1,013 NULL rather than guess. This fills a
-- large part of that from a source that was in the feed the whole time.
--
-- -- THE TAG NAMESPACE NOBODY HAD LOOKED AT ---------------------------------
--
-- Brands namespace their own filter facets in Shopify tags, because their own
-- site needs a "shop by colour" filter. 7 For All Mankind carries `wash::Grey`,
-- `fit::Flare`, `fabric::Denim`. The harvester was only reading `*style*:` tags
-- and walked past the rest.
--
-- That single namespace answers the case no colour table ever could:
--
--     Coffee Bean   -> wash::Brown        the owner's own example
--     Optical White -> wash::White        the owner's other example
--     Halona        -> wash::Dark Wash
--     Arizona       -> wash::Light Wash
--     Cisco         -> wash::Dark Wash
--     Kansas        -> wash::Light Wash
--
-- A denim wash name carries no colour information by design. The BRAND knows,
-- and publishes it.
--
-- -- WASH IS A DEPTH, NOT A COLOUR ------------------------------------------
--
-- "Dark Wash" is blue jeans that are dark, so it becomes base_color Blue with
-- shade Dark. Light Wash is Blue/Light, Mid and Medium Wash are Blue/Medium.
-- That is exactly the Dark/Medium/Light axis this schema added in 00737,
-- arriving from the brand's own data instead of being inferred.
--
-- -- WHAT IS IGNORED ---------------------------------------------------------
--
-- `Glitz`, `Metallic`, `Patent`, `Suede` and a bare `Color` appear in the same
-- namespace and are NOT colours -- they describe a surface, and eBay has its own
-- aspect for that. Mapping "Metallic" onto a colour would put the wrong word in
-- Color and lose the right one. `Prints` and `Animal` DO map, to Multicolor,
-- because that is what eBay's Color list offers for a patterned garment.
--
-- 0 colour names carried two conflicting families across products and
-- are skipped rather than resolved by majority vote.
--
-- Only rows where base_color IS NULL are touched, so nothing 00737 derived is
-- overwritten and re-running changes nothing.
--
-- Brands contributing: agjeans (574), 7forallmankind (501), stevemadden (465), mother (316), untuckit (68), andie (6), denimtears (4), hudsonjeans (2).

do $$
begin
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Abyss' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Adventure' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Afternoon' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Airspace' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Alto' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Ambition' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Amuse Me' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Another Time' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Anthem Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Aquashade' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Archive' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Arizona' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Army' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Artifact' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ash' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ashen' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Astra' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Atlas' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Authentic Blue Malmo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Avenue' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Bakersfield' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Baltimora' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Bark' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Bathe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Bay' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Beige' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Belton' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Bent' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Beyond' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Bind' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Birch' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Biscuit' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Black' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Black Beauty' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Black Cherry' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Black Onyx' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Blackcat' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Blacky' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Bleach' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Blossom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Blue Black' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Blue Black Santiago' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Blue Core' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Blue Erosion' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Blue Haze' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Blue Hour' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Blue Petal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Blue Shine' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Blue Vibe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Blueberry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Bluecrest' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Bluefern' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Bluehaven' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Blueleaf' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Blushing' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Bone' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Bone Fade' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Border' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Bottomline' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Brave' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Breakwater' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Brickheart' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Brief' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Brilliant White' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Brink' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Brown' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Brownie' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Burgundy' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Burnt Chestnut' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Burnt Sand' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Burnt Smoke' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Calvert' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Cambridge' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Canyon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Caramel' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Carbon Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Carpenter Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Caviar' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Celestial' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Certainty' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Chalk' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Champlin' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Charleston' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Chelsea' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Cherry' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Chestnut' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Chill Wave' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Chocolate' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Cielo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Cisco' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Classical' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Clay' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Clean Slate' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Clear' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Cloud' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Cloudbreak' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Coal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Coastline' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Coated Black' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Coated Midland' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Coco' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Coffee Bean' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Cognac' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Coldspring' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Comfort Twill Military' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Conroe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Constellation' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Copper' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Corduroy Winter Beige' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Cosmos' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Cottage' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Cotton' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Could Night' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Countless' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Cove' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Covewash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Crater' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Cream' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Creme' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Crossover' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Cub' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Current' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Dance' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Dark Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Dark Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Dark Navy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Darkwind' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Debut' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Deep Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Deep Earth' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Deep Sea' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Desert' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Dewdrop' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Distressed Authentic Light' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Draft' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Driftwood' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Drive' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Duchess' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Dusk Smoke' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Dust Rise' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Duster' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Dusty Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'EXECUTIVE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Eclipse' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ecru' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Eggshell' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Enduring' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Escape' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Espresso' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Estate' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Explorer' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Faded Echo' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Faint' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Fairfield' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Fancy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Fate' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Feather' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Firey Red' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Fisherman' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Flame' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Flash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Flux' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Foam' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Forge' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Formentera' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Four Mile' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Franklin' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Free White' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Freehand' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Freeport' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Freezy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Frosted Lotus' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Frosty' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Frozen' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Full Scale' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Gale' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ghost' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Ghost Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Gilbert' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ginseng' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Glaze' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Glisten' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Gold River' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Grand Canyon' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Grapevine' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Gravity' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Gunmetal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Halona' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Hammer' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Hana' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Hasting' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Haven' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Hearth' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Heavy Rain' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Heirloom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'High' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'High Point' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'High Time' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'High Wave' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Highline' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Hilo' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Hound Check' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Houndstooth Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Hustle' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ice White' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Iceflow' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Icevine' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Icy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Ideal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Indiglow' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Indigo Bloom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Indigo Soul' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Industrial' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Inkstone' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Inkstorm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Iris' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Iron Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Ironwood' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ivory' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Jasper' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Joker' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Jupiter' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Kansas' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Kingfisher' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'LUXE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Lagoons' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Lake Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Landing' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Lapis' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Lava Rocks' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Le Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Legato' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Legend' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Les' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Light Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Light Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Linen White' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Loam' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Loft' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Lolly' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Loom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Los Angeles Dark' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Los Feliz' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Love Soul' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Love Story' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Low' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Luminous Blue' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Luxe White' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'MID BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Majesty' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Malibu Sky' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Marine' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Mariner' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Marsh' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Mason' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Maui' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Medium Melrose' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Mesa' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Metal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Mid Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Midland' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Midnight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Midnight Abyss' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Midnight Fade' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Midtown' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Military' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Milky Way' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Milkyway' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Mink' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Miramar' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Mirror' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Missy' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Mistery' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Mocha' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Molasses' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Moon Tune' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Moonbeam' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Moondust' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Moonwater' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Moreno' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Moss' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Mount' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Must' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Natural' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Navy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Navy Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Neptune' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Nevada' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Never Better' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'New York Dark' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Night' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Night Black' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Nightscape' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Nightwood' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Nocturnal' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Nocturne' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Noho' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Nolita' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Nude' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Oak' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Oat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Ocean Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Oceandrift' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Oceans' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Oceanstone' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Ode To' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Off White' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Olina' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Optical White' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Origins' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Ormond' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ostuni' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'PERENNIAL' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Panalu' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Paradise Cove' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Parchment' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Park Avenue' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Park Slope' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Peaches' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Peak' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Philly Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Phoenix' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Pillow' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Pine' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Pond Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Porch' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Portofino' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Postbox' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Prism' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Proper' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Prophecy' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Pure White' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Quicksilver' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Radar' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Radiance' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Raincloud' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Rainfall' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Range' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Rawhide' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Reason' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Rebel' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Rebellion' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Repose' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Resilience' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Retro Fade' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Revival' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Revolt' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Rialto' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Rich Indigo' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Richey' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Rinse Black' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Rinsed Black' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Rinsed Indigo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Rio' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'River Water' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Riverstone' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Rocker' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Rose' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Rosie' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Royalty' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sable' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Sacramento' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sagebush' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Sahara' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Salem' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Saltbrush' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Saltmist' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Salty' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sand Dune' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sandcastle' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sandcut' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sandune' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Santa Cruz' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Santa Monica' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Santa Rosa' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Sapphire Dust' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Saturday' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Sea' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Sea Level' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Seabreeze' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Seabrook' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Seashell' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Seaside' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'September' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Serenade' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Shadow Check' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Shadowcrest' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Shell' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Shimmer' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Shore' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Signal' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Silver Wash' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sky Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Skyfrost' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Slate' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Smolder' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Smooth' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Smoove' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Snake' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Soho Classic' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Soho Dark' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Soho Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Soho Light' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Soho Night' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Soleil' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Solitary Star' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Sonora' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Soot' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Space Rock' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Sparkling' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Spectrum' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Speed' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Spill' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Spin' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Starlight' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Starry' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Station' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Steel' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Steel Dark' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Steel Mid' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Steelwater' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Stock' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Stone' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Stormwave' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Stormy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Stormy Drift' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Street Wise' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Striped Ink' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Stripes' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Studio Blue' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sugar' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Summer Fig' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Summer Mist' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Sundance' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Sundown' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sunfaded Moss' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Sunfaded Sand' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Sunlover' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Sunset Beach' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Swan' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Swim' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Tail' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Teak' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Tempe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Terrell' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Thicket' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Thunder Storm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Thundershade' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Thunderstorm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Tide Break' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Tideworn' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Timeless' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Toffee' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Tokyo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Total' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Trendsetter' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Tribeca' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Tried & True' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Trip Black' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Trip Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'True Black' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Twilight Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Ultramarine' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Umber' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Universe' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Urban' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Vanity' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Vapor' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Velocity' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Vernon' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Vintage Brown' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Vintage White' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Volcano' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Waivy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Walk' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Walnut' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Wanderer' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Washed Black' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Wave' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Wavebreak' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Wavefrom' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Waveset' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Weekend' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'West Village' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'White' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Wild' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = '7forallmankind' and color_name = 'Windchill' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Winter Beige' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = '7forallmankind' and color_name = 'Within' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Wolf' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Wood' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = '7forallmankind' and color_name = 'Yuma' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = '7forallmankind' and color_name = 'Zebra' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '1 STRIPE PURPLE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '1 YEAR DOHENY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '1 YEAR FREMONT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '1 YEAR POST' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '1 YEAR SULFUR CHALK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '10 YEARS FRONT LINE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '10 YEARS ILLIAD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '10 YEARS SOUND CHECK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '11 YEARS CAPRA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '11 YEARS ENRICH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '11 YEARS MEMORY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '11 YEARS ROBUST' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '12 YEARS ROLLINS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '13 YEARS ALLURE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '13 YEARS CYMBALS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '13 YEARS OTHERWORLDLY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '14 YEARS BLOOMINGTON' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '14 YEARS BLUEGRASS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '14 YEARS JASPER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '14 YEARS NOTES' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '14 YEARS VINTAGE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS ABALONE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS AVIATOR' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS BOUQUET' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS MERRICK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS PRAGUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS RAFAEL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS REGAL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS SHORELINE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '15 YEARS VOLCANIC' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '16 YEARS AFFINITY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '16 YEARS CALAFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '16 YEARS HIDDEN GEMS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '16 YEARS HUDSON' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '16 YEARS JAM SESSION' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '17 YEARS DIVERGENT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '17 YEARS DUET' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '17 YEARS FORLORN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '17 YEARS HANDPRINTS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '17 YEARS MYSTERY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '18 YEARS KEYNOTE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '18 YEARS OPEN MIC' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '18 YEARS SMOLDER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '18 YEARS VAMP' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '18 YEARS VIENNA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '19 YEARS COYOTE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '19 YEARS GARDEN GROVE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '19 YEARS JUNIPER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '19 YEARS MOBIUS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '19 YEARS NORTH STAR' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '2 YEARS CHELTON' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '2 YEARS EUREKA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '2 YEARS HIGH NOTE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '2 YEARS TUXEDO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '20 YEARS BARRETT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '20 YEARS NOMAD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '20 YEARS TURNAROUND' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '21 YEARS STARGAZE DISTRESSED' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '22 YEARS GOLDEN STATE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '22 YEARS TANNER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '24 YEARS INTENTION' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '24 YEARS PLUNGE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '3 YEARS FLIGHT NIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '3 YEARS GOLDEN HOUR' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '3 YEARS GRAVITY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '3 YEARS HIGHRISE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '3 YEARS OUT OF THE BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '4 YEARS DIAZ' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '5 YEARS BLUE ESSENCE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '5 YEARS GETAWAY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '5 YEARS GRANDSTAND' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '5 YEARS SULFUR BLUEGRAIN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '5 YEARS SULFUR OAK BARREL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '5 YEARS UNDERWOOD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '5 YEARS VIEWS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '6 YEARS EL PASO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '6 YEARS FERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '6 YEARS SIDEWAYS' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS BLACK NILE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR ANTIQUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR ASHLINE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR CLASSIC GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR COASTAL MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR COBALT CLUB' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR CRANBERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR EVENING SMOKE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR FADED MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR FRESH BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR IRONWOOD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR MODERN NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR OAK BARREL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR SOFT BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SULFUR WOOD BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS SYMPHONY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YEARS VINTAGE CORNFLOWER' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '7 YRS SULFUR PURE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '8 YEARS MANCHESTER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '8 YEARS REISSUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '8 YEARS ROCA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '9 YEARS ENCHANTMENT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '9 YEARS REWARD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = '9 YEARS VINYL HOUR' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ACCESS' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ADOBE CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ADVENTURE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AFTER HOURS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AG BORO DEEP NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AG CALIFORNIA  ROAD TRIP PUMIC' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AG CALIFORNIA ROAD TRIP DEEP A' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AG LABEL PUMICE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AGED STONY HILL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AKIRA' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ALCHEMY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ALL THAT GLITTERS' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ALMOST WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AMERICAN RIVIERA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AMERICAN WEST' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ANGELIC' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ANTIQUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ASHLINE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ASPEN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ASSANTE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'AZURA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BALLROOM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BASS' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BASSLINE BERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BAY BRIDGE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BEBOP' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BIG PINE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BISHOP' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLACK MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLACK TIE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLACK/BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLACK/NATURAL STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLACK/NICKEL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLINDSIDED' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLUE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLUE NOISE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLUE TRAIN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLUE/WHITE STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLUEGRAIN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BLUEPRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BOHO QUILTING' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BOLD STRIPE BLACK MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BOLTON' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BRIX' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BRONZE BEAT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BRONZE BEAT MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BROWN SLATE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BROWN/BRASS' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BROWN/GOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BROWN/SILVER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BROWN/WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BRUSHED COWBOY BOOTS-IVORY DUS' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BRUSHED FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BUNDLED' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BURGUNDY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'BURNT UMBER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CALIFORNIA MAP DEEP ALPINE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CAMEL/BRASS' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CAMEL/GOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CAMILLO' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CAMP LEAF CAMO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CANDID' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CANYON AMBER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CARLSON' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CASTRO VALLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CELLO' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHANNEL ISLANDS VIBE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHANNEL SKY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHAPARRAL' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHAPMAN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHECK COLDWATER SLATE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHECK IRISH GREEN MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHECK NAVY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHECK PURPLE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHERRY SWING' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHESTNUT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CHORD' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CINNAMON/POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CLASSIC GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CLAY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'COASTAL PEBBLE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'COBALT CLUB' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'COBALT/NATURAL STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'COFFEE BEAN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'COLFAX' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'COPENHAGEN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'COUNTRY FARM' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CRANBERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CRUCIAL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CRUISER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CRUSADE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CRUSH' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CURSON' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'CYPRESS LAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DARK ASH' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DARK BROWN/BRASS' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DARK BROWN/NICKEL' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DARK CHOCOLATE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DARK GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DARK GREY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DARK OCEAN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DAWN SKY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DAY TO NIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DEEP ALPINE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DEEP NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DEEP NAVY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DEEP NAVY/HEATHER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DEEP TEAL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DEEP TRENCHES' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DESERT BREEZE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DESERT NIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DESERT PLAID GREY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DESERT THEORY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DEXTERS' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DIRTY OLIVE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DOWNBEAT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DRESS IT UP' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DUNE KHAKI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DURHAM' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'DUSTY SAGE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ECHO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ENDLESS BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'EPILOGUE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'EVENING SMOKE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'EXPEDITION' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FADED MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FAREWELL' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FATHOM' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FERN SPRINGS' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FIGUEROA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FIRST BLOOM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FLASHBACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FLASHLIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FLIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FOCAL POINT' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FOLKESTONE GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FOREST ASH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FOXY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'FRESH BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GALAXY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GALLERY WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GEMFIELD' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GEO STRIPES' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GESTURE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GLACIER POINT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GLAM SAFARI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GOLD COUNTRY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GOLD MOUNTAIN' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GOLD MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GOLDEN ENCORE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GRAPE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GRAPEFUL GLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GREEN MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GREENSBORO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'GROVE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HALF DOME' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HAPPY HOUR TRUE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HARD BOP' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HARMONICA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HARVEST' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HAVANA' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HEATHER CHARCOAL' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HEATHER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HEATHER GREY/TRUE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HERITAGE ADOBE CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HERITAGE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HERITAGE COASTAL MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HERITAGE ORANGE SPRITZ' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HERITAGE PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HERRINGBONE BLUES MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HIGHLIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HIGHWAY 29' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HORSETAIL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'HOTEL CALIFORNIA' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'IMMENSITY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'IMMERSION' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'INDIGO QUILT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'INDIGO SESSIONS DEEP NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'INDIGO TONE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'INK NOTE DRIFT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'INNOVATION' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'INSPIRED GAZE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ISLAND NIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'IVORY DUST' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'JAZZ CLUB' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'JAZZ NIGHT DEEP NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'JIVE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'JOMBO ROCKS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'KINGS RIVER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LACE UP' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LEGENDARY GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LEOPARD LOUNGE' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LIPSTICK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LISTENING MUSIC' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LOCAL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LOOMER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LTT LT BURNT UMBER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LTT LT CHESTNUT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LTT LT DEEP TRENCHES' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LTT LT SUPER BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'LUMINANCE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MAIN STREET' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MALBEC' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MANZANITA' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MARBLE TAN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MASTODON' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MAZE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MELANGE OAT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MELANGE STONE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MIDLANDS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MIDNIGHT CHATEAU' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MIDNIGHT JAM' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MOCHA PITCH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MODERN INDIGO' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MOJAVE PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MONDRIAN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MONUMENT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MOONLIGHT VINYL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MOONRISE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MOONWASH SIERRA CURRANT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MOORTEN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MUSTARD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'MYKONOS' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NATURAL' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NATURAL MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NATURAL OAK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NAVY/GREY STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NAVY/NATURAL STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NAVY/SILVER' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NEBULA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NEGRONI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NEW NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NEXT TO WATER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NIGHT CAP' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NIGHTFALL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NORTHERN VINE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NOSTALGIA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'NOUVEAU' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OAK BARREL' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OAK BARREL/DRY DUST' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OCEANVINE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OCTAVE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OFF THE GRID' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OJAI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OLD FASHIONED' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OPAL RADIANCE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OPAL STONE' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ORANGE SPRITZ' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OUTSPOKEN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OVERNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'OWENS VALLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P AG CHEST LOGO POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P AG CHEST LOGO SUPER BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P AG CHEST LOGO TRUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P AG DISTRESS LOGO TRUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P AG DISTRESS LOGO TRUE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P AG DISTRESSED LOGO DPTH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P APERITIVO HOUR' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P CALI BLOOM HUNTER SAGE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P CALI BLOOM TRUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P CALI DREAM TRUE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P CALI FILM FOREST MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P CHEERS HOUR' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P CHEERS HOUR POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P HOLLYWOOD BOWL ABSTRACT KEYS' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P HOLLYWOOD BOWL SESSIONS' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P JAZZ AT THE BOWL' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P JAZZ FEST CHERRY SWING' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P JAZZ KEY POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P JAZZ NIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P JAZZ NIGHT MUSTARD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P JAZZ SWING POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P JAZZ VIBE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P LA CITY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P MARTINI MOMENT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P NEON CLUB SUPER BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P NOTES OF WINES LIME ZEST' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P PACIFIC HAZE HEATHER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P POOLSIDE HOTEL DEEP NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P SAND AND SUN SILVER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P SIP AND RELAX FOREST MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P STONY HILL H. COASTAL MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P STONY HILL WHEAT FIELD' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P STONYHILL HERITAGE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P SUN DAISY TRUE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P THE WORLD FAMOUS DENIM' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P TIMELESS SOUND EVENING SMOKE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P UNDER THE SUN POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P WINE LINE TRUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'P WINE NOT POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PACIFIC NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PACIFIC NAVY/POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PAINTING TIGER NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PALMER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PALMS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PERFECT PITCH' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PETERSON' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PINE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PINK MOON' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PLATEAU' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PLAYA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POOLSIDE AQUA' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POOLSIDE GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POST' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER MENDED' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER/CHARTREUSE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER/ECRU' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER/KHAKI SAND' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER/PACIFIC NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER/SILVER' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'POWDER/SPRUCE GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PRISTINE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PRODUCTIONS-TRUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PROMISELAND' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PUMICE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'PURPLE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RATTLESNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RAW' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RAW DENIM' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RECORDING RED' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RECOUP' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RED HORSE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RED MOON' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RED MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RESERVA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'REWIND' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RHYTHM PINSTRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'RIVERBEND' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ROCK STAR' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ROUTE 49' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SALT AND SIZZLE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SALTILLO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SENSATIONAL' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SENSORY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SEQUEL' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SEQUOIA' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SEQUOIA STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SHIPPING' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SHOWTIME' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SIERRA CURRANT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SIERRA MEADOW' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SILVER FIREWORK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SILVER GLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SILVER MOON' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SILVER MYST' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SILVERADO TRAIL' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SMOKE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SOFT FOCUS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SOFT FOCUS DESTRUCTED' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SOFT MUSHROOM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SOLAR FLARE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SOLEDAD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SOLERA' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SOLOS' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SPARKLING ROSE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SPLASH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SPRITZ ME UP' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SPRUCE GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SQUAW VALLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STANTON' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STEEL GREY PINSTRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STELLAR' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STERLING' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STOCKHOLM SNOWDRIFT' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STONE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STONYHILL CORK' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STONYHILL FADED MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'STUDIO' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR ADOBE CLAY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR AMBER DUST' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR ANTIQUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR BRONZE BEAT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR BURNT UMBER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR CLASSIC GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR COASTAL MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR COBALT CLUB' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR CORK' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR DARK ASH' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR DIRTY OLIVE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR DRIED CEDAR' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR EVENING SMOKE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR FADED MOSS' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR FADED SALMON' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR FERN SPRINGS' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR FOSSIL GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR FRESH BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR GOLDEN HICKORY' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR GRAPE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR LIGHT TAUPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR MARINE HAZE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR MODERN NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR OAK BARREL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR OCEANVINE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR PACIFIC NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR PIER BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR PURE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SEASIDE SAGE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SIENNA SAND' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SMOKEY BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SMOKY SAPPHIRE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SOFT MUSHROOM' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SPARKLING ROSE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SPRUCE GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR STORM GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SUNWASHED JADE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR SUPER BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR VINTAGE CORNFLOWER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR WOOD BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SULFUR WORN BRASS' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUMMER VINE' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUNLIGHT YELLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUNLIGHT YELLOW/NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUNSET HILLS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUNSET ROSE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUNSET SIPS' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUNSET WESTERN 5 YRS TRUE BLAC' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUPER BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUPER BLACK/GOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SUPER BLACK/POWDER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'SYMMETRY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TAILOR' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TAKAYAMA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TAMARACK' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TAUPE GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TIMESTAMP' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TINSELTOWN' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TIPSY SUN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TRIBAL SNAKE SKIN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TRUE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TRUE BLACK RIFF WAVE STRIPE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TRUE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TURNTABLE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'TUXEDO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'UNKNOWN BLUES' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'URBAN TAUPE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VIBRATO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VINEYARD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VINEYARD RINSE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VINTAGE CORNFLOWER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VINTAGE INK' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VINTAGE PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VIOLET VIBE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VIPER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'VP MARIPOSA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WATER FLOWER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WATERCOLOR YOSEMITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WATERMIST' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WESTERN FRONT' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WESTWIND' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WHITE SANDS' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WILD LIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WILD LINES' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WILD TIGER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WILLOWED' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WINE BOTTLE WOMEN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WINE GARDEN' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WINE GLASS AND BOTTLE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WINERY' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WOMEN PAINTED DENIM STITCH -SO' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WOMENS AG DISTRESS LOGO -WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'WOOD BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'YELLOW MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'YORU' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'YOUNTVILLE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'YUCCA SHADOW' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'agjeans' and color_name = 'ZEBRA POP' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'Blue and White Floral with Stripes' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'andie' and color_name = 'NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'RIBBED WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'andie' and color_name = 'WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'denimtears' and color_name = 'Black' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'denimtears' and color_name = 'Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'denimtears' and color_name = 'Gold' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'denimtears' and color_name = 'Multi' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'hudsonjeans' and color_name = 'UNKNOWN' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'hudsonjeans' and color_name = 'WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'ARTICHOKE MARINER' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'ATHENA EMBROIDERY SALT' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Almond Buff' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Antique White' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Antivenom' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Artifact Seeker' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Assorted' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'BETSY BLEU' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Bad Date' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Baked' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Ballad Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Banana Split' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Beeswax And Caramel Cafe' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Beige (Khaki)' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Beige (Light)' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Beluga' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Berry Lucky' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Bikini' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Bird''s Eye View' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Birds Gone Wild' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Biscute' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Bison' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Black' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Black (Charcoal)' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Black/Pink' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Blue (Bright)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Blue (Dark)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Blue (Light-Pastel)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Blue (Medium)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Blue (Navy)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Blue (Open)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Blue (Turquoise-Aqua)' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Book Adventures' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Break The Ice' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Breaking New Ground' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Bring The Cooler' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Brown (Dark)' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Brown (Medium)' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Brown And Cream' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Brown Ivory Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Bucka-Who?' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Buckaroo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Bum A Smoke' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Buttercup' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'CACTUS BLOOM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'CHARCOAL BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'CHARTRUESE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'CIDER PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'CREAM FRINGE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'CRIMSON RED' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'CRISTAL ROSE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Call Me Wild' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Chaos Came Knocking' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Chaos Is Calling' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'City Girl Pizza' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Cliffhanger' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Cold Brew' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Cool As A Cat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Cosmic Cowgirl' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Cosmic Cowgirl Bar and Grill' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Cosmos' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Cowboys In India' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Cowgirls Only' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Cream' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Crystal Clear' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'DAHLIA' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'DARK HEATHER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Dainty And Dangerous' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Dark Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Dark Ivy' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Day Camp' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Dazzling Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Deep Fried' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Derby Doll' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Desert Sun Palm' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Dilligaf?' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Do Not Disturb' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Dots' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Double Stacked' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Dried Herb' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'ELECTRIC VIOLET' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Escape Goat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Estate Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'F-CKER MAROON' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'FAIREST OF THEM ALL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'FERN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'FRUIT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'FYVM' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Faded Ivy' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Fairest Of Them All' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Farmball' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Faster' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Firecracker' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Fishing On All Sides' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Float My Boat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Floral Frenzy' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Floral Notes' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Fluff' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Fringe Benefits' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Frog Life' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'From The Ground Up' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'GINGER' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'GRANDE POLKA DOT BLACK - TAN' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'GREENER GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'GREY GEM' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Girl With The Pearl' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Go Long' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Gold Mine' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Golden Apricot' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Grand Slam' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Green' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Green (Dark)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Green Thumb With Cherries' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Grey (Dark)' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Grey (Open)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Hard Stop Honey' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Head Rush' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Heirloom' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Hellicopter' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Hey Batter Batter' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Holly Green' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Homecoming High' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Honeysuckle' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'I Confess' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'I Love To Play Tennis' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'In The Lines' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'In The Wild' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Instant Replay' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Intuition Check' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Ivory' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Ivory Red Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Jacquard' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Jade' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Jerky' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Just A Scratch' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Just An Animal' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'KELLY GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'KELLY GREEN - COBALT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Kaboom' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Khaki' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Kissing The Caddy' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Knick Knack Paddy Whack' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Knuckle Down' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'LEMONADE' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lady Wonder' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Laguna Blue' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lake Champion' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lake Life' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lake Scene' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lantana' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Last Bite' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Last Resort' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Laundry Days' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lead Balloon' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Light Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lightning Rod' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lil'' Firework' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Little Maniac' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lost In The Tube' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Lucky Star' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MELON' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MF Flowers' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER 22' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER Flock' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER Mouth' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER Pennant' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER Stars' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER Swirl' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MOTHER Tiger' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'MUSTARD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Made In The Shade' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Madness Is My Method' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Magpie Music' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Medium Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Melt In Your Mouth' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Mermaid Swim Club' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Mixed Media' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Moonbeam Saloon' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Motherline' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Multi Color' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Munchies' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Natural' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Natural Selection' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Navy And Ivory' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Nighty Night' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'No End In Sight' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Not Doing Much' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Not Today Satan' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Off Season' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'On A Roll' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'On Tap' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'One Last Shot' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Open Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Open White' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Orange' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Out Of This World' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Out Thrilling All Thrillers!' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Over The Rainbow' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PANTHERE' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PAPAYA' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PETAL' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PINK DAWN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PINK OMBRE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PINK ORANGE PLAID' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'PINK STRIPES' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'PURPLE - LIGHT BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Palm Canyon Drive' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Patch Mother' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Patriot Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Peach Puree' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pearl Clutcher' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Persian Red' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Picante' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Picket Fence' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pinch Of Salt' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pink' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pink (Bright)' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pink (Dark)' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pink (Light-Pastel)' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pink (Medium)' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pink And Red' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Pinkies Up!' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Pointelle' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Power Boat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Pretty Please' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Prized Possession' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Purple Reign' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'ROSE MIX' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'ROSELARK' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Red' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Red (Bright)' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Red (Dark)' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Red And Navy Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Red Ivory Blue Multi Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Refill' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Retrograde Rodeo' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Riding The Milkyway' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Rolling In The Dough' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Room Service' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Rope Em''' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Rose Bowl' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Rude Crude' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Rum Rasin Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'SANDSTONE' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'SCALLOP BLUSH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'SIDESHOW CHECK' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'SOFT PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Saddle Up' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Sangria' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Sauced By Six' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Secret Ingredient' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'See Ya' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Serve N'' Swerve' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Shaken Not Stirred' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Shooting Stars' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Shrimp Cocktail' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Side Gig' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Sir Yes Sir!' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Skydiver' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Space Western' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Spaced Out' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Spare Me The Drama' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Speed Of Light' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Speed Queen' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Speedway' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Spotted Counter Culture' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Star Dust' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Stargazer' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Starry Eyed' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Start Your Engines!' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Stone Weaver' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Story So Far' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Strike It Rich' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Swim Club' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Sworn To The Sun' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Taking Chances' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Teaberry And Fluff' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Terraforming Mars' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'That Belongs In A Museum' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'The Stud' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Thrill Me' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Thrill Seeker' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Tomato Red' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Tomorrow Never Knows' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Tootsie' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Totally Innocent' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Track Star' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Tracker' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Trail Blazer' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'True Blue And Fluff' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Twist Of Fate' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'UMBER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Dark')
   where brand_key = 'mother' and color_name = 'Unplugged' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'WILD PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'We Tried' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Western MOTHER' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Where The Wildflowers Grow' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Medium')
   where brand_key = 'mother' and color_name = 'Whisk Me Away' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'White' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'White (Natural)' and base_color is null;
  update public.brand_colorways set base_color = 'Ivory', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'White (Open)' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'White And Blue Stripe' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Winter Wheat' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, 'Light')
   where brand_key = 'mother' and color_name = 'Wish Upon A Star' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Yellow' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Yellow (Gold)' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Yellow (Light-Pastel)' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Yellow (Medium)' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'mother' and color_name = 'Zinfandel' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ABSTRACT DOT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ABSTRACT ZEBRA' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ANTIQUE' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'APRICOT GELATO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'AQUA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ARUBA BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'AUTUMN BLAZE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BANANA LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BAY GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BEIGE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BEIGE SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BEIGE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BIJOU BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BIRCH WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK BOX' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK CROCO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK CROCODILE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK DENIM' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK DISTRESSED' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK DITSY FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK EEL' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK GLAZED' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK GOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK HICKORY' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK LACE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK LEAT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK LEATHER WITH SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK LIZARD' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK MESH' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK NATURAL' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK NUBUCK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK NUDE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK RED' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK SEQUIN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK SILVER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK TAN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK TECHNO SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK VELVET' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK WHITE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK WHITE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK ZEBRA' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK/BEIGE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK/BLACK SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK/NUDE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLACK/WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLK DISTRS' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLOOM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE CROCODILE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE DEPTHS' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE ICE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE MESH' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUE YELLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUING' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLURRY FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH LILAC' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH MESH' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH PLAID' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BLUSH SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE CROCODILE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE MESH' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE PEARLIZED' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE RED' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BONE SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BRIGHT MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BRN DISTRESSED' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BRONZE' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BRONZE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BRONZE RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN BOX' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN CROCODILE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN DISTRESSED' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN EEL' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN OLIVE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN PLAID' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN SUED' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN TAN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN VELVET' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN-TAN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BROWN/WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BSH BOX LEA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BURGUNDY' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BURGUNDY EEL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BURGUNDY LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BURGUNDY TECHNO SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BURNT CORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BUTTER LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'BUTTER YELLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CAMEL PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CAMEL SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CAMEO PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CARAMEL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CARAMEL ZEBRA' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CARGO' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHALK' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHAMPAGNE' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHAMPAGNE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHARCOAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHARCOAL MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHEETAH PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHERRY PEARL' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHERRY RED' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHESTNUT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHESTNUT MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHESTNUT SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHICORY COFFEE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHO BRN SD' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHOCOLATE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CHOCOLATE BROWN SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CITRUS' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CITRUS MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CLEAR' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COBALT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COBALT PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COCO' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COCOA BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COGNAC' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COGNAC DISTRESSED' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COGNAC LEA' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COGNAC LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COGNAC MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COGNAC PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'COGNAC SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CORAL CLOUD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CORAL MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CORDOVAN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CORDUROY' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CREAM' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'CREAM MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK BROWN SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK CHOCOLATE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK ESPRESSO' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK FUCHSIA LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK GREEN EEL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK GREEN LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK GREY SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK OLIVE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK RED' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK TAN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DARK TAUPE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DAWN PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DECO ROSE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DEEP FIG' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DELFT BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DENIM' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DENIM FABRIC' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DENIM MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DENIM SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DISTRESSED BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DUBERRY' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'DUSTY LAVENDER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'EGRET' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ENGLISH ROSE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ESPRESSO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ESTATE BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'EVERGLADE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FADED BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FAWN' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FIR GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FLORAL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FLORAL MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FOG' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FOREST GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FOREVER BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FOSSIL BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FRENCH BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FRUIT MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FUCHSIA' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FUCHSIA PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FUCHSIA RED' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FULL BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'FUR PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GOLD GLITTER' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GOLD LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GOLD MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GOLD RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GOLDEN LIME' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREEN LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREEN MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREEN OLIVE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREEN SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREY DISTR' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREY FLANNEL' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREY LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREY SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GREY SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'GRIFFIN GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HAZEY BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HEATHER GRAY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HEATHER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HICKORY SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HONEY' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HOT PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HOT PINK SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'HOT SPOTS PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ICE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'IMPERIAL BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'INDIGO' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'INDIGO HAZE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'INK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'IVORY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'IVORY BURGUNDY' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'IVORY MESH' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'IVORY MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'IVORY SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'KHAKI FAB' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LAVA FLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LAVENDER' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LEMON' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LEOPARD SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LEOPARD SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIGHT BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIGHT GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIGHT GREY SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIGHT HEATHER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIGHT NATURAL' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIGHT PINK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIGHT TAUPE WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LILAC' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIME LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIME PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LIME PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'LINEN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MARBLE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MARINE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MAUVE SHADOWS' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MEDIUM KHAKI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'METALLIC' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'METALLIC MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MIDNIGHT' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MIDNIGHT BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MIDNIGHT SKY' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MINT' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MOCHA' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MOCHA HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MOCHA SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MOCHA SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MOON SHADOW' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MOUNTAIN GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MULTI GLITTER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MULTI RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MULTICOLOR' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'MUSTARD' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NATURAL' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NATURAL GOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NATURAL LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NATURAL LINEN' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NATURAL MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NATURAL RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NATURAL SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NAVY SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NAVY WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NEON GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'NUTSHELL' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OFF WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OFF WHITE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OFF WHITE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OFF-WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OILSLICK' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OILSPILL' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OLIVE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OLIVE HEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OLIVE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OLIVE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OLIVE PLAID' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OLIVE SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'OLIVE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ORANGE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PALE YELLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PASTEL MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PEACH BEIGE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PEARL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PETAL PAISLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PEWTER' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PEWTER METALLIC' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK METALLIC' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK NUBUCK' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK PRINT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK TAFFY' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK VELVET' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK VIOLET' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PINK/BLE' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PISTACHIO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PLAID' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PLUM' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PLUM LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PORT' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'POWDER PUFF' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PRISTINE IVORY' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PURPLE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PURPLE CROCODILE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PURPLE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PURPLE SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'PURPLE WINE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RAFFIA MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RAINBOW MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RAINBOW VISION' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RAVEN' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED CRINKLE PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED CROCODILE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED EEL' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED OMBRE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED ORANGE PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED PEARL' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RED VELVET' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RHINESTONE' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RHINESTONES' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ROSE DAWN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ROSE FROST' and base_color is null;
  update public.brand_colorways set base_color = 'Gold', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ROSE GOLD' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ROSE NUDE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ROSEBUD' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RUST' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RUST LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'RUST MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SALSA RED' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SAND' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SAND SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SEA MIST' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SEABREEZE BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SEQUIN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SHAVED CHOCOLATE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SHEARLING' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SHELL' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SILVER' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SILVER CRINKLE' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SILVER GLITTER' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SILVER GREY' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SILVER LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SILVER MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SILVER PINK' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SMOKE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SMOKEY BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SNAKE MUL' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SNAKE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SNOW WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SPOT LEOPARD' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'STORM BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'STRIPE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SULPHUR SPRING' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'SURF BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN DENIM' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN NUBUCK' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN SNAKE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAN SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAUPE' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TAUPE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TEAL PAISLEY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TEAL SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TEAL SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TERRACOTTA' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'THYME GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TIE DYE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TIGER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TIGERLILY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TIRAMISU' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TOBACCO' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TORTOISE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TORTOISE CROCODILE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TORTOISE PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TROPICAL BREEZE' and base_color is null;
  update public.brand_colorways set base_color = 'Silver', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TURQUOISE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TURQUOISE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'TURQUOISE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'UMBER' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'UMBER SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'VANILLA' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'VINTAGE BLUE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'VINTAGE IVORY' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'VINTAGE NAVY' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WALNUT' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WASHED BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHEAT' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHEAT NUBUCK' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE BLACK' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE BROWN LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE CRACKLE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE DISTRESSED' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE GREEN' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE LACE' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE LEATHER' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE MESH' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE SATIN' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE SUEDE' and base_color is null;
  update public.brand_colorways set base_color = 'Beige', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WHITE/DENIM' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WINE' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WINE PATENT' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'WOLF BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'YELLOW' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ZEBRA' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ZEBRA BROWN' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ZEBRA MULTI' and base_color is null;
  update public.brand_colorways set base_color = 'Multicolor', shade = coalesce(shade, null)
   where brand_key = 'stevemadden' and color_name = 'ZEBRA RAFFIA' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Amazon Green' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Baby Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Black' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Brick Red' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Bright Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Bright Green' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Bright Orange' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Bright Pink' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Bright White' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Brown' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Cactus Flower' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Chalk White' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Charcoal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Dark Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Dark Green' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Dark Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Dark Purple' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Dark Red' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Dusty Pink' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Egret White' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Emerald Green' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Forest Green' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Gold' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Green' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Heather Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Heather Olive' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Heather Red' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Hthr Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Hthr Lavendula' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Indigo' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Brown' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Green' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Pink' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Purple' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Red' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Light Yellow' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Maroon' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Meadow' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Mid Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Mid Green' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Mid Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Mid Pink' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Mid Red' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Navy' and base_color is null;
  update public.brand_colorways set base_color = 'Orange', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Orange' and base_color is null;
  update public.brand_colorways set base_color = 'Brown', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Pecan' and base_color is null;
  update public.brand_colorways set base_color = 'Pink', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Pink' and base_color is null;
  update public.brand_colorways set base_color = 'Purple', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Purple' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Red' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Rhododendron' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Sea Green' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Shadow' and base_color is null;
  update public.brand_colorways set base_color = 'Green', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Slate Grey' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Soft Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Black', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Solid Black' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Stone' and base_color is null;
  update public.brand_colorways set base_color = 'Red', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Syrah' and base_color is null;
  update public.brand_colorways set base_color = 'Tan', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Tan' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Teal' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Teal Blue' and base_color is null;
  update public.brand_colorways set base_color = 'Blue', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'True Navy' and base_color is null;
  update public.brand_colorways set base_color = 'Gray', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Urban Chic' and base_color is null;
  update public.brand_colorways set base_color = 'White', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'White' and base_color is null;
  update public.brand_colorways set base_color = 'Yellow', shade = coalesce(shade, null)
   where brand_key = 'untuckit' and color_name = 'Yellow' and base_color is null;
end $$;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00738') on conflict do nothing;
