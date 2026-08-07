import { Link } from "react-router";
import { Loader2, Lock, ShieldCheck, ShieldOff, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import {
  useBuyerPurchases,
  type PurchaseWithCaptures,
} from "@/hooks/use-buyer-purchases";
import type { BuyerGuaranteeClaimStatus } from "@/types/database";

// US-2073: the buyer-facing Purchase Guarantee COVERAGE surface.
//
// purchaseGuarantee is a PAID entitlement (Guard + Connoisseur), and the whole
// backend has existed for a while — claim intake, admin review/resolve, the pool
// cron, and a working claim form. What was missing was the buyer's view of it:
// /buyer/guarantee rendered a "coming soon" placeholder, so a subscriber was
// told the feature they pay for hadn't shipped. US-2042 made the placeholder
// link to the claim form as an immediate stopgap; this replaces it.
//
// Deliberately a PRESENTATION layer over data useBuyerPurchases already fetches
// (purchase_coverage + buyer_guarantee_claims are both in its Promise.all), so
// this adds no new queries and cannot drift from what the rewards page shows.

function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function purchaseLabel(p: PurchaseWithCaptures): string {
  const brand = p.brand?.trim();
  const title = p.title?.trim();
  if (brand && title) return `${brand} · ${title}`;
  return brand || title || "Untitled item";
}

/** Human copy for the machine reason on an ineligible row. */
function ineligibleCopy(reason: string | null): string {
  switch (reason) {
    case "plan_not_covered":
      return "Your plan didn't include the guarantee when this was purchased.";
    case "window_expired":
      return "The coverage window for this purchase has closed.";
    case "no_certificate":
      return "This purchase isn't linked to a verifiable certificate.";
    default:
      // Never render a raw machine token at a buyer — but don't invent a
      // specific reason we don't have either.
      return "This purchase isn't covered. Contact support if that looks wrong.";
  }
}

const CLAIM_LABEL: Record<BuyerGuaranteeClaimStatus, string> = {
  auto_approved: "Approved",
  approved: "Approved",
  manual_review: "In review",
  rejected: "Not approved",
  paid: "Paid out",
};

function claimTone(status: BuyerGuaranteeClaimStatus): string {
  if (status === "paid" || status === "approved" || status === "auto_approved") {
    return "border-emerald-300 text-emerald-700 dark:border-emerald-900/50 dark:text-emerald-400";
  }
  if (status === "manual_review") {
    return "border-amber-300 text-amber-700 dark:border-amber-900/50 dark:text-amber-400";
  }
  return "border-muted-foreground/30 text-muted-foreground";
}

export function BuyerCoveragePage() {
  const ent = useBuyerEntitlements();
  const { purchases, isLoading, isError } = useBuyerPurchases();

  // Entitlement gate first — mirrors BuyerPlaceholderPage's locked branch so the
  // upgrade path stays identical wherever a buyer meets a gated feature.
  if (!ent.has("purchaseGuarantee")) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <Lock className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-bold">Purchase Guarantee</h1>
          <p className="text-sm text-muted-foreground">
            Grade-locked coverage on eligible purchases is part of a higher buyer
            plan. Upgrade to unlock it.
          </p>
          <Link
            to="/buyer/billing?upgrade=purchaseGuarantee"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            See plans
          </Link>
        </Card>
      </div>
    );
  }

  const covered = purchases.filter((p) => p.coverage?.eligible);
  const notCovered = purchases.filter((p) => p.coverage && !p.coverage.eligible);
  const claims = purchases.filter((p) => p.claim);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Purchase Guarantee"
        subtitle="If a graded item arrives materially worse than its certificate says, you're covered. Coverage is applied automatically to eligible purchases — nothing to activate."
      />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : isError ? (
        /* US-2026: a failed load must never render as "you have no coverage" —
           on this page that would tell a paying subscriber their protection is
           gone, which is the most alarming possible false empty state. */
        <ErrorState
          title="Couldn't load your coverage"
          description="Your coverage is unaffected — we just couldn't fetch it right now."
          onRetry={() => window.location.reload()}
        />
      ) : (
        <>
          {/* ── Covered ─────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
                Covered purchases
              </CardTitle>
              <Badge variant="secondary">{covered.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {covered.length === 0 ? (
                <EmptyState
                  icon={ShieldCheck}
                  title="No covered purchases yet"
                  description="Link a graded item you bought and eligible purchases will show their coverage here automatically."
                />
              ) : (
                covered.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {purchaseLabel(p)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Covered until {shortDate(p.coverage?.covered_until)} ·
                        Up to {money(p.coverage?.payout_cap_cents)} · Triggers at
                        a {p.coverage?.grade_delta_threshold}-point grade
                        difference
                      </p>
                    </div>
                    {p.claim ? (
                      <Badge variant="outline" className={claimTone(p.claim.status)}>
                        {CLAIM_LABEL[p.claim.status]}
                      </Badge>
                    ) : (
                      <Button asChild size="sm" variant="outline">
                        <a
                          href={`/buyer-guarantee/claim?cert=${encodeURIComponent(
                            p.certificate_id,
                          )}`}
                        >
                          File a claim
                        </a>
                      </Button>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* ── Claims ──────────────────────────────────────────── */}
          {claims.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="h-4 w-4 text-amber-600" />
                  Your claims
                </CardTitle>
                <Badge variant="secondary">{claims.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                {claims.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {purchaseLabel(p)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.claim!.remedy_cents > 0 || p.claim!.remedy_credits > 0
                          ? `Remedy: ${money(p.claim!.remedy_cents)}${
                            p.claim!.remedy_credits > 0
                              ? ` + ${p.claim!.remedy_credits} credits`
                              : ""
                          }`
                          : p.claim!.decision_reason ||
                            "We'll email you when there's a decision."}
                      </p>
                    </div>
                    <Badge variant="outline" className={claimTone(p.claim!.status)}>
                      {CLAIM_LABEL[p.claim!.status]}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* ── Not covered ─────────────────────────────────────── */}
          {notCovered.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldOff className="h-4 w-4 text-muted-foreground" />
                  Not covered
                </CardTitle>
                <Badge variant="secondary">{notCovered.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Showing WHY, not just that it isn't covered — an unexplained
                    exclusion on a paid feature reads as the product failing. */}
                {notCovered.map((p) => (
                  <div key={p.id} className="rounded-lg border p-3">
                    <p className="truncate text-sm font-medium">
                      {purchaseLabel(p)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {ineligibleCopy(p.coverage?.ineligible_reason ?? null)}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* US-1846: the terms this page is actually bound by, stated on it.
              It previously said only "coverage terms are on the guarantee
              page", and /buyer-guarantee is the US-867 MEDIATION policy — it
              does not describe this paid, snapshotted coverage at all. So a
              subscriber was told "you're covered" and pointed at a document
              about something else.

              The two facts a buyer would never guess are here in full: the
              terms are FROZEN at link time (which is what protects them from a
              later downgrade, and equally what stops an upgrade from widening
              an old purchase), and this is a service remedy, not an insurance
              product. Both are stated as limits on the promise rather than as
              features of it. */}
          <div className="space-y-2 rounded-lg bg-muted/40 p-4 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">
                What decides a claim.
              </span>{" "}
              Each covered purchase is judged against the coverage window,
              payout cap and grade-difference threshold shown on its row —
              the terms that applied when you linked the purchase, frozen at
              that moment. Changing plan later never voids coverage already in
              force, and never widens it either.
            </p>
            <p>
              <span className="font-medium text-foreground">
                What it is not.
              </span>{" "}
              The Purchase Guarantee is a GradeThread remedy, not insurance,
              and not a valuation or authenticity warranty. Grades on both
              sides of the comparison are condition estimates from photos, so a
              claim turns on a material difference between them — not on
              disappointment with the item, the seller, or the price.
            </p>
            <p>
              Full policy, eligibility and the mediation route are on the{" "}
              <Link
                to="/buyer-guarantee"
                className="font-medium text-primary hover:underline"
              >
                guarantee page
              </Link>
              .
            </p>
          </div>
        </>
      )}
    </div>
  );
}
