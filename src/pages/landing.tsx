import { Link } from "react-router-dom";
import { ArrowRight, Shield, Zap, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";

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

export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="flex h-16 items-center justify-between px-6 lg:px-12">
        <img src="/logo_primary.svg" alt="GradeThread" className="h-8" />
        <div className="flex items-center gap-4">
          <Link to="/login">
            <Button variant="ghost" size="sm">
              Sign in
            </Button>
          </Link>
          <Link to="/signup">
            <Button size="sm" className="bg-brand-red hover:bg-brand-red/90 text-white">
              Get Started
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
          AI-Powered Clothing{" "}
          <span className="text-brand-red">Condition Grading</span>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Standardize pre-owned clothing grades with AI. Build buyer trust,
          reduce returns, and sell faster with verified condition certificates.
        </p>
        <div className="mt-8 flex gap-4">
          <Link to="/signup">
            <Button size="lg" className="bg-brand-navy hover:bg-brand-navy/90 text-white">
              Start Grading Free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          <Link to="/login">
            <Button size="lg" variant="outline">
              Sign In
            </Button>
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="border-t bg-card px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold">
            Why GradeThread?
          </h2>
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

      {/* Footer */}
      <footer className="border-t px-6 py-8 text-center text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} GradeThread. All rights reserved.
      </footer>
    </div>
  );
}
