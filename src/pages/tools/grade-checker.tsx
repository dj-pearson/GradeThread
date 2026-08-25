import { useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, Loader2, Share2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { BuyerConversionCtas } from "@/components/marketing/buyer-conversion-ctas";
import { ToolLimitNotice } from "@/components/marketing/tool-limit-notice";
import { isRateLimited } from "@/lib/tool-rate-limit";
import {
  GRADE_CHECKER_ENDPOINT,
  GRADE_CHECKER_META,
  GRADE_CHECKER_PATH,
} from "@/lib/seo/grade-checker";
import { edgeApiUrl } from "@/lib/edge-api";
import { track } from "@/lib/analytics";
import { GRADE_FACTORS, type GradeFactorKey } from "@/lib/constants";
import {
  gradeCheckerJsonLd,
  gradeCheckerBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";
import { ValueBasisNote, type ValueBasis } from "@/components/value/value-basis-note";

// US-1687: free single-photo grade estimator. All browser work (media-intake,
// FileReader, fetch, edgeApiUrl) happens in the click handler so the page
// prerenders safely (Node) — the landing content is the crawlable payload.

interface GradeCheckValue {
  lowCents: number;
  medianCents: number;
  highCents: number;
  sampleSize: number;
  confidence: number;
  currency: string;
  /** US-2850: what this range is, worded by the edge. */
  basis?: ValueBasis;
}

interface GradeCheckResult {
  estimate: boolean;
  overallScore: number;
  gradeTier: string;
  confidence: number;
  factorScores?: Partial<Record<GradeFactorKey, number>>;
  value?: GradeCheckValue | null;
  disclaimer: string;
}

function formatValueRange(v: GradeCheckValue): string {
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: v.currency || "USD",
    maximumFractionDigits: 0,
  });
  return `${fmt.format(v.lowCents / 100)} – ${fmt.format(v.highCents / 100)}`;
}

function siteOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "https://gradethread.com";
}

// The shareable, STATELESS OG card image (functions/og/grade-check.ts). Every
// value rides in the query string — no stored result, no PII (only the grade,
// tier, an aggregate value range, and the brand/item the sharer typed).
function shareCardUrl(
  result: GradeCheckResult,
  brand: string,
  keyword: string,
): string {
  const q = new URLSearchParams({
    g: result.overallScore.toFixed(1),
    tier: result.gradeTier,
  });
  if (brand.trim()) q.set("brand", brand.trim());
  if (keyword.trim()) q.set("item", keyword.trim());
  if (result.value) {
    q.set("vlo", String(Math.round(result.value.lowCents / 100)));
    q.set("vhi", String(Math.round(result.value.highCents / 100)));
    q.set("cur", result.value.currency || "USD");
  }
  return `${siteOrigin()}/og/grade-check?${q.toString()}`;
}

