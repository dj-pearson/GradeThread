import { useState } from "react";
import { Link } from "react-router";
import {
  ArrowRight,
  Shield,
  Zap,
  BarChart3,
  Camera,
  Cpu,
  Award,
  Share2,
  Check,
  ChevronDown,
  Compass,
  Layers,
  Gauge,
  Shapes,
  ExternalLink,
  History,
  BadgeCheck,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { Image } from "@/components/responsive-image";
import { VerifiedBadge } from "@/components/verified/verified-badge";
import {
  organizationLd,
  webSiteLd,
  softwareApplicationLd,
  faqPageLd,
} from "@/lib/seo/json-ld";
import { LaunchBanner } from "@/components/launch-banner";
import { StandardJustifications } from "@/components/marketing/standard-justifications";
import { StatCounters } from "@/components/marketing/stat-counters";
import { TrendingFinds } from "@/components/marketing/trending-finds";
import { HeroBackdrop } from "@/components/marketing/hero-backdrop";
import { ScrollExperience } from "@/components/marketing/scroll-experience/scroll-experience";
import { NewsletterSignup } from "@/components/newsletter-signup";
import { WaitlistForm } from "@/components/waitlist-form";
import { useWaitlistGating } from "@/hooks/use-waitlist-gating";
import { FLIPDESK_STAGES } from "@/components/marketing/flipdesk-stages";
import { LANDING_FAQS } from "@/pages/landing-faqs";
import {
  CREDIT_PACKS,
  FLIPDESK_PLANS,
  GRADETHREAD_TIERS,
  GRADE_FACTORS,
  GRADE_TIERS,
  GARMENT_CATEGORIES,
} from "@/lib/constants";
import {
  EXAMPLE_FACTORS,
  EXAMPLE_GRADE,
  EXAMPLE_ITEM,
} from "@/lib/example-account";
import type { FlipdeskPlan as FlipdeskPlanKey, BillingInterval } from "@/types/database";

const features = [
  {
    icon: Zap,
    title: "AI-Powered Grading",
    description:
      "Upload photos and get standardized condition grades in seconds using Claude Vision AI.",
  },
  {
    icon: Shield,
    title: "Trusted Certificates",
    description:
      "Share verifiable grade certificates with buyers to build trust and close sales faster.",
  },
  {
    icon: BarChart3,
    title: "Detailed Reports",
    description:
      "Get breakdown scores across fabric condition, structural integrity, cosmetic appearance, and more.",
  },
  {
    icon: History,
    title: "Garment Passport",
    description:
      "Every grade can carry a shareable provenance timeline buyers can scan before they buy — and it follows the garment when it's relisted or resold.",
  },
  {
    icon: BadgeCheck,
    title: "Verified Sellers",
    description:
      "Build a public Verified Seller profile, ranked by graded volume and average grade, and embed the badge in your listings to win buyer trust.",
  },
  {
    icon: ShieldCheck,
    title: "Buyer Guarantee",
    description:
      "A condition-backed guarantee: if an item arrives materially not as graded, the buyer can file a mediation claim against the certificate.",
  },
];

const howItWorks = [
  {
    step: 1,
    icon: Camera,
    title: "Upload Photos",
    description:
      "Take photos of the front, back, label, and details of your garment. Our system accepts JPEG, PNG, and WebP.",
  },
  {
    step: 2,
    icon: Cpu,
    title: "AI Grades It",
    description:
      "Claude Vision AI analyzes your garment across 5 weighted factors: fabric condition, structural integrity, cosmetic appearance, functional elements, and cleanliness.",
  },
  {
    step: 3,
    icon: Award,
    title: "Get Your Grade",
    description:
      "Receive a detailed grade report with a 1.0\u201310.0 score, tier label (NWT to Poor), and an AI-written condition summary.",
  },
  {
    step: 4,
    icon: Share2,
    title: "Share & Sell",
    description:
      "Share a verifiable certificate link with buyers. Embed it in your listings on eBay, Poshmark, Mercari, and more.",
  },
];

// US-1959: the FlipDesk pipeline, shown as a horizontal scroll-pinned track
// (source → grade → list → sell → reconcile) with stylized product mocks,
// instead of static icon cards. Falls back to a swipeable row on mobile.
const faqs = LANDING_FAQS;

const FLIPDESK_ORDER: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];

