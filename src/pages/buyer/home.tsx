import { Link } from "react-router-dom";
import { Bell, Chrome, Gift, ScanLine, ShieldCheck, Shirt } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useAuthStore } from "@/stores/auth-store";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { BUYER_PLANS } from "@/lib/constants";

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
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

  const suite = [
    { icon: Bell, label: "Watchlist & Alerts", to: "/buyer/alerts", flag: "conditionAlerts" as const },
    { icon: Gift, label: "Rewards", to: "/buyer/rewards", flag: "rewards" as const },
    { icon: Shirt, label: "Closet Portfolio", to: "/buyer/portfolio", flag: "wardrobePortfolio" as const },
    { icon: ShieldCheck, label: "Purchase Guarantee", to: "/buyer/guarantee", flag: "purchaseGuarantee" as const },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Welcome, {firstName}</h1>
        <p className="text-sm text-muted-foreground">
          You're on the{" "}
          <span className="font-medium text-foreground">{BUYER_PLANS[ent.plan].name}</span>{" "}
          buyer plan. Buy secondhand with confidence — condition, not just claims.
        </p>
      </header>

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