// The landing link a share points at — the free tool itself, tagged so a share
// visit is attributable to the free-tool share channel (captured by
// captureAffiliateRef / analytics on load).
function shareLandingUrl(): string {
  return `${siteOrigin()}${GRADE_CHECKER_PATH}?utm_source=share&utm_medium=result-card`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function GradeCheckerTool() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GradeCheckResult | null>(null);
  const [brand, setBrand] = useState("");
  const [keyword, setKeyword] = useState("");
  const [copied, setCopied] = useState(false);
  // US-2526: the free limit is its own state, not an error string.
  const [limited, setLimited] = useState<string | null | false>(false);

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    setLimited(false);
    setResult(null);
    try {
      // Dynamic import: media-intake pulls in browser-only HEIC libs — keep it
      // out of the prerender/module-eval path.
      const { normalizeToImageFile } = await import("@/lib/media-intake");
      const normalized = await normalizeToImageFile(file);
      const dataUri = await readAsDataUrl(normalized);
      const res = await fetch(`${edgeApiUrl()}${GRADE_CHECKER_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: dataUri,
          // Optional — lets the grader attach a condition-adjusted resale range
          // (US-1751). Omitted keys are simply not sent.
          ...(brand.trim() ? { brand: brand.trim() } : {}),
          ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | GradeCheckResult
        | { error?: string }
        | null;
      if (!res.ok || !body || !("overallScore" in body)) {
        // US-2526: a limit is not a bad photo. Telling someone mid-conversion
        // to retake a shot that was fine sends them away to do work that
        // cannot help them.
        if (isRateLimited(res.status, body)) {
          setLimited(
            body && "error" in body && body.error ? body.error : null,
          );
          return;
        }
        const msg =
          body && "error" in body && body.error
            ? body.error
            : "Couldn't grade that photo. Try a clearer, well-lit shot.";
        setError(msg);
        return;
      }
      setResult(body);
      setCopied(false);
      // Conversion-funnel entry (US-1752): a free result was produced. Consent-
      // gated + never throws (see analytics.track).
      track("grade_checker_result", {
        grade: body.overallScore,
        has_value: !!body.value,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onShare() {
    if (!result) return;
    const url = shareLandingUrl();
    const text = result.value
      ? `I graded this ${result.gradeTier} (${result.overallScore.toFixed(1)}/10) — est. resale ${formatValueRange(result.value)} — free on GradeThread.`
      : `I graded this ${result.gradeTier} (${result.overallScore.toFixed(1)}/10) free on GradeThread.`;
    track("grade_checker_share", { method: "share_or_copy", has_value: !!result.value });
    // Native share where available; otherwise copy the landing link.
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ title: "GradeThread grade estimate", text, url });
        return;
      } catch {
        /* user dismissed or unsupported — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the link is still visible on the card image */
    }
  }

  function onCtaClick(cta: "signup" | "certify") {
    track("grade_checker_cta_click", { cta, has_value: !!result?.value });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border bg-card p-6 sm:p-8">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        {!result ? (
          <div className="text-center">
            <div className="mb-5 grid gap-3 text-left sm:grid-cols-2">
              <div>
                <Label htmlFor="gc-brand" className="text-sm">
                  Brand <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="gc-brand"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="e.g. Patagonia"
                  disabled={busy}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="gc-keyword" className="text-sm">
                  Item <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="gc-keyword"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="e.g. fleece jacket"
                  disabled={busy}
                  className="mt-1"
                />
              </div>
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
                  Grading…
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload a photo
                </>
              )}
            </Button>
            <p className="mt-3 text-sm text-muted-foreground">
              One clear, well-lit photo of the whole item. No signup. Add a brand and
              item to also see an estimated resale value.
            </p>
          </div>
        ) : (
          <div>
            <div className="text-center">
              <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                Rough estimate
              </p>
              <p className="mt-1 text-6xl font-bold text-brand-navy dark:text-foreground">
                {result.overallScore.toFixed(1)}
              </p>
              <p className="mt-1 text-lg font-medium">{result.gradeTier}</p>
            </div>
            {result.value ? (
              <div className="mt-6 rounded-lg border bg-brand-navy/5 p-4 text-center dark:bg-foreground/5">
                <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                  Estimated resale value
                </p>
                <p className="mt-1 text-3xl font-bold text-brand-navy dark:text-foreground">
                  {formatValueRange(result.value)}
                </p>
                {/* US-2850. This line used to say "recent comparable sales".
                    It was never true: the comps are ACTIVE eBay listings, so
                    every number here is an asking price. On an unauthenticated
                    page that a stranger meets us through, that is the last
                    thing we should be loose about. */}
                <ValueBasisNote basis={result.value.basis} className="mt-2 text-center" />
                <p className="mt-1 text-xs text-muted-foreground">
                  A range, not a guaranteed price.
                </p>
              </div>
            ) : null}
            {result.factorScores ? (
              <dl className="mt-6 space-y-2">
                {(Object.keys(GRADE_FACTORS) as GradeFactorKey[]).map((k) => {
                  const score = result.factorScores?.[k];
                  if (typeof score !== "number") return null;
                  return (
                    <div key={k} className="flex items-center gap-3">
                      <dt className="w-40 flex-shrink-0 text-sm text-muted-foreground">
                        {GRADE_FACTORS[k].label}
                      </dt>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-brand-navy dark:bg-foreground"
                          style={{ width: `${Math.max(0, Math.min(100, score * 10))}%` }}
                        />
                      </div>
                      <dd className="w-8 flex-shrink-0 text-right text-sm font-medium">
                        {score.toFixed(1)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : null}
            <p className="mt-6 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              {result.disclaimer}
            </p>

            {/* Shareable card + share action (US-1752). The card image is a
                stateless, no-PII OG render; the share link carries UTM
                attribution back to the free tool. */}
            <div className="mt-6 overflow-hidden rounded-xl border">
              <img
                src={shareCardUrl(result, brand, keyword)}
                alt="Shareable GradeThread grade card"
                loading="lazy"
                className="w-full"
              />
            </div>
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="outline" onClick={() => void onShare()}>
                {copied ? (
                  <>
                    <Check className="mr-1 h-4 w-4" />
                    Link copied
                  </>
                ) : (
                  <>
                    <Share2 className="mr-1 h-4 w-4" />
                    Share this result
                  </>
                )}
              </Button>
            </div>

            {/* US-1843: the buyer half of this funnel. The same free result is
                a buying decision as often as a selling one, so it also converts
                into a buyer account with the estimate carried across. */}
            <BuyerConversionCtas
              className="mt-6"
              tool="grade_checker"
              result={{
                label: [brand.trim(), keyword.trim()].filter(Boolean).join(" ") || "Your item",
                brand: brand.trim() || null,
                keyword: keyword.trim() || null,
                grade: result.overallScore,
                tier: result.gradeTier,
                medianCents: result.value?.medianCents ?? null,
                lowCents: result.value?.lowCents ?? null,
                highCents: result.value?.highCents ?? null,
                currency: result.value?.currency ?? "USD",
                sampleSize: result.value?.sampleSize ?? null,
              }}
            />

            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {/* US-2526: the primary CTA on a finished result went to
                  /how-it-works — an explainer, from someone who has just
                  watched it work. It goes to the submission flow now; signup
                  catches them on the way if they are not signed in. */}
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
                Check another photo
              </Button>
            </div>
          </div>
        )}
        {limited !== false
          ? <ToolLimitNotice toolLabel="grade checks" message={limited} />
          : error
          ? <p className="mt-4 text-center text-sm text-brand-red-text">{error}</p>
          : null}
      </div>
    </div>
  );
}

export function GradeCheckerPage() {
  return (
    <MarketingLayout
      title={GRADE_CHECKER_META.title}
      description={GRADE_CHECKER_META.description}
      canonicalPath={GRADE_CHECKER_PATH}
      breadcrumbs={gradeCheckerBreadcrumbItems()}
      jsonLd={gradeCheckerJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {GRADE_CHECKER_META.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{GRADE_CHECKER_META.intro}</p>
        </div>
        <div className="mt-10">
          <GradeCheckerTool />
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How it works</h2>
          <ol className="mt-8 space-y-6">
            {GRADE_CHECKER_META.steps.map((s, i) => (
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
            {GRADE_CHECKER_META.faqs.map((faq) => (
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