function dollars(cents: number): string {
  if (cents === 0) return "$0";
  return `$${(cents / 100).toFixed(0)}`;
}

function annualSavingsPct(plan: typeof FLIPDESK_PLANS.free): number | null {
  if (plan.priceMonthlyCents === 0) return null;
  const fullYear = plan.priceMonthlyCents * 12;
  return ((fullYear - plan.priceYearlyCents) / fullYear) * 100;
}

// ── FlipDesk subscription block ─────────────────────────────────

function FlipdeskPricingBlock() {
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-bold font-display text-brand-navy dark:text-white">
          FlipDesk — your reseller workflow
        </h2>
        <p className="text-sm text-muted-foreground">
          Catalog, photograph, draft, list, sell, ship — all in one tool.
        </p>
      </div>

      <div className="flex items-center justify-center gap-3 text-sm">
        <button
          onClick={() => setInterval("monthly")}
          className={`rounded-md px-3 py-1.5 transition-colors ${
            interval === "monthly"
              ? "bg-brand-navy text-white"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => setInterval("yearly")}
          className={`flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors ${
            interval === "yearly"
              ? "bg-brand-navy text-white"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          Annual
          <Badge
            variant="secondary"
            className={
              interval === "yearly" ? "bg-white/20 text-white" : ""
            }
          >
            Save ~17%
          </Badge>
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {FLIPDESK_ORDER.map((key) => {
          const plan = FLIPDESK_PLANS[key];
          const isPopular = key === "pro";
          const priceCents =
            interval === "yearly" ? plan.priceYearlyCents : plan.priceMonthlyCents;
          const displayPrice =
            priceCents === 0
              ? "$0"
              : interval === "yearly"
                ? `$${(priceCents / 12 / 100).toFixed(0)}`
                : dollars(priceCents);
          const savings = annualSavingsPct(plan);

          return (
            <Card
              key={key}
              className={`relative flex flex-col ${
                isPopular ? "border-brand-red shadow-lg" : ""
              }`}
            >
              {isPopular && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-red text-white">
                  Most Popular
                </Badge>
              )}
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">{plan.name}</CardTitle>
                <div className="mt-2">
                  <span className="text-3xl font-bold">{displayPrice}</span>
                  {priceCents > 0 && (
                    <span className="text-sm text-muted-foreground">/mo</span>
                  )}
                  {interval === "yearly" && savings != null && (
                    <div className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                      {dollars(plan.priceYearlyCents)} billed yearly
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <ul className="space-y-2 text-sm">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link to="/signup" className="mt-6 block">
                  <Button
                    className={`w-full ${
                      isPopular
                        ? "bg-brand-red text-white hover:bg-brand-red/90"
                        : ""
                    }`}
                    variant={isPopular ? "default" : "outline"}
                  >
                    {key === "free" ? "Start free" : "Start 14-day trial"}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── GradeThread per-grade block ─────────────────────────────────

function GradeThreadPricingBlock() {
  // CREDIT_PACKS is a hardcoded non-empty constant in lib/constants.ts —
  // the non-null assertion is safe and silences noUncheckedIndexedAccess.
  const bestPack = CREDIT_PACKS[CREDIT_PACKS.length - 1]!;
  const bestPerCredit = bestPack.priceCents / bestPack.credits;
  const list = GRADETHREAD_TIERS.standard.priceCents;
  const bestSavings = ((list - bestPerCredit) / list) * 100;

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-bold font-display text-brand-navy dark:text-white">
          GradeThread — pay only when you grade
        </h2>
        <p className="text-sm text-muted-foreground">
          No monthly fee. Submit a garment, pay for that grade. Buy in packs
          to save up to {bestSavings.toFixed(0)}%.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {(["standard", "premium", "express"] as const).map((tierKey) => {
          const tier = GRADETHREAD_TIERS[tierKey];
          return (
            <Card key={tierKey}>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">{tier.label}</CardTitle>
                <div className="mt-1">
                  <span className="text-3xl font-bold">
                    ${(tier.priceCents / 100).toFixed(2)}
                  </span>
                  <span className="text-sm text-muted-foreground"> / grade</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tier.slaHours}-hour SLA · {tier.creditCost} credit
                  {tier.creditCost === 1 ? "" : "s"}
                </p>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {tierKey === "standard"
                    ? "Standard turnaround for the everyday flip."
                    : tierKey === "premium"
                      ? "12-hour turnaround when you need to list today."
                      : "1-hour turnaround for time-sensitive auctions."}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="rounded-lg border border-brand-navy/30 bg-brand-navy/5 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-lg font-semibold">
              Buy in packs and save up to {bestSavings.toFixed(0)}%
            </div>
            <p className="text-sm text-muted-foreground">
              Credits never expire. Use one for Standard, three for Premium,
              five for Express. Mix and match.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CREDIT_PACKS.map((pack) => {
              const isBestValue = pack.credits === bestPack.credits;
              return (
                <div
                  key={pack.credits}
                  className={`relative rounded-md border bg-background p-2 text-center ${
                    isBestValue
                      ? "border-brand-red shadow-sm"
                      : "border-border"
                  }`}
                >
                  {isBestValue && (
                    <Badge className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap bg-brand-red px-1.5 py-0 text-[10px] text-white">
                      Best Value
                    </Badge>
                  )}
                  <div className="text-lg font-bold tabular-nums">
                    {pack.credits}
                  </div>
                  <div className="text-xs text-muted-foreground">credits</div>
                  <div className="mt-0.5 text-sm font-semibold">
                    {/* US-2075: toFixed(0) rendered a $24.99 pack as "$25" here
                        while /pricing showed $24.99 — the SAME pack at two
                        prices on one site, and the rounded one is the page
                        headlined "transparent pricing". Every CREDIT_PACKS and
                        GRADETHREAD_TIERS price carries cents, so rounding a
                        purchase surface always loses real money. (Plan prices
                        are all whole dollars, which is why toFixed(0) is
                        legitimate on the plan cards.) */}
                    ${(pack.priceCents / 100).toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Bundled grades explainer ────────────────────────────────────

function IncludedGradesTable() {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h3 className="font-semibold">Included with FlipDesk</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Every FlipDesk plan includes Standard grades each month. Overage uses
        credits or pay-per-grade.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {FLIPDESK_ORDER.map((key) => {
          const plan = FLIPDESK_PLANS[key];
          return (
            <div
              key={key}
              className="rounded-md border border-border bg-background p-3 text-center"
            >
              <div className="text-xs uppercase text-muted-foreground">
                {plan.name}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">
                {plan.includedStandardGradesPerMonth}
              </div>
              <div className="text-xs text-muted-foreground">
                Standard grades / mo
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// US-604: keyboard- and screen-reader-complete disclosure. The trigger is a
// real <button> (Enter/Space + focusable for free) that owns aria-expanded and
// aria-controls; the answer is a labelled region toggled with the `hidden`
// attribute so collapsed content stays out of the a11y tree and tab order.
function FAQItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(false);
  const buttonId = `faq-trigger-${index}`;
  const panelId = `faq-panel-${index}`;
  return (
    <div className="border-b last:border-b-0">
      <h3 className="m-0">
        <button
          id={buttonId}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between gap-2 py-4 text-left text-sm font-medium hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:hover:text-foreground"
        >
          {q}
          <ChevronDown
            aria-hidden="true"
            className={`ml-2 h-4 w-4 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
      >
        <p className="pb-4 text-sm leading-relaxed text-muted-foreground">{a}</p>
      </div>
    </div>
  );
}

// US-604: objective, verifiable product facts — NOT customer counts or star
// ratings (no-fake-ratings policy). Counts are derived from the live grading
// taxonomy so they can never drift from what the product actually does.
const PROOF_STATS: { value: string; label: string; icon: typeof Layers }[] = [
  {
    value: String(Object.keys(GRADE_FACTORS).length),
    label: "weighted condition factors",
    icon: Layers,
  },
  {
    value: "1.0–10.0",
    label: "objective grading scale",
    icon: Gauge,
  },
  {
    value: String(GRADE_TIERS.length),
    label: "standardized condition tiers",
    icon: BarChart3,
  },
  {
    value: `${GARMENT_CATEGORIES.length}+`,
    label: "garment categories supported",
    icon: Shapes,
  },
];

// US-604: an in-page recreation of a real grade certificate — the strongest
// conversion asset. The numbers are an illustrative SAMPLE (clearly labelled),
// not aggregate/social data. When VITE_SAMPLE_CERTIFICATE_ID is configured the
// CTA links to the LIVE certificate; otherwise it falls back to signup so the
// section is never a dead end.
//
// US-2865: the numbers moved to src/lib/example-account.ts and this reads
// them. There is now one worked example in the product, shown here to a
// visitor and on /dashboard/example to a new account, so support can answer
// "what does a 9.0 look like" by naming one garment. Keeping a second copy
// here is how the two drift, and they HAD: the five factors as written
// weighted to 9.05, which rounds to 9.1, under a headline that said 9.0.
const SAMPLE_CERT = {
  title: EXAMPLE_ITEM.title,
  overallScore: EXAMPLE_GRADE.overallScore,
  tier: EXAMPLE_GRADE.tier,
  factors: EXAMPLE_FACTORS,
};

function SampleCertificatePreview() {
  const sampleId = import.meta.env.VITE_SAMPLE_CERTIFICATE_ID?.trim();
  return (
    <Card className="overflow-hidden border-border/60 shadow-lg glass-card">
      <div className="flex items-center justify-between gap-2 bg-brand-navy px-5 py-3 text-white">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Shield className="h-4 w-4" />
          Verified Grade Certificate
        </span>
        <Badge variant="secondary" className="bg-white/15 text-white">
          Sample
        </Badge>
      </div>
      <CardContent className="space-y-6 pt-6">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
          <div
            data-cert-ring
            className="flex h-24 w-24 flex-shrink-0 items-center justify-center rounded-full border-4 border-emerald-500"
          >
            <span data-cert-score className="text-3xl font-bold text-emerald-500">
              {SAMPLE_CERT.overallScore.toFixed(1)}
            </span>
          </div>
          <div className="text-center sm:text-left">
            <Badge
              variant="outline"
              className="border-emerald-200 bg-emerald-100 text-sm font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
            >
              {SAMPLE_CERT.tier}
            </Badge>
            {/* US-1948: expand the tier abbreviation so a newcomer isn't left
                guessing what "NWOT" means. */}
            <p className="mt-1 text-sm text-muted-foreground">
              New Without Tags (NWOT) · Overall Condition Grade
            </p>
            <p className="mt-2 text-base font-medium">{SAMPLE_CERT.title}</p>
          </div>
        </div>

        <div className="space-y-3">
          {SAMPLE_CERT.factors.map(({ key, score }) => {
            const factor = GRADE_FACTORS[key];
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">
                    {factor.label}{" "}
                    <span className="text-muted-foreground">
                      ({(factor.weight * 100).toFixed(0)}%)
                    </span>
                  </span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                    {score.toFixed(1)}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={score * 10}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${factor.label} score: ${score.toFixed(1)} out of 10`}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-500/15"
                >
                  <div
                    data-cert-bar
                    className="h-full origin-left rounded-full bg-emerald-500"
                    style={{ width: `${score * 10}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-center">
          <VerifiedBadge
            score={SAMPLE_CERT.overallScore}
            tier={SAMPLE_CERT.tier}
          />
        </div>

        {sampleId ? (
          <Link to={`/cert/${sampleId}`} className="block">
            <Button className="w-full bg-brand-navy text-white hover:bg-brand-navy/90">
              View the live certificate
              <ExternalLink className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        ) : (
          <Link to="/signup" className="block">
            <Button className="w-full bg-brand-navy text-white hover:bg-brand-navy/90">
              Grade your first item free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

export function LandingPage() {
  const waitlistGating = useWaitlistGating();
  return (
    <ScrollExperience>
    <div className="flex min-h-screen flex-col">
      <SEO
        canonicalUrl="https://gradethread.com/"
        jsonLd={[
          organizationLd(),
          webSiteLd(),
          softwareApplicationLd(),
          faqPageLd(faqs),
        ]}
      />
      <LaunchBanner />
      {/* US-1955: the "condition orb" is a page-level spine — a fixed WebGL
          layer (lazy, desktop-only, gated) that travels + transforms with
          scroll instead of dying at the hero. Never blocks LCP. */}
      <HeroBackdrop />
      {/* Header */}
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-12">
        {/* Responsive logo: intrinsic 1806×376 → 1x/2x srcset, no CLS (US-306). */}
        <Image
          src="/logo_primary.png"
          alt="GradeThread"
          width={154}
          height={32}
          priority
          className="h-8 w-auto"
        />
        <div className="flex items-center gap-4">
          <Link to="/login">
            <Button variant="ghost" size="sm">
              Sign in
            </Button>
          </Link>
          <Link to="/signup">
            <Button
              size="sm"
              className="bg-brand-red text-white hover:bg-brand-red/90"
            >
              Get Started
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative flex flex-col items-center justify-center px-6 py-24 text-center lg:py-32 overflow-hidden">
        {/* Ambient background glows — also the static "poster" fallback shown
            when the WebGL orb is gated off (mobile / reduced-motion / no GL). */}
        <div className="gt-parallax-cx absolute top-1/4 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-brand-red/10 blur-[100px]" />
        <div className="gt-parallax absolute bottom-1/4 left-1/3 -z-10 h-96 w-96 rounded-full bg-brand-navy/15 blur-[120px] dark:bg-brand-navy/35" />

        {/* Readability scrim — sits above the orb, below the copy, so the
            paragraph keeps contrast over the animated graphic. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -z-[5] h-[30rem] w-[46rem] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/65 blur-2xl"
        />

        <Badge variant="secondary" className="gt-hero-rise gt-hero-rise-1 mb-6 text-sm font-medium border-brand-navy/10 dark:border-white/10 glass-card px-4 py-1.5 rounded-full">
          AI listings + verified condition grades for resellers
        </Badge>
        {/* Leads with the job resellers already have, not the category we are
            trying to create. "The Trusted Standard for Clothing Condition
            Grading" asked a visitor to care about a category with no search
            demand — and the certificate's value is two-sided: it is only worth
            something once BUYERS recognise the mark, which they do not yet. The
            listing work is a pain sellers already feel and already pay
            $19-99/mo to solve (Vendoo, List Perfectly, Crosslist). Grading is
            the reason we are better at it, so it moves to the subhead as the
            differentiator rather than the opening claim. */}
        <h1 className="gt-hero-lift max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl font-display">
          Photograph it.{" "}
          <span className="text-brand-red-text">We'll write the listing.</span>
        </h1>
        <p className="gt-hero-rise gt-hero-rise-2 mt-6 max-w-xl text-lg text-muted-foreground">
          {/* US-2043 still binds: no reproducibility claim ("the same grade
              every time") until /transparency can substantiate it — the default
              model is effort-based, so the temperature=0 determinism guarantee
              no longer holds, and agreement still reads "Not enough data yet".
              "Objective, against one published standard, verifiable by the
              buyer" is true today; "identical every run" is not. */}
          AI turns your photos into ready-to-publish eBay, Poshmark and Mercari
          listings — each with an objective 1.0–10.0 condition grade buyers can
          verify, so fewer come back. One published standard, not one seller's
          opinion.
        </p>
        <div className="gt-hero-rise gt-hero-rise-3 mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4">
          <Link to="/signup">
            <Button
              size="lg"
              className="w-full bg-brand-navy text-white hover:bg-brand-navy/90 sm:w-auto font-medium shadow-md shadow-brand-navy/20 hover:scale-[1.02] active:scale-[0.98] transition-all"
            >
              Start free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          {/* The secondary CTA is the PRODUCT, not an anchor jump.
              /tools/grade-checker runs a real grade from one photo with no
              account (public endpoint, rate-limited 5/hr). It was the strongest
              try-before-you-buy asset on the site and the landing page did not
              link to it at all — every CTA above the fold pointed at /signup,
              which is a form plus an email round-trip before any value lands.
              A visitor who will not create an account can now still see the
              product work. */}
          <Link to="/tools/grade-checker">
            <Button size="lg" variant="outline" className="w-full sm:w-auto hover:scale-[1.02] active:scale-[0.98] transition-all glass-card">
              Grade a photo free — no signup
            </Button>
          </Link>
        </div>
        {/* "No credit card required" was true but buried in FAQ #3. It is the
            single strongest objection-killer we have, so it belongs under the
            CTA where the hesitation actually happens. */}
        <p className="gt-hero-rise gt-hero-rise-3 mt-4 text-sm text-muted-foreground">
          Free forever plan · 3 grades every month · no credit card required
        </p>
        {/* US-1948: a casual-seller on-ramp so first-timers/closet-cleaners don't
            read the "for resellers" framing as "not for me". Routes to the
            no-account /whats-it-worth tool. */}
        <p className="gt-hero-rise gt-hero-rise-3 mt-6 text-sm text-muted-foreground">
          Just cleaning out your closet?{" "}
          <Link
            to="/whats-it-worth"
            className="font-medium text-brand-red-text underline-offset-4 hover:underline"
          >
            See what your clothes are worth
          </Link>{" "}
          — free, no account needed. Or{" "}
          <a
            href="#how-it-works"
            className="font-medium text-brand-red-text underline-offset-4 hover:underline"
          >
            see how it works
          </a>
          .
        </p>
      </section>

      {/* Live platform counters (US-865) — real aggregate social proof. Renders
          nothing until a metric is large enough to cite honestly. */}
      <StatCounters />

      {/* Proof band — objective product facts only (no fabricated ratings). */}
      <section className="gt-panel-dark px-6 py-10 text-white">
        <div className="mx-auto max-w-5xl">
          <p className="text-center text-xs font-semibold uppercase tracking-wider text-white/60">
            One published, objective methodology
          </p>
          <dl className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
            {PROOF_STATS.map((stat) => (
              <div key={stat.label} className="flex flex-col items-center text-center">
                <stat.icon aria-hidden="true" className="mb-2 h-5 w-5 text-brand-red-text" />
                <dt className="sr-only">{stat.label}</dt>
                <dd
                  data-countup
                  className="text-3xl font-extrabold font-display tabular-nums"
                >
                  {stat.value}
                </dd>
                <p aria-hidden="true" className="mt-1 text-xs text-white/70">
                  {stat.label}
                </p>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Why GradeThread is the standard — the four justifications (US-1297). */}
      <section className="px-6 py-20">
        <div data-gt-reveal>
          <StandardJustifications intro="GradeThread is the standard for pre-owned clothing condition because a grade here is objective, published, consistently applied, and independently verifiable — not one more seller's opinion." />
        </div>
      </section>

      {/* See the product — embedded sample certificate (US-604). US-1957: this
          section is the "certificate assembles on scroll" signature scene. */}
      <section data-cert-scene className="px-6 py-20">
        <div className="mx-auto grid max-w-5xl items-center gap-12 lg:grid-cols-2">
          <div data-gt-reveal>
            <Badge variant="secondary" className="mb-4 rounded-full px-3 py-1 glass-card">
              See the actual product
            </Badge>
            <h2 className="text-3xl font-extrabold font-display">
              Every grade ends in a certificate buyers trust
            </h2>
            <p className="mt-4 text-muted-foreground">
              This is exactly what your buyers see: an overall score, a
              tier, the five weighted factor scores, and a verifiable badge you
              can drop straight into any listing. Scannable, shareable, and
              backed by one published standard.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "Objective 1.0–10.0 score with a plain-language tier",
                "Transparent factor-by-factor breakdown",
                "A scannable badge for eBay, Poshmark, Mercari, Depop & Grailed",
              ].map((point) => (
                <li key={point} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
          <div data-cert-card>
            <SampleCertificatePreview />
          </div>
        </div>
      </section>

      {/* US-1855 AC3: trending finds from the public Showcase. Renders nothing
          until the feed has real, seller-consented entries. */}
      <TrendingFinds />

      {/* Features */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 data-gt-reveal className="text-center text-3xl font-extrabold font-display">
            Why GradeThread?
          </h2>
          <p data-gt-reveal className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            The standard in pre-owned clothing condition assessment.
          </p>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {features.map((feature) => (
              <div key={feature.title} data-gt-reveal className="text-center rounded-2xl border border-border/40 bg-card/60 p-6 shadow-sm hover:shadow-md hover:border-brand-navy/20 dark:hover:border-white/10 transition-all duration-300 glass-card">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-brand-navy/10 text-brand-navy dark:bg-brand-navy/30 dark:text-white mb-4">
                  <feature.icon className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold font-display">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-center text-sm text-muted-foreground">
            Every grade follows one published, objective methodology.{" "}
            <Link
              to="/grading-standard"
              className="font-medium text-brand-red-text hover:underline decoration-brand-red underline-offset-4"
            >
              See the GradeThread grading standard
            </Link>
            .
          </p>
        </div>
      </section>

      {/* How It Works — US-1958: a connected 4-step sequence; a scroll-scrubbed
          progress rail threads the steps (desktop) as you move through. */}
      <section
        id="how-it-works"
        data-hiw-scene
        className="px-6 py-20 relative overflow-hidden"
      >
        {/* Subtle background glow */}
        <div className="absolute top-1/2 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-navy/5 blur-[100px]" />
        
        <div className="mx-auto max-w-5xl">
          <h2 data-gt-reveal className="text-center text-3xl font-extrabold font-display">How It Works</h2>
          <p data-gt-reveal className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            Four simple steps from photo to verified grade certificate.
          </p>
          <div className="relative mt-12">
            {/* Progress rail threading the four step icons (desktop 4-col only).
                Sits behind the glass cards; its red fill scrubs left→right with
                scroll to make the steps read as one advancing sequence. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-[12.5%] right-[12.5%] top-12 hidden h-0.5 -translate-y-1/2 overflow-hidden rounded-full bg-border lg:block"
            >
              <div
                data-hiw-fill
                className="h-full w-full origin-left rounded-full bg-brand-red"
              />
            </div>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {howItWorks.map((item) => (
                <div key={item.step} data-gt-reveal className="relative rounded-2xl border border-border/40 bg-card/60 p-6 text-center shadow-sm hover:shadow-md hover:border-brand-red/20 transition-all duration-300 glass-card">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-brand-navy text-white mb-4">
                  <item.icon className="h-5 w-5" />
                </div>
                <span className="absolute top-4 right-4 flex h-6 w-6 items-center justify-center rounded-full bg-brand-red text-xs font-bold text-white shadow-sm">
                  {item.step}
                </span>
                <h3 className="text-base font-semibold font-display">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Now with FlipDesk — US-1959: the pipeline as a swipeable horizontal
          gallery (source → grade → list → sell → reconcile) with product mocks,
          replacing the flat icon grid and putting the tool on the page (US-1949). */}
      <section className="relative py-20">
        <div className="mx-auto max-w-5xl px-6">
          <div data-gt-reveal className="flex flex-col items-center text-center">
            <Badge className="mb-4 bg-brand-red text-white hover:bg-brand-red shadow-sm px-3 py-1 rounded-full">
              Now with FlipDesk
            </Badge>
            <h2 className="text-3xl font-extrabold font-display">
              The full reseller workflow, built in
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
              FlipDesk turns GradeThread into a complete command center for
              flippers — source, catalog, grade, list, sell, and reconcile
              every item without leaving the app.
            </p>
          </div>
        </div>

        {/* Default: a swipeable horizontal scroller (mobile / reduced-motion /
            no-engine). On a capable desktop, flipdesk-scene.ts pins the section
            and scrubs this track horizontally as you scroll vertically. */}
        <div data-flipdesk-viewport className="gt-hscroll mt-12 overflow-x-auto">
          <ol
            data-flipdesk-track
            className="flex w-max gap-6 px-6 md:px-[9vw]"
          >
            {FLIPDESK_STAGES.map((stage, i) => (
              <li
                key={stage.title}
                data-flipdesk-panel
                className="flipdesk-panel flex w-[80vw] max-w-[340px] flex-shrink-0 flex-col rounded-3xl border border-border/40 bg-card/60 p-6 shadow-sm glass-card sm:w-[340px]"
              >
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-red/10 text-brand-red-text">
                    <stage.icon className="h-5 w-5" />
                  </div>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-navy text-xs font-bold text-white">
                    {i + 1}
                  </span>
                </div>
                {/* Stylized product mock — a peek at the tool, not a real screenshot. */}
                <div className="mb-4 rounded-xl border border-border/50 bg-background/70 p-3">
                  <div className="mb-2 flex gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-brand-red/50" />
                    <span className="h-2 w-2 rounded-full bg-amber-400/60" />
                    <span className="h-2 w-2 rounded-full bg-emerald-400/60" />
                  </div>
                  <ul className="space-y-1.5">
                    {stage.mock.map((line) => (
                      <li
                        key={line}
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                      >
                        <Check className="h-3 w-3 flex-shrink-0 text-emerald-500" />
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
                <h3 className="text-base font-semibold font-display">
                  {stage.title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {stage.description}
                </p>
              </li>
            ))}
          </ol>
        </div>

        <div className="mx-auto mt-10 max-w-5xl px-6 text-center">
          <Link to="/signup">
            <Button
              size="lg"
              className="bg-brand-navy text-white hover:bg-brand-navy/90 font-medium hover:scale-[1.02] active:scale-[0.98] transition-all"
            >
              <Compass className="mr-2 h-4 w-4" />
              Try FlipDesk Free
            </Button>
          </Link>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-20">
        <div className="mx-auto max-w-6xl space-y-16">
          <div data-gt-reveal className="space-y-3 text-center">
            <h2 className="text-3xl font-extrabold font-display">Simple, transparent pricing</h2>
            <p className="mx-auto max-w-2xl text-muted-foreground">
              GradeThread is two products on one bill: a workflow tool you
              subscribe to, and a grading service you pay per item. Use only
              what you need.
            </p>
          </div>

          {/* FlipDesk subscription */}
          <FlipdeskPricingBlock />

          {/* GradeThread per-grade + credit packs */}
          <GradeThreadPricingBlock />

          {/* Bundled grades explainer */}
          <IncludedGradesTable />
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="px-6 py-20">
        <div className="mx-auto max-w-2xl">
          <h2 data-gt-reveal className="text-center text-3xl font-extrabold font-display">
            Frequently Asked Questions
          </h2>
          <div className="mt-10 rounded-lg border bg-background p-6">
            {faqs.map((faq, i) => (
              <FAQItem key={faq.q} q={faq.q} a={faq.a} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* US-2449: public waitlist capture. Renders ONLY while the staged-launch
          gate is actually closed — see use-waitlist-gating.ts for why that
          condition is the whole feature and not an optimisation. */}
      {waitlistGating && (
        <section className="bg-brand-navy px-6 py-16 text-center text-white">
          <h2 className="text-2xl font-extrabold font-display">
            We're letting people in a group at a time
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-white/80">
            Leave your email and we'll send your invite as soon as a spot opens.
            No card, no account needed yet.
          </p>
          <div className="mx-auto mt-8 max-w-xl">
            <WaitlistForm source="landing" />
          </div>
        </section>
      )}

      {/* US-912: newsletter signup — capture leads before signup (double opt-in). */}
      <section className="px-6 py-16 text-center">
        <h2 className="text-2xl font-extrabold font-display">
          Resale grading tips in your inbox
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Join our newsletter for condition-grading guidance, resale market
          trends, and product updates. No account required — unsubscribe anytime.
        </p>
        <div className="mx-auto mt-8 max-w-xl">
          <NewsletterSignup source="landing-newsletter" />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-10">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Image
              src="/logo_primary.png"
              alt="GradeThread"
              width={115}
              height={24}
              className="h-6 w-auto"
            />
            <nav className="flex flex-wrap gap-4 text-sm text-muted-foreground sm:gap-6">
              <a href="#how-it-works" className="hover:text-foreground">
                How It Works
              </a>
              <a href="#pricing" className="hover:text-foreground">
                Pricing
              </a>
              {/* US-9211: the product is one click from the home page. */}
              <Link to="/flipdesk" className="hover:text-foreground">
                FlipDesk
              </Link>
              <Link to="/condition-grading" className="hover:text-foreground">
                Condition Grading
              </Link>
              <Link to="/grading-standard" className="hover:text-foreground">
                Grading Standard
              </Link>
              <Link to="/for-resellers" className="hover:text-foreground">
                For Resellers
              </Link>
              <a href="#faq" className="hover:text-foreground">
                FAQ
              </a>
            </nav>
          </div>
          <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
            <nav className="flex flex-wrap gap-4 text-xs text-muted-foreground sm:gap-6">
              <Link to="/about" className="hover:text-foreground">
                About
              </Link>
              <Link to="/privacy" className="hover:text-foreground">
                Privacy Policy
              </Link>
              <Link to="/terms" className="hover:text-foreground">
                Terms of Service
              </Link>
              <Link to="/cookies" className="hover:text-foreground">
                Cookie Policy
              </Link>
              <Link to="/acceptable-use" className="hover:text-foreground">
                Acceptable Use
              </Link>
              <Link to="/status" className="hover:text-foreground">
                Status
              </Link>
            </nav>
            <p className="text-xs text-muted-foreground">
              &copy; {new Date().getFullYear()} Pearson Media LLC. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
    </ScrollExperience>
  );
}
