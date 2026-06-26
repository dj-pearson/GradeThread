import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ShieldCheck,
  QrCode,
  ScanLine,
  Search,
  BadgeCheck,
  Lock,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { parseCertificateRef } from "@/lib/verified";
import { normalizeCertNumber } from "@/lib/cert-number";
import { edgeFetch } from "@/lib/edge-fetch";
import { verifyJsonLd, VERIFY_STEPS } from "@/pages/marketing/marketing-jsonld";
import { track } from "@/lib/analytics";

const TRUST = [
  {
    icon: ShieldCheck,
    title: "An independent grade, not the seller's word",
    body: "Every grade is produced by GradeThread against one published 1.0–10.0 rubric — so 'Excellent' or '8/10' means the same thing no matter who is selling.",
  },
  {
    icon: Lock,
    title: "Tamper-evident certificates",
    body: "GradeThread re-derives each certificate's integrity signature when it loads. If a grade were altered, the check fails — so the number you see is the number that was graded.",
  },
  {
    icon: BadgeCheck,
    title: "See the proof yourself",
    body: "The certificate shows the factor-by-factor breakdown and the actual garment photos, so you can confirm the condition matches the listing before you pay.",
  },
];

// US-593: the buyer-facing "verify this grade" entry point. Sellers already get
// the badge/QR embed; this page is marketed to BUYERS — a no-login lookup that
// resolves a scanned QR or pasted certificate code to the official certificate,
// works on any marketplace (eBay, Poshmark, Mercari, Depop) and in person.
export function VerifyGradePage() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw || busy) return;
    track("verify_lookup", { source: "verify_page" });

    // 1) A pasted certificate link or UUID resolves directly to the cert page.
    const certId = parseCertificateRef(raw);
    if (certId) {
      // Carry the source so the certificate view can attribute the visit (US-769).
      navigate(`/cert/${certId}?s=verify`);
      return;
    }

    // 2) Otherwise treat it as a PSA-style certificate NUMBER (e.g. GT-7K2M9)
    //    and resolve it via the public by-number lookup (00307). No login needed.
    setBusy(true);
    try {
      const num = normalizeCertNumber(raw);
      const res = await edgeFetch(
        `/api/content/public/certificates/by-number/${encodeURIComponent(num)}`,
        { unauthenticated: true, silentGate: true },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          found?: boolean;
          certificate_id?: string;
        };
        if (body.found && body.certificate_id) {
          navigate(`/cert/${body.certificate_id}?s=verify`);
          return;
        }
      }
      toast.error("No certificate found with that number", {
        description:
          "Check the certificate number (e.g. GT-7K2M9), paste the certificate link, or scan the QR code.",
      });
    } catch {
      toast.error("Couldn't verify right now", {
        description: "Please try again in a moment.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <MarketingLayout
      title="Verify a Condition Grade"
      description="Buying pre-owned clothing? Scan the QR code or enter a GradeThread certificate code to verify the condition grade before you pay — free, no account, on any marketplace."
      canonicalPath="/verify"
      jsonLd={verifyJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-semibold text-brand-navy dark:text-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            For buyers
          </span>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
            Verify a condition grade before you buy
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Buying pre-owned clothing on eBay, Poshmark, Mercari, Depop, or in
            person? If the seller graded it with GradeThread, you can confirm the
            condition for yourself — the grade, the factor breakdown, and the
            actual garment photos. It's free and takes no account.
          </p>

          <form onSubmit={handleSubmit} className="mt-8">
            <label htmlFor="cert-lookup" className="text-sm font-medium">
              Enter a certificate number or link
            </label>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <Input
                id="cert-lookup"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Cert number (e.g. GT-7K2M9) or paste the link"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                className="flex-1"
              />
              <Button
                type="submit"
                size="lg"
                disabled={busy}
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                <Search className="mr-1.5 h-4 w-4" />
                {busy ? "Verifying…" : "Verify grade"}
              </Button>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
              <QrCode className="h-4 w-4 flex-shrink-0" />
              The certificate number is printed in the listing (e.g.
              “Cert #GT-7K2M9”). On a phone, you can also point your camera at the
              QR code on the item's GradeThread tag.
            </p>
          </form>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How to verify a grade</h2>
          <ol className="mt-10 space-y-8">
            {VERIFY_STEPS.map((step, i) => (
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
              A GradeThread certificate isn't tied to eBay — the same QR code and
              link verify the grade on any marketplace and for face-to-face
              sales.
            </span>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold">Why a verified grade matters</h2>
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
            New to condition grades? See what the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              1.0–10.0 scale and seven tiers
            </Link>{" "}
            mean, read the{" "}
            <Link
              to="/grading-standard"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              grading standard
            </Link>
            , or check our published{" "}
            <Link
              to="/transparency"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              accuracy &amp; transparency report
            </Link>
            .
          </p>
          <div className="mt-8">
            <Link to="/for-resellers">
              <Button variant="outline">
                Sell with verified grades
                <ArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA
        heading="Sell items buyers can trust"
        sub="Grade your pre-owned clothing with GradeThread and give every buyer a certificate they can verify in seconds."
      />
    </MarketingLayout>
  );
}
