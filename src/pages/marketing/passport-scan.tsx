import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  History,
  QrCode,
  ScanLine,
  Search,
  ShieldCheck,
  Layers,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { parseScanInput } from "@/lib/passport-scan";
import { passportScanJsonLd, SCAN_STEPS } from "@/pages/marketing/marketing-jsonld";
import { track } from "@/lib/analytics";

const TRUST = [
  {
    icon: History,
    title: "The whole story, not one snapshot",
    body: "A passport links every grade, listing, sale, and ownership handoff to the same physical garment — so you see how it was described over time, not just one seller's word today.",
  },
  {
    icon: ShieldCheck,
    title: "Pseudonymous by design",
    body: "Participants appear only as 'Seller A' or 'Buyer B'. No names, no emails, no addresses — a past owner is only ever shown if they personally chose to be.",
  },
  {
    icon: Layers,
    title: "Confidence-scored provenance",
    body: "Each link in the chain is labeled with how certain it is, so you can tell a verified handoff from a probable match — and judge the history for yourself.",
  },
];

// US-1106: buyer-facing "scan before you buy" passport entry point. A no-login
// lookup that resolves a scanned tag QR, a pasted passport link/slug, or a
// printed tag code to the public Garment Passport timeline (US-1093) or the tag
// resolver (US-1096). Marketed to BUYERS to pull demand into the ecosystem; the
// seller CTA ("grade your item to get a passport") drives the supply side.
export function PassportScanPage() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const target = parseScanInput(value);
    if (!target) {
      toast.error("That doesn't look like a GradeThread passport", {
        description:
          "Paste the passport link or slug, or the printed tag code (like ABCD-EFGH-JK) — or scan the QR code with your phone.",
      });
      return;
    }
    track("passport_scan_lookup", { kind: target.kind });
    navigate(target.path);
  }

  return (
    <MarketingLayout
      title="Scan a Garment Passport Before You Buy"
      description="Buying pre-owned clothing? Scan the passport QR or enter the code to see a garment's full grade, listing, and ownership history before you pay — free, no account, on any marketplace."
      canonicalPath="/scan"
      jsonLd={passportScanJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-semibold text-brand-navy dark:text-foreground">
            <ScanLine className="h-3.5 w-3.5" />
            For buyers
          </span>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
            Scan before you buy
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Buying pre-owned clothing on eBay, Poshmark, Mercari, Depop, or in
            person? If the item has a GradeThread Garment Passport, you can read
            its whole story first — every condition grade, listing, sale, and
            ownership handoff tied to that exact garment. It's free and takes no
            account.
          </p>

          <form onSubmit={handleSubmit} className="mt-8">
            <label htmlFor="passport-lookup" className="text-sm font-medium">
              Enter a passport link, slug, or tag code
            </label>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <Input
                id="passport-lookup"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="gradethread.com/passport/… or the tag code"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="text"
                className="flex-1"
              />
              <Button
                type="submit"
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                <Search className="mr-1.5 h-4 w-4" />
                Open passport
              </Button>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
              <QrCode className="h-4 w-4 flex-shrink-0" />
              On a phone? Just point your camera at the QR code on the item tag or
              listing — it opens the passport directly.
            </p>
          </form>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How to scan a passport</h2>
          <ol className="mt-10 space-y-8">
            {SCAN_STEPS.map((step, i) => (
              <li key={step.name} className="flex gap-4">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy font-semibold text-white">
                  {i + 1}
                </div>
                <div>
                  <h3 className="font-semibold">{step.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {step.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-10 flex items-center gap-3 rounded-lg border bg-background p-4 text-sm text-muted-foreground">
            <ScanLine className="h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <span>
              A Garment Passport isn't tied to one marketplace — the same QR code
              and link open the history on eBay, Poshmark, Mercari, Depop, or for
              a face-to-face sale.
            </span>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold">Why a passport matters</h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-3">
            {TRUST.map((t) => (
              <div key={t.title} className="flex flex-col gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-navy/10 text-brand-navy dark:text-foreground">
                  <t.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold">{t.title}</h3>
                <p className="text-sm text-muted-foreground">{t.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-sm text-muted-foreground">
            Just have a certificate code instead of a passport? Use{" "}
            <Link
              to="/verify"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              verify a condition grade
            </Link>{" "}
            to check a single grade, or read how the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              1.0–10.0 scale
            </Link>{" "}
            works.
          </p>
          <div className="mt-8">
            <Link to="/for-resellers">
              <Button variant="outline">
                Grade your item to get a passport
                <ArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA
        heading="Sell items buyers can trust"
        sub="Grade your pre-owned clothing with GradeThread — every item gets a Garment Passport buyers can scan and trust, on any marketplace."
      />
    </MarketingLayout>
  );
}
