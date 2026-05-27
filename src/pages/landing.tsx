import { useState } from "react";
import { Link } from "react-router-dom";
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
  Star,
  TrendingDown,
  Clock,
  Compass,
  Boxes,
  Tag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { LaunchBanner } from "@/components/launch-banner";
import {
  CREDIT_PACKS,
  FLIPDESK_PLANS,
  GRADETHREAD_TIERS,
} from "@/lib/constants";
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

const stats = [
  { value: "5", label: "Grading Factors", icon: BarChart3 },
  { value: "< 30s", label: "Average Grade Time", icon: Clock },
  { value: "40%", label: "Fewer Returns", icon: TrendingDown },
  { value: "4.9", label: "User Rating", icon: Star },
];

const testimonials = [
  {
    name: "Sarah M.",
    role: "Poshmark Seller",
    quote:
      "GradeThread cut my return rate in half. Buyers trust the certificates and I close sales faster.",
  },
  {
    name: "Marcus T.",
    role: "Vintage Reseller",
    quote:
      "I grade 50+ items a week. The AI is incredibly consistent and saves me hours of writing descriptions.",
  },
  {
    name: "Emily R.",
    role: "eBay Power Seller",
    quote:
      "The detailed breakdown reports help me price items accurately. My profit margins are up 20% since I started.",
  },
];

