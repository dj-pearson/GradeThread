import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  GRADE_CHECKER_ENDPOINT,
  GRADE_CHECKER_META,
  GRADE_CHECKER_PATH,
} from "@/lib/seo/grade-checker";
import { edgeApiUrl } from "@/lib/edge-api";
import { GRADE_FACTORS, type GradeFactorKey } from "@/lib/constants";
import {
  gradeCheckerJsonLd,
  gradeCheckerBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1687: free single-photo grade estimator. All browser work (media-intake,
// FileReader, fetch, edgeApiUrl) happens in the click handler so the page
// prerenders safely (Node) — the landing content is the crawlable payload.

interface GradeCheckResult {
  estimate: boolean;
  overallScore: number;
  gradeTier: string;
  confidence: number;
  factorScores?: Partial<Record<GradeFactorKey, number>>;
  disclaimer: string;
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

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
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
        body: JSON.stringify({ image: dataUri }),
      });
      const body = (await res.json().catch(() => null)) as
        | GradeCheckResult
        | { error?: string }
        | null;
      if (!res.ok || !body || !("overallScore" in body)) {
        const msg =
          body && "error" in body && body.error
            ? body.error
            : "Couldn't grade that photo. Try a clearer, well-lit shot.";
        setError(msg);
        return;
      }
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
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
              One clear, well-lit photo of the whole item. No signup.
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
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Link to="/how-it-works">
                <Button size="sm">
                  Get a certified grade
                  <ArrowRight className="ml-1 h-4 w-4" />
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
        {error ? <p className="mt-4 text-center text-sm text-brand-red">{error}</p> : null}
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
