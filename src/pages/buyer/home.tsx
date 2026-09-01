import { ExtensionInstallCta } from "@/components/marketing/extension-install-cta";
import { BUYER_HOME_CTA } from "@/lib/seo/extension-cta-copy";
import { useEffect } from "react";
import { Link, Navigate } from "react-router";
import { Bell, Gift, Leaf, Share2, ShieldCheck, Shirt } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { useAuthStore } from "@/stores/auth-store";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerPreferences } from "@/hooks/use-buyer-preferences";
import { useBuyerImpact } from "@/hooks/use-buyer-impact";
import { TrustLevelCard } from "@/components/buyer/trust-level-card";
import { ClaimedResultCard } from "@/components/buyer/claimed-result-card";
import { ActivationChecklist } from "@/components/onboarding/activation-checklist";
import { BuyerActivity } from "@/components/buyer/buyer-activity";
import { BUYER_PLANS } from "@/lib/constants";
import { trackBuyerFunnel } from "@/lib/buyer-analytics";

// US-1842: circularity impact receipt — the environmental good of buying
// secondhand, aggregated across the buyer's confirmed purchases (US-1785
// methodology, a labeled estimate). Shareable for a growth loop.
function BuyerImpactCard() {
  const { data } = useBuyerImpact();
  if (!data || data.confirmedItems === 0) return null;
  const { impact } = data;

  async function onShare() {
    const text =
      `By buying ${data!.confirmedItems} item${data!.confirmedItems === 1 ? "" : "s"} secondhand on GradeThread, ` +
      `I've saved ~${impact.co2e_kg}kg CO₂e and ~${impact.water_liters.toLocaleString()}L of water vs buying new. ` +
      `#GradeThread #SecondhandFirst`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) await navigator.share({ title: "My GradeThread impact", text });
      else { await navigator.clipboard.writeText(text); toast.success("Impact copied — share it anywhere."); }
    } catch { /* share sheet cancelled */ }
  }

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Leaf className="h-5 w-5 text-emerald-600" />
          <h2 className="font-semibold">Your circularity impact</h2>
        </div>
        <Button variant="outline" size="sm" onClick={onShare}>
          <Share2 className="mr-1 h-3.5 w-3.5" /> Share
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-xl font-bold tabular-nums">{impact.co2e_kg}</p>
          <p className="text-xs text-muted-foreground">kg CO₂e saved</p>
        </div>
        <div>
          <p className="text-xl font-bold tabular-nums">{impact.water_liters.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">L water saved</p>
        </div>
        <div>
          <p className="text-xl font-bold tabular-nums">{data.confirmedItems}</p>
          <p className="text-xs text-muted-foreground">items kept in use</p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Compared with making the same garments new. A careful estimate, and
        labelled as one.
      </p>
    </Card>
  );
}

// US-1802: buyer home. Guidance to first value — run an extension
// second-opinion, set a condition alert, save a graded item — plus
// entitlement-aware tiles into the buyer feature suite.
//
// US-2553: the get-started cards were a static array with no completion
// tracking, so a buyer with five live alerts was still told to create one and
// the cards never went away. They live in BuyerFirstSteps now, which reads the
// real signals and self-hides. The page also shows what the buyer has actually
// DONE (BuyerActivity) — both feeds already existed and were already recorded;
// nothing here read them.

export function BuyerHomePage() {
  const profile = useAuthStore((s) => s.profile);
  const ent = useBuyerEntitlements();
  const { preferences, isLoading: prefsLoading } = useBuyerPreferences();
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

  // US-1845: retention. A buyer opening the home page on a LATER day than they
  // signed up is the whole signal — firing on day zero would count the signup
  // itself as a return and make retention read as 100%.
  const signedUpAt = profile?.created_at ?? null;
  const buyerPlan = ent.plan;
  useEffect(() => {
    if (!signedUpAt) return;
    const days = Math.floor((Date.now() - new Date(signedUpAt).getTime()) / 86_400_000);
    if (days < 1) return;
    trackBuyerFunnel("retained", { days_since_signup: days, buyer_plan: buyerPlan });
  }, [signedUpAt, buyerPlan]);

  // US-1797/1888: send a first-time BUYER-role account through onboarding once.
  // A seller exploring the buyer app (is_buyer=false) is NOT forced through it —
  // they can set preferences in Settings. Wait for the query so we don't
  // flash-redirect an onboarded buyer.
  if (!prefsLoading && profile?.is_buyer && !preferences?.onboarding_completed_at) {
    return <Navigate to="/buyer/onboarding" replace />;
  }

  const suite = [
    { icon: Bell, label: "Watchlist & Alerts", to: "/buyer/alerts", flag: "conditionAlerts" as const },
    { icon: Gift, label: "Rewards", to: "/buyer/rewards", flag: "rewards" as const },
    { icon: Shirt, label: "Closet Portfolio", to: "/buyer/portfolio", flag: "wardrobePortfolio" as const },
    { icon: ShieldCheck, label: "Purchase Guarantee", to: "/buyer/guarantee", flag: "purchaseGuarantee" as const },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        title={`Welcome, ${firstName}`}
        subtitle={
          <>
            You're on the{" "}
            <span className="font-medium text-foreground">{BUYER_PLANS[ent.plan].name}</span>{" "}
            buyer plan{ent.fromSellerPlan ? " — included with your seller plan" : ""}. Buy
            secondhand with confidence — condition, not just claims.
          </>
        }
      />

      {/* US-1843: an estimate the buyer produced on a free public tool BEFORE
          they had an account, waiting to become an alert or a closet entry.
          Renders nothing when there's no parked claim. */}
      <ClaimedResultCard />

      {/* US-9210: the buyer home is where a reader lands after a free read;
          the extension is the next read, on the marketplace itself. */}
      <ExtensionInstallCta path="/buyer" copy={BUYER_HOME_CTA} className="" />

      <TrustLevelCard />

      <BuyerImpactCard />

      {/* US-2883: THE activation checklist, same component the seller
          surfaces render. It replaces BuyerFirstSteps -- a second 204-line
          checklist with its own step list, its own count queries and its own
          localStorage dismissal, which is the duplication US-2859 removed on
          the seller side and left standing here. `persona` because the shell
          knows: a dual-role seller is a buyer on this page. */}
      <ActivationChecklist persona="buyer" />

      <BuyerActivity />

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">
          Your confidence suite
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {suite.map((tile) => {
            const Icon = tile.icon;
            const unlocked = ent.has(tile.flag);
            return (
              <Link
                key={tile.to}
                to={unlocked ? tile.to : `/buyer/billing?upgrade=${tile.flag}`}
                className="flex items-center gap-3 rounded-lg border border-border p-4 transition-colors hover:bg-accent"
              >
                <Icon className="h-5 w-5 text-primary" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{tile.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {unlocked ? "Open" : "Upgrade to unlock"}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
