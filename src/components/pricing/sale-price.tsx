// US-3299: how a discounted price is shown, everywhere.
//
// One component so the sale reads the same on the marketing page, the in-app
// billing page and every upgrade dialog. With no live campaign it renders the
// plain price and nothing else, which makes it a drop-in for the `dollars(...)`
// call it replaces.
//
// Design: the badge is a filled brand-red pill and the banner has no colored
// left border — both of those are anti-patterns `npm run ui:check` enforces at
// zero. No gradient anywhere; the emphasis is weight and size.

import { cn } from "@/lib/utils";
import { useDiscounts } from "@/hooks/use-discounts";
import type { DiscountTarget, ResolvedDiscount } from "@/lib/discounts";
import { dollarsExact } from "@/lib/discounts";

interface SalePriceProps {
  originalCents: number;
  target: DiscountTarget;
  /** Wraps the discounted price. Put the size and weight here. */
  className?: string;
  /** Wraps the struck-through original. */
  originalClassName?: string;
  /** Hide the "20% off" pill — for dense rows where the banner already says it. */
  hideBadge?: boolean;
  /** Suffix rendered inside the price, e.g. "/mo". */
  suffix?: string;
}

/**
 * A price, discounted if a campaign covers it.
 *
 * Zero-price packages are never discounted (owner decision 2026-09-09), which
 * resolveDiscount enforces — so the free plan card renders "$0" with no badge.
 */
export function SalePrice({
  originalCents,
  target,
  className,
  originalClassName,
  hideBadge,
  suffix,
}: SalePriceProps) {
  const { priceFor } = useDiscounts();
  const sale = priceFor(target, originalCents);

  if (!sale) {
    return (
      <span className={className}>
        {dollarsExact(originalCents)}
        {suffix ? <span className="text-base font-normal">{suffix}</span> : null}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span
        className={cn("text-muted-foreground line-through", originalClassName)}
        // The old price is decoration for a sighted reader and noise for a screen
        // reader, which would otherwise announce two prices with no way to tell
        // which one is charged.
        aria-hidden="true"
      >
        {dollarsExact(sale.originalCents)}
      </span>
      <span className={className}>
        {dollarsExact(sale.finalCents)}
        {suffix ? <span className="text-base font-normal">{suffix}</span> : null}
      </span>
      {hideBadge ? null : <SaleBadge sale={sale} />}
    </span>
  );
}

export function SaleBadge({ sale, className }: { sale: ResolvedDiscount; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-brand-red px-2 py-0.5 text-xs font-semibold text-white",
        className,
      )}
    >
      {sale.label}
    </span>
  );
}

/**
 * The strip at the top of a pricing page while a sale is running.
 *
 * Renders nothing when nothing is live, so it can sit unconditionally in the
 * page. Only the newest campaign is announced: two banners is a page that looks
 * broken, and the per-card badges already carry the detail.
 */
export function SaleBanner({ className }: { className?: string }) {
  const { live } = useDiscounts();
  const campaign = live[0];
  if (!campaign) return null;

  const ends = new Date(campaign.ends_at).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });

  return (
    <div
      className={cn(
        "rounded-xl bg-brand-red px-5 py-3 text-center text-white",
        className,
      )}
      role="status"
    >
      <p className="text-sm font-semibold sm:text-base">{campaign.name}</p>
      {campaign.description
        ? <p className="mt-0.5 text-sm text-white/90">{campaign.description}</p>
        : null}
      <p className="mt-0.5 text-xs text-white/85 sm:text-sm">Ends {ends}</p>
    </div>
  );
}
