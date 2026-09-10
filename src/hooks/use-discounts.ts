// US-3299: the live sale campaigns, for every pricing surface.
//
// Reads discount_campaigns straight from Supabase rather than through the edge,
// so it works logged out — the public pricing page is the surface that matters
// most and has no session. The RLS policy (00778) already narrows the read to
// campaigns that are live right now AND have a minted Stripe coupon.
//
// FAIL-SAFE: an error resolves to an empty list, which prices everything at list
// price. That is the safe direction to be wrong in. The alternative — a card
// advertising a discount that checkout then refuses — is the failure this whole
// feature is built around avoiding.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { DiscountCampaign, DiscountTarget, ResolvedDiscount } from "@/lib/discounts";
import { liveCampaigns, resolveDiscount } from "@/lib/discounts";
import type { DiscountCampaignRow } from "@/types/database";

const EMPTY: DiscountCampaign[] = [];

const SELECT_COLS =
  "id, name, description, discount_type, percent_off, amount_off_cents, " +
  "starts_at, ends_at, enabled, targets, applies_to_all, stripe_coupon_id";

async function fetchCampaigns(): Promise<DiscountCampaign[]> {
  const { data, error } = await supabase.from("discount_campaigns").select(SELECT_COLS);
  if (error) throw error;
  const rows = (data ?? []) as unknown as DiscountCampaignRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    discount_type: r.discount_type,
    // numeric(5,2) arrives from PostgREST as a string, so a bare `r.percent_off`
    // would make every comparison in the resolver a string comparison.
    percent_off: r.percent_off === null ? null : Number(r.percent_off),
    amount_off_cents: r.amount_off_cents === null ? null : Number(r.amount_off_cents),
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    enabled: r.enabled,
    targets: Array.isArray(r.targets) ? (r.targets as DiscountCampaign["targets"]) : [],
    applies_to_all: r.applies_to_all,
    stripe_coupon_id: r.stripe_coupon_id,
  }));
}

export interface UseDiscountsResult {
  campaigns: DiscountCampaign[];
  /** Campaigns live at this instant, newest window first. Drives the sale banner. */
  live: DiscountCampaign[];
  /** The best live campaign for one package, or null. */
  priceFor: (target: DiscountTarget, originalCents: number) => ResolvedDiscount | null;
  isLoading: boolean;
}

export function useDiscounts(): UseDiscountsResult {
  const { data, isLoading } = useQuery({
    queryKey: ["discount-campaigns"],
    queryFn: fetchCampaigns,
    staleTime: 5 * 60 * 1000,
    // So a pricing page always has a list to render against, never undefined.
    placeholderData: EMPTY,
    retry: 1,
  });

  const campaigns = data ?? EMPTY;
  return {
    campaigns,
    live: liveCampaigns(campaigns),
    // NOT memoised on purpose: the resolver re-reads Date.now() every call, which
    // is what lets a campaign stop applying the moment its window closes even
    // though the query result is cached for five minutes.
    priceFor: (target, originalCents) => resolveDiscount(campaigns, target, originalCents),
    isLoading,
  };
}
