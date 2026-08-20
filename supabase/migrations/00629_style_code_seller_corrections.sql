-- 00629 — a seller's correction teaches the style-code index (US-2692)
--
-- When we put the wrong product name on an item and the seller fixes it, that
-- correction is the best evidence in the system: they are holding the garment
-- and reading the tag. Today it dies on that one item, and the next copy of the
-- same garment gets the same wrong name.
--
-- WHY A TRIGGER AND NOT A ROUTE. The item editor
-- (src/pages/flipdesk/composer.tsx) writes inventory_items DIRECTLY through the
-- supabase client under RLS. A correction never passes through the edge
-- service, so there is no handler to hook. A trigger catches the web app, the
-- edge, iOS and Android in one place, and it is tenant-safe by construction: it
-- only fires on a row the writer was already allowed to update.
--
-- WHY IT IS FUSSY ABOUT WHAT COUNTS AS A CORRECTION. inventory_items.style is
-- OVERLOADED. It holds the product/model name when we wrote it (applyLearnedStyle
-- and the pack fingerprint both write suggestions.style), and it holds the eBay
-- "Style" ASPECT when 00348's backfill wrote it — values like "Cargo" or
-- "Bootcut". Recording every style change as a product name would teach the
-- index that LM7A83S is called "Cargo". So the trigger fires only when WE
-- proposed the previous value, and only for a value that could be a name.
--
-- Records WHAT was corrected, never BY WHOM: no owner id reaches
-- style_code_names, in keeping with 00503, 00627 and 00628.

CREATE OR REPLACE FUNCTION public.capture_style_code_name_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_raw    text;
  v_code_norm   text;
  v_brand_key   text;
  v_resolved    text;
  v_prior_src   text;
  v_new_style   text;
