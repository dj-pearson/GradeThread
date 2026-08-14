import { useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Loader2, ShieldCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  AUTHENTICITY_CHECK_ENDPOINT,
  AUTHENTICITY_CHECK_META,
  AUTHENTICITY_CHECK_PATH,
} from "@/lib/seo/authenticity-check";
import { BuyerConversionCtas } from "@/components/marketing/buyer-conversion-ctas";
import { ToolLimitNotice } from "@/components/marketing/tool-limit-notice";
import { isRateLimited } from "@/lib/tool-rate-limit";
import { edgeApiUrl } from "@/lib/edge-api";
import { track } from "@/lib/analytics";
import {
  authenticityCheckJsonLd,
  authenticityCheckBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1771: free buyer-side authenticity ESTIMATE from photos. Like the
// grade-checker, ALL browser work (media-intake, FileReader, fetch) happens in
// the click handler so the page prerenders safely — the landing copy is the
// crawlable payload. The output is always framed as an estimate, never a
// guarantee. The endpoint is fail-closed (PUBLIC_AUTHENTICITY_CHECK_ENABLED); a
// 404 is surfaced as a friendly "coming soon", not an error.

const MAX_PHOTOS = 4;

type Verdict = "likely_authentic" | "inconclusive" | "red_flags";

interface AuthenticityResult {
  estimate: boolean;
  verdict: Verdict;
  verdictConfidence: number;
  counterfeitRisk: "low" | "elevated" | "high" | "indeterminate";
  brandAssessed: string | null;
  summary: string;
  limitations: string;
}

const VERDICT_UI: Record<Verdict, { label: string; tone: string }> = {
  likely_authentic: { label: "Looks consistent with genuine", tone: "text-emerald-600 dark:text-emerald-400" },
  inconclusive: { label: "Inconclusive", tone: "text-amber-600 dark:text-amber-400" },
  red_flags: { label: "Red flags found", tone: "text-brand-red-text" },
};

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function AuthenticityCheckTool() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comingSoon, setComingSoon] = useState(false);
  const [result, setResult] = useState<AuthenticityResult | null>(null);
  const [brand, setBrand] = useState("");
  // US-2526: the free limit is its own state, not an error string.
  const [limited, setLimited] = useState<string | null | false>(false);

  async function onFiles(files: FileList) {
    setBusy(true);
    setError(null);
    setLimited(false);
    setComingSoon(false);
    setResult(null);
    try {
      const { normalizeToImageFile } = await import("@/lib/media-intake");
      const chosen = Array.from(files).slice(0, MAX_PHOTOS);
      const images: string[] = [];
      for (const f of chosen) {
        const normalized = await normalizeToImageFile(f);
        images.push(await readAsDataUrl(normalized));
      }
      const res = await fetch(`${edgeApiUrl()}${AUTHENTICITY_CHECK_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          images,
          ...(brand.trim() ? { brand: brand.trim() } : {}),
        }),
      });
      // Fail-closed endpoint (not yet enabled) returns 404 — treat as coming soon.
      if (res.status === 404) {
        setComingSoon(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | AuthenticityResult
        | { error?: string }
        | null;
      if (!res.ok || !body || !("verdict" in body)) {
        // US-2526: a limit is not a bad photo. Sending someone off to reshoot
        // tags and stitching that were fine is the worst possible answer here.
        if (isRateLimited(res.status, body)) {
          setLimited(body && "error" in body && body.error ? body.error : null);
          return;
        }
        const msg =
          body && "error" in body && body.error
            ? body.error
            : "Couldn't check that item. Try clear, well-lit photos of the tags, logo, and stitching.";
        setError(msg);
        return;
      }
      setResult(body);
      track("authenticity_checker_result", { verdict: body.verdict });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function onCtaClick(cta: "signup" | "certify") {
    track("authenticity_checker_cta_click", { cta });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border bg-card p-6 sm:p-8">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length) void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {comingSoon ? (
          <div className="text-center">
            <ShieldCheck className="mx-auto h-10 w-10 text-brand-navy dark:text-foreground" />
            <p className="mt-4 text-lg font-medium">The authenticity checker is launching soon.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              We're finishing legal review of this free tool. In the meantime, get a full certified
              condition grade with a shareable certificate.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link to="/dashboard/submissions/new" onClick={() => onCtaClick("certify")}>
                <Button size="sm">
                  Get a certified grade
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
              <Button size="sm" variant="outline" onClick={() => setComingSoon(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : !result ? (
          <div className="text-center">
            <div className="mb-5 text-left">
              <Label htmlFor="ac-brand" className="text-sm">
                Claimed brand <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="ac-brand"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. Gucci"
                disabled={busy}
                className="mt-1"
              />
            </div>
            <Button
              size="lg"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="w-full sm:w-auto"
            >
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking…
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload up to {MAX_PHOTOS} photos
                </>
              )}
            </Button>
            <p className="mt-3 text-sm text-muted-foreground">
              Clear, well-lit close-ups of the brand label, logo, hardware, and stitching. No signup.
              This is an estimate, not a guarantee.
            </p>
          </div>
        ) : (
          <div>
            <div className="text-center">
              <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                Authenticity estimate
              </p>
              <p className={`mt-2 text-3xl font-bold ${VERDICT_UI[result.verdict].tone}`}>
                {VERDICT_UI[result.verdict].label}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {result.brandAssessed ? `${result.brandAssessed} · ` : ""}
                {Math.round(result.verdictConfidence * 100)}% confidence
              </p>
            </div>
            <p className="mt-6 rounded-lg border bg-muted/30 p-4 text-sm text-foreground">
              {result.summary}
            </p>
            <p className="mt-3 rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">
              {result.limitations}
            </p>
            {/* US-2526: someone checking whether an item is genuine is usually
                about to BUY it, and this page only ever sold the seller
                product. Same conversion moment the other two tools carry. */}
            <BuyerConversionCtas
              className="mt-5 bg-background"
              tool="grade_checker"
              result={{
                label: brand.trim() || "This item",
                brand: brand.trim() || null,
              }}
            />
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                to="/dashboard/submissions/new"
                onClick={() => onCtaClick("certify")}
              >
                <Button size="sm">
                  Get a certified grade
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
              <Link to="/signup" onClick={() => onCtaClick("signup")}>
                <Button size="sm" variant="secondary">
                  Create a free account
                </Button>
              </Link>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setResult(null);
                  setError(null);
                }}
              >
                Check another item
              </Button>
            </div>
          </div>
        )}
        {limited !== false
          ? <ToolLimitNotice toolLabel="authenticity checks" message={limited} />
          : error
          ? <p className="mt-4 text-center text-sm text-brand-red-text">{error}</p>
          : null}
      </div>
    </div>
  );
}

export function AuthenticityCheckPage() {
  return (
    <MarketingLayout
      title={AUTHENTICITY_CHECK_META.title}
      description={AUTHENTICITY_CHECK_META.description}
      canonicalPath={AUTHENTICITY_CHECK_PATH}
      breadcrumbs={authenticityCheckBreadcrumbItems()}
      jsonLd={authenticityCheckJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {AUTHENTICITY_CHECK_META.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{AUTHENTICITY_CHECK_META.intro}</p>
        </div>
        <div className="mt-10">
          <AuthenticityCheckTool />
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How it works</h2>
          <ol className="mt-8 space-y-6">
            {AUTHENTICITY_CHECK_META.steps.map((s, i) => (
              <li key={s.name} className="flex gap-4">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium text-foreground">{s.name}</p>
                  <p className="mt-1 text-muted-foreground">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
          <dl className="mt-10 space-y-6">
            {AUTHENTICITY_CHECK_META.faqs.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
