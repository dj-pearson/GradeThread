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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PLANS } from "@/lib/constants";
import type { PlanKey } from "@/lib/constants";

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
    a: "Yes! The Free plan includes 5 grades per month with basic grade reports and email support. No credit card required to get started.",
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
    a: "Yes, the Professional and Enterprise plans include API access. You can integrate GradeThread grading directly into your own applications, inventory management systems, or listing tools.",
  },
];

const planKeys: PlanKey[] = ["free", "starter", "professional", "enterprise"];

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
      {/* Header */}
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-12">
        <img src="/logo_primary.svg" alt="GradeThread" className="h-8" />
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
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold">
            Simple, Transparent Pricing
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            Start free. Upgrade as you grow. No hidden fees.
          </p>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {planKeys.map((key) => {
              const plan = PLANS[key];
              const isPopular = key === "professional";
              return (
                <Card
                  key={key}
                  className={`relative ${isPopular ? "border-brand-red shadow-lg" : ""}`}
                >
                  {isPopular && (
                    <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-red text-white">
                      Most Popular
                    </Badge>
                  )}
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg">{plan.name}</CardTitle>
                    <div className="mt-2">
                      {plan.priceMonthly === 0 ? (
                        <span className="text-3xl font-bold">$0</span>
                      ) : plan.priceMonthly === null ? (
                        <span className="text-3xl font-bold">Custom</span>
                      ) : (
                        <>
                          <span className="text-3xl font-bold">
                            ${plan.priceMonthly}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            /mo
                          </span>
                        </>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {plan.gradesPerMonth === -1
                        ? "Unlimited grades"
                        : `${plan.gradesPerMonth} grades/month`}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 text-sm">
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
                        {plan.priceMonthly === null
                          ? "Contact Sales"
                          : "Get Started"}
                      </Button>
                    </Link>
                  </CardContent>
                </Card>
              );
            })}
          </div>
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
      <footer className="border-t px-6 py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <img src="/logo_primary.svg" alt="GradeThread" className="h-6" />
          <nav className="flex gap-6 text-sm text-muted-foreground">
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
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Pearson Media LLC
          </p>
        </div>
      </footer>
    </div>
  );
}