BEGIN
  v_new_style := btrim(coalesce(NEW.style, ''));

  -- A name is at least two words. One word is a category ("Cargo", "Slim"),
  -- and the eBay Style aspect is almost always one word — which is most of
  -- what separates an aspect from a product name without a second column.
  IF v_new_style = '' THEN RETURN NEW; END IF;
  IF array_length(regexp_split_to_array(v_new_style, '\s+'), 1) < 2 THEN
    RETURN NEW;
  END IF;

  -- Only when WE named it and the seller replaced our answer. A blank-to-value
  -- edit on an item nothing ever named is a seller filling in a field, which is
  -- not evidence that our answer was wrong — we never gave one.
  v_prior_src := OLD.ai_field_sources -> 'style' ->> 'source';
  IF v_prior_src IS NULL
     OR v_prior_src NOT IN ('learned', 'research', 'decoder', 'pack-fingerprint')
  THEN
    RETURN NEW;
  END IF;

  v_code_raw := btrim(coalesce(NEW.attributes ->> 'style_code', ''));
  IF v_code_raw = '' THEN RETURN NEW; END IF;
  -- Must match normalizeStyleCode() in style-code-observations.ts exactly, and
  -- MIN_STYLE_CODE_LENGTH with it: below four characters a code matches
  -- everything and is not an identity.
  v_code_norm := upper(regexp_replace(v_code_raw, '[^A-Za-z0-9]', '', 'g'));
  IF length(v_code_norm) < 4 THEN RETURN NEW; END IF;

  -- The READ side keys on brandKey(canonicalizeBrand(brand)), so a raw alias
  -- spelling has to be resolved or the correction lands in a namespace nothing
  -- reads. brand_knowledge.aliases holds the same normalized keys the TypeScript
  -- alias map does; an unknown brand passes through unchanged, which is what
  -- canonicalizeBrand does too.
  v_brand_key := lower(regexp_replace(coalesce(NEW.brand, ''), '[^A-Za-z0-9]', '', 'g'));
  SELECT bk.brand_key INTO v_resolved
  FROM public.brand_knowledge bk
  WHERE bk.brand_key = v_brand_key OR v_brand_key = ANY (bk.aliases)
  LIMIT 1;

  PERFORM public.record_style_code_name(
    coalesce(v_resolved, v_brand_key),
    v_code_norm,
    v_code_raw,
    v_new_style,
    'seller',
    1,
    -- Above a market consensus (0.75 cap) and below the weakest decoder (0.85).
    -- The ORDER that matters is by source, in lib/style-code-names.ts; this
    -- number only feeds the extraction's field confidence.
    0.80,
    NULL
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Learning must NEVER block a seller's save. A failure here is a lost
  -- observation, not a lost edit.
  RAISE WARNING 'capture_style_code_name_correction failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_style_code_name_correction_trg
  ON public.inventory_items;
-- WHEN in the trigger, not IF in the body: inventory_items is updated constantly
-- and almost never has its style changed, so the common path must not even call
-- the function.
CREATE TRIGGER capture_style_code_name_correction_trg
  AFTER UPDATE OF style ON public.inventory_items
  FOR EACH ROW
  WHEN (NEW.style IS DISTINCT FROM OLD.style)
  EXECUTE FUNCTION public.capture_style_code_name_correction();

-- ── The alias 00390 tried to seed and could not ─────────────────────────────
--
-- 00390 inserts lululemon with aliases ARRAY['lululemon','lulu'], but its
-- ON CONFLICT (brand_key) DO UPDATE clause updates category_focus, tag_eras,
-- authentication_tells, notes, source_url, confidence, verified and updated_by
-- — NOT aliases. 00389 had already inserted the row (seeded from
-- brand-normalize.ts, which also lacked 'lulu'), so the widening was discarded
-- on conflict and prod has had ARRAY['lululemon'] ever since.
--
-- It matters here because "Lulu" is what sellers type, and an unresolved alias
-- gets its own brand key: a style code learned from a "Lulu" item was never read
-- back for a "Lululemon" one. The TypeScript alias map gains the same entry in
-- this commit, so both sides of the lookup agree.
--
-- ⚠ ONLY LULULEMON IS REPAIRED HERE. Eleven brand_knowledge packs have the same
-- omission in their conflict clause, but only three actually intended a wider
-- list, and of those, louisvuitton already has its aliases (00389 seeded them)
-- and ralphlauren's intended 'poloralphlauren' CONTRADICTS brand-normalize.ts,
-- which maps that key to the separate canonical brand "Polo Ralph Lauren".
-- That one is a brand-taxonomy decision, not a mechanical repair.
-- ⚠ tag_eras IS REWRITTEN IN THE SAME STATEMENT AND HAS TO BE. A later
-- migration added CHECK (tag_eras_all_sourced(tag_eras)) as NOT VALID, which
-- grandfathers existing rows but re-checks any row that is UPDATED. Lululemon's
-- two eras carry a `years` that names a four-digit year and no per-era
-- source_url or confidence, so the row could not be touched at all — the alias
-- repair fails with brand_knowledge_tag_eras_sourced until the eras are sourced.
-- Same text, same source as the row already cites, now per-era.
update public.brand_knowledge
set aliases = (
      select array_agg(distinct a order by a)
      from unnest(aliases || ARRAY['lulu']::text[]) a
    ),
    tag_eras = $j$[
      {"era":"2017-2018","years":"2017-2018",
       "description":"Style number is the first 6 characters including the W/M prefix, with no season/year suffix.",
       "source_url":"https://theresaledoctor.com/lululemon-style-number/","confidence":0.85},
      {"era":"2019-present","years":"2019+",
       "description":"Style number: W/M + 5 letters/numbers + \".\" + 4 digits (SSYY). Last letter before the period is the first letter of the color.",
       "source_url":"https://theresaledoctor.com/lululemon-style-number/","confidence":0.90}
    ]$j$::jsonb,
    updated_by = 'migration:00629'
where brand_key = 'lululemon'
  and not ('lulu' = any (aliases));

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00629') on conflict do nothing;
