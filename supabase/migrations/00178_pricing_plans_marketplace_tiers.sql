-- US-718: make plan pricing tell the truth about marketplace capability.
--
-- 00166 seeded every tier with marketplaces_cap = 1 and "eBay only"/"more
-- marketplaces coming soon" copy, back when only eBay published. Since then
-- Shopify (US-599) ships live via API, the GradeThread Lister browser extension
-- (US-716) cross-lists to Poshmark/Mercari/Grailed, and the one-draft fan-out
-- (US-717) is wired across the real connector set. With cap = 1 a paid user who
-- connects eBay is BLOCKED from also connecting Shopify — the shipped feature is
-- unreachable. This migration raises the cap and corrects the feature copy on
-- the paid tiers (Free stays eBay-only as the upsell).
--
-- 00166 used ON CONFLICT DO NOTHING, so on an already-seeded prod DB the new
-- values never landed — hence an explicit UPDATE here. Each UPDATE is GUARDED on
-- the stale launch value so a deliberate operator override (set later via the
-- admin pricing route) is never clobbered.

-- Paid tiers: -1 = all available marketplaces (eBay + Shopify API today, the
-- extension channels, Depop once approved). Only bump rows still at the old cap.
update public.pricing_plans
  set marketplaces_cap = -1
  where key in ('starter', 'pro', 'business')
    and marketplaces_cap = 1;

-- Replace the stale "eBay listings & sync (more marketplaces coming soon)"
-- bullet with the honest capability copy, only where it still reads the old way.
update public.pricing_plans
  set features = (
    select jsonb_agg(
      case
        when elem = '"eBay listings & sync (more marketplaces coming soon)"'::jsonb
          then '"eBay + Shopify listings & sync (live API)"'::jsonb
        else elem
      end
    )
    from jsonb_array_elements(features) as elem
  )
  where key in ('starter', 'pro', 'business')
    and features @> '["eBay listings & sync (more marketplaces coming soon)"]'::jsonb;

-- Add the cross-list-via-extension bullet right after the eBay+Shopify line,
-- only if it isn't already present (idempotent on re-run).
update public.pricing_plans
  set features = (
    select jsonb_agg(part order by ord)
    from (
      select elem as part, ord
        from jsonb_array_elements(features) with ordinality as t(elem, ord)
      union all
      -- ord 2.5 slots it immediately after the "eBay + Shopify …" bullet (ord 2).
      select
        '"Cross-list to Poshmark, Mercari & Grailed via the GradeThread Lister extension"'::jsonb,
        2.5
    ) merged
  )
  where key in ('starter', 'pro', 'business')
    and features @> '["eBay + Shopify listings & sync (live API)"]'::jsonb
    and not (features @> '["Cross-list to Poshmark, Mercari & Grailed via the GradeThread Lister extension"]'::jsonb);