const faqs = [
  {
    q: "How does AI grading work?",
    a: "You upload photos of your garment (front, back, label, and detail shots). Our Claude Vision AI analyzes the images across 5 weighted factors — Fabric Condition (30%), Structural Integrity (25%), Cosmetic Appearance (20%), Functional Elements (15%), and Odor & Cleanliness (10%) — to produce a standardized 1.0–10.0 grade.",
  },
  {
    q: "What if I disagree with a grade?",
    a: "You can file a dispute directly from the submission detail page. Include additional photos or notes explaining why you believe the grade should be different. Our team reviews disputes and can adjust grades when warranted.",
  },
  {
    q: "Can I use GradeThread for free?",
    a: "Yes. The Free plan includes 3 Standard grades per month at no cost, plus a 14-day free trial of Pro on signup (no card required). After that you can stay on Free, pay per grade, or subscribe to a paid tier.",
  },
  {
    q: "Do credits expire?",
    a: "No. Once you buy a credit pack, the credits stay in your account until you use them. There's no monthly minimum, no auto-debit, and no expiry date.",
  },
  {
    q: "Can I pause my subscription?",
    a: "Yes — for up to 3 months. While paused you keep all your data and credits, your caps fall back to Free, and we don't charge you. Resume any time.",
  },
  {
    q: "What happens to my listings if I downgrade?",
    a: "Your data stays intact. If you have more active listings than your new plan allows, the extras are hidden from active sync until you list them, end them, or upgrade again. Sub-accounts and API keys disable at period end.",
  },
  {
    q: "What types of clothing can I grade?",
    a: "GradeThread supports tops, bottoms, outerwear, dresses, footwear, and accessories. Each category has specific sub-types like t-shirts, jeans, jackets, sneakers, bags, and more.",
  },
  {
    q: "Are certificates publicly verifiable?",
    a: "Yes. Each certificate has a unique URL and QR code that anyone can use to verify the grade. Certificates display the overall score, tier, factor breakdown, and garment photos.",
  },
  {
    q: "Do you offer an API?",
    a: "Yes, the Business plan includes programmatic API access. You can integrate GradeThread grading directly into your own applications, inventory management systems, or listing tools.",
  },
];

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
        <h3 className="text-2xl font-semibold">
          FlipDesk — your reseller workflow
        </h3>
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
                    <div className="mt-0.5 text-xs text-emerald-700">
                      {dollars(plan.priceYearlyCents)} billed yearly
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <ul className="space-y-2 text-sm">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
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
        <h3 className="text-2xl font-semibold">
          GradeThread — pay only when you grade
        </h3>
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
            {CREDIT_PACKS.map((pack) => (
              <div
                key={pack.credits}
                className="rounded-md border border-border bg-background p-2 text-center"
              >
                <div className="text-lg font-bold tabular-nums">
                  {pack.credits}
                </div>
                <div className="text-xs text-muted-foreground">credits</div>
                <div className="mt-0.5 text-sm font-semibold">
                  ${(pack.priceCents / 100).toFixed(0)}
                </div>
              </div>
            ))}
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
      <h4 className="font-semibold">Included with FlipDesk</h4>
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

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between py-4 text-left text-sm font-medium hover:text-brand-navy"
      >
        {q}
        <ChevronDown
          className={`ml-2 h-4 w-4 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <p className="pb-4 text-sm leading-relaxed text-muted-foreground">{a}</p>
      )}
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SEO canonicalUrl="https://gradethread.com/" />
      <LaunchBanner />
      {/* Header */}
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-12">
        <img src="/logo_primary.png" alt="GradeThread" className="h-8" />
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
      <section className="flex flex-col items-center justify-center px-6 py-24 text-center lg:py-32">
        <Badge variant="secondary" className="mb-6 text-sm font-medium">
          Trusted by resellers everywhere
        </Badge>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
          AI-Powered Clothing{" "}
          <span className="text-brand-red">Condition Grading</span>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Standardize pre-owned clothing grades with AI. Build buyer trust,
          reduce returns, and sell faster with verified condition certificates.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:gap-4">
          <Link to="/signup">
            <Button
              size="lg"
              className="w-full bg-brand-navy text-white hover:bg-brand-navy/90 sm:w-auto"
            >
              Start Grading Free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          <a href="#how-it-works">
            <Button size="lg" variant="outline" className="w-full sm:w-auto">
              See How It Works
            </Button>
          </a>
        </div>

        {/* Stats bar */}
        <div className="mt-16 grid w-full max-w-3xl grid-cols-2 gap-6 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="text-center">
              <stat.icon className="mx-auto h-5 w-5 text-brand-navy" />
              <p className="mt-2 text-2xl font-bold text-brand-navy">
                {stat.value}
              </p>
              <p className="text-xs text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="border-t bg-card px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold">
            Why GradeThread?
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            The standard in pre-owned clothing condition assessment.
          </p>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {features.map((feature) => (
              <div key={feature.title} className="text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-brand-navy text-white">
                  <feature.icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold">How It Works</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            Four simple steps from photo to verified grade certificate.
          </p>
          <div className="mt-12 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {howItWorks.map((item) => (
              <div key={item.step} className="relative text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-navy text-white">
                  <item.icon className="h-6 w-6" />
                </div>
                <span className="absolute -top-2 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full bg-brand-red text-xs font-bold text-white">
                  {item.step}
                </span>
                <h3 className="mt-4 text-base font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Now with FlipDesk */}
      <section className="border-t bg-card px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-col items-center text-center">
            <Badge className="mb-4 bg-brand-red text-white">
              Now with FlipDesk
            </Badge>
            <h2 className="text-3xl font-bold">
              The full reseller workflow, built in
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
              FlipDesk turns GradeThread into a complete command center for
              flippers — source, catalog, grade, list, sell, and reconcile
              every item without leaving the app.
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Boxes,
                title: "Source & catalog",
                description:
                  "Log thrift hauls, estate sales, and auction lots, then catalog items in seconds.",
              },
              {
                icon: Award,
                title: "Grade for trust",
                description:
                  "Send items straight to GradeThread and attach verified condition grades.",
              },
              {
                icon: Tag,
                title: "List anywhere",
                description:
                  "Compose eBay-ready titles, descriptions, and item specifics with a live preview.",
              },
              {
                icon: BarChart3,
                title: "Reconcile profit",
                description:
                  "Track payouts, fees, and per-item P&L so you always know your real margins.",
              },
            ].map((item) => (
              <div key={item.title} className="text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-brand-red text-white">
                  <item.icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                <Compass className="mr-2 h-4 w-4" />
                Try FlipDesk Free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Social Proof / Testimonials */}
      <section className="border-t bg-card px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold">
            What Resellers Say
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            Hear from sellers who use GradeThread to grow their business.
          </p>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {testimonials.map((t) => (
              <Card key={t.name}>
                <CardContent className="pt-6">
                  <div className="mb-3 flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star
                        key={s}
                        className="h-4 w-4 fill-yellow-400 text-yellow-400"
                      />
                    ))}
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    &ldquo;{t.quote}&rdquo;
                  </p>
                  <div className="mt-4">
                    <p className="text-sm font-semibold">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.role}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-20">
        <div className="mx-auto max-w-6xl space-y-16">
          <div className="space-y-3 text-center">
            <h2 className="text-3xl font-bold">Simple, transparent pricing</h2>
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
      <section id="faq" className="border-t bg-card px-6 py-20">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Frequently Asked Questions
          </h2>
          <div className="mt-10 rounded-lg border bg-background p-6">
            {faqs.map((faq) => (
              <FAQItem key={faq.q} q={faq.q} a={faq.a} />
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-brand-navy px-6 py-20 text-center text-white">
        <h2 className="text-3xl font-bold">
          Ready to Grade Smarter?
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-white/80">
          Join resellers who trust GradeThread to standardize their condition
          grading, build buyer confidence, and increase sales.
        </p>
        <Link to="/signup" className="mt-8 inline-block">
          <Button
            size="lg"
            className="bg-brand-red text-white hover:bg-brand-red/90"
          >
            Start Grading Free
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-10">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <img src="/logo_primary.png" alt="GradeThread" className="h-6" />
            <nav className="flex flex-wrap gap-4 text-sm text-muted-foreground sm:gap-6">
              <a href="#how-it-works" className="hover:text-foreground">
                How It Works
              </a>
              <a href="#pricing" className="hover:text-foreground">
                Pricing
              </a>
              <a href="#faq" className="hover:text-foreground">
                FAQ
              </a>
            </nav>
          </div>
          <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
            <nav className="flex flex-wrap gap-4 text-xs text-muted-foreground sm:gap-6">
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
            </nav>
            <p className="text-xs text-muted-foreground">
              &copy; {new Date().getFullYear()} Pearson Media LLC. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
