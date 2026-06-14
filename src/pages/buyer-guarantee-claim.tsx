import { useState, useEffect, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ShieldCheck, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { edgeFetch } from "@/lib/edge-fetch";
import { parseCertificateRef } from "@/lib/verified";

// US-867: buyer-facing claim intake for the condition-backed trust guarantee.
// Public (no account): a buyer references a certificate and describes how the
// item is materially not as graded. Posts to the unauthenticated edge endpoint
// /api/guarantee/claims, which resolves the tenant + report server-side.
export function BuyerGuaranteeClaimPage() {
  const [params] = useSearchParams();
  const [certificate, setCertificate] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [orderRef, setOrderRef] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ claimId: string } | null>(null);

  // Prefill the certificate from ?cert= (a link from the certificate page).
  useEffect(() => {
    const c = params.get("cert");
    if (c) setCertificate(c);
  }, [params]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const certId = parseCertificateRef(certificate);
    if (!certId) {
      toast.error("Enter a valid certificate", {
        description:
          "Paste the certificate link or code from the listing (e.g. gradethread.com/cert/…).",
      });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error("A valid contact email is required");
      return;
    }
    if (reason.trim().length < 20) {
      toast.error("Please describe the issue", {
        description: "Tell us how the item differs from its grade (at least 20 characters).",
      });
      return;
    }

    const evidenceUrls = evidence
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

    setSubmitting(true);
    try {
      const res = await edgeFetch("/api/guarantee/claims", {
        method: "POST",
        unauthenticated: true,
        json: {
          certificate_id: certId,
          claimant_email: email.trim(),
          claimant_name: name.trim() || undefined,
          marketplace: marketplace.trim() || undefined,
          order_reference: orderRef.trim() || undefined,
          reason: reason.trim(),
          evidence_urls: evidenceUrls,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Could not submit your claim.");
      }
      setSubmitted({ claimId: data.claim_id as string });
    } catch (err) {
      toast.error("Failed to submit claim", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MarketingLayout
      title="File a Buyer Guarantee Claim"
      description="File a GradeThread buyer trust-guarantee claim against a certified condition grade. No account needed."
      canonicalPath="/buyer-guarantee/claim"
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-semibold text-brand-navy dark:text-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Buyer trust guarantee
          </span>

          {submitted ? (
            <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6 dark:border-green-800 dark:bg-green-950/40">
              <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
              <h1 className="mt-3 text-2xl font-bold text-green-900 dark:text-green-200">
                Your claim has been submitted
              </h1>
              <p className="mt-2 text-sm text-green-800 dark:text-green-300">
                Reference: <span className="font-mono">{submitted.claimId}</span>
              </p>
              <p className="mt-3 text-sm text-green-800 dark:text-green-300">
                A reviewer will compare your claim against the item&rsquo;s
                certified condition disclosure and follow up at the email you
                provided. You can read the full policy on the{" "}
                <Link to="/buyer-guarantee" className="font-medium underline">
                  buyer guarantee page
                </Link>
                .
              </p>
            </div>
          ) : (
            <>
              <h1 className="mt-4 text-4xl font-bold tracking-tight">
                File a guarantee claim
              </h1>
              <p className="mt-4 text-muted-foreground">
                If a graded item arrived materially not as graded, tell us what
                happened. We review every claim against the item&rsquo;s
                certified condition disclosure. No account needed — see the{" "}
                <Link
                  to="/buyer-guarantee"
                  className="font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  guarantee policy
                </Link>{" "}
                for what&rsquo;s covered.
              </p>

              <form onSubmit={handleSubmit} className="mt-8 space-y-5">
                <div>
                  <Label htmlFor="certificate">Certificate link or code *</Label>
                  <Input
                    id="certificate"
                    value={certificate}
                    onChange={(e) => setCertificate(e.target.value)}
                    placeholder="https://gradethread.com/cert/… or the code"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1.5"
                    required
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Find this on the listing, certificate page, or item tag.
                  </p>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="email">Your email *</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      className="mt-1.5"
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="name">Your name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Optional"
                      autoComplete="name"
                      className="mt-1.5"
                    />
                  </div>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="marketplace">Where you bought it</Label>
                    <Input
                      id="marketplace"
                      value={marketplace}
                      onChange={(e) => setMarketplace(e.target.value)}
                      placeholder="eBay, Poshmark, Mercari…"
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="orderRef">Order / transaction reference</Label>
                    <Input
                      id="orderRef"
                      value={orderRef}
                      onChange={(e) => setOrderRef(e.target.value)}
                      placeholder="Optional"
                      className="mt-1.5"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="reason">
                    How does the item differ from its grade? *
                  </Label>
                  <Textarea
                    id="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Describe the undisclosed defect or how the condition is worse than the certified grade…"
                    rows={5}
                    className="mt-1.5"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="evidence">Evidence photo links</Label>
                  <Textarea
                    id="evidence"
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    placeholder="Paste links to your photos, one per line (optional but recommended)"
                    rows={3}
                    className="mt-1.5"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    One URL per line. Host photos anywhere publicly viewable.
                  </p>
                </div>

                <Button
                  type="submit"
                  size="lg"
                  disabled={submitting}
                  className="bg-brand-navy text-white hover:bg-brand-navy/90"
                >
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Submit claim
                </Button>
              </form>
            </>
          )}
        </div>
      </section>
    </MarketingLayout>
  );
}
