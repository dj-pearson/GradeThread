import { Link, Navigate } from "react-router";
import { Bell, Chrome, Gift, Leaf, ScanLine, Share2, ShieldCheck, Shirt } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { useAuthStore } from "@/stores/auth-store";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerPreferences } from "@/hooks/use-buyer-preferences";
import { useBuyerImpact } from "@/hooks/use-buyer-impact";
import { TrustLevelCard } from "@/components/buyer/trust-level-card";
import { BUYER_PLANS } from "@/lib/constants";

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
        Estimated vs producing comparable new garments — a conservative, labeled estimate.
      </p>
    </Card>
  );
}

// US-1802: buyer home. Empty-state, progressive-disclosure guidance to first
// value — run an extension second-opinion, set a condition alert, verify a
// certificate — plus entitlement-aware tiles into the buyer feature suite.

interface FirstStep {
  icon: typeof Bell;
  title: string;
  body: string;
  cta: string;
  to: string;
}

const FIRST_STEPS: FirstStep[] = [
  {
    icon: Chrome,
    title: "Get a second opinion",
    body: "Install the GradeThread extension to see an objective condition read on any listing you're eyeing.",
    cta: "Get the extension",
    to: "/buyer/settings",
  },
  {
    icon: Bell,
    title: "Set a condition alert",
    body: "Snipe on grade, not just price — get notified when a graded item in your size and brands lists.",
    cta: "Create an alert",
    to: "/buyer/alerts",
  },
  {
    icon: ScanLine,
    title: "Verify a certificate",
    body: "Scan or paste a GradeThread certificate to confirm a seller's claimed grade is real.",
    cta: "Verify a grade",
    to: "/verify",
  },
];

export function BuyerHomePage() {
  const profile = useAuthStore((s) => s.profile);
  const ent = useBuyerEntitlements();
  const { preferences, isLoading: prefsLoading } = useBuyerPreferences();
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

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

      <TrustLevelCard />

      <BuyerImpactCard />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Get started
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {FIRST_STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <Card key={step.title} className="flex flex-col gap-3 p-5">
                <Icon className="h-6 w-6 text-primary" />
                <div className="flex-1 space-y-1">
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">{step.body}</p>
                </div>
                <Link
                  to={step.to}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {step.cta} →
                </Link>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
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
