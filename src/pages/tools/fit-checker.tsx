import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, Ruler, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { FIT_CHECKER_META, FIT_CHECKER_PATH } from "@/lib/seo/fit-checker";
import { track } from "@/lib/analytics";
import { BODY_MEASUREMENT_FIELDS } from "@/lib/body-profile";
import { predictFit, fitVerdictLabel, type FitVerdict } from "@/lib/fit-model";
import type { MeasurementGroup } from "@/lib/measurement-templates";
import {
  fitCheckerJsonLd,
  fitCheckerBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1780: free "Will it fit me?" tool. The fit computation is deterministic and
// runs entirely client-side (fit-model.ts) — no endpoint, nothing sent to the
// server, so anonymous use persists no PII beyond the browser. Body measurements
// are kept in localStorage so a returning visitor doesn't re-enter them; that's
// the "anon session" from US-1777. All browser-only work stays out of the module
// scope so the landing content prerenders.

const GROUPS: { value: MeasurementGroup; label: string }[] = [
  { value: "top", label: "Top / shirt" },
  { value: "bottom", label: "Bottom / pants" },
  { value: "dress", label: "Dress" },
  { value: "outerwear", label: "Outerwear / jacket" },
  // US-2464: a suit set checks the jacket and the trousers in one pass.
  { value: "suit", label: "Suit set" },
];

// Garment flat-lay inputs shown per group (fit-relevant keys the engine compares).
const GARMENT_FIELDS: Record<MeasurementGroup, { key: string; label: string }[]> = {
  top: [
    { key: "chest", label: "Chest — pit to pit (flat)" },
    { key: "shoulder", label: "Shoulder (flat)" },
    { key: "sleeve", label: "Sleeve length" },
  ],
  outerwear: [
    { key: "chest", label: "Chest — pit to pit (flat)" },
    { key: "shoulder", label: "Shoulder (flat)" },
    { key: "sleeve", label: "Sleeve length" },
  ],
  bottom: [
    { key: "waist", label: "Waist (flat)" },
    { key: "hip", label: "Hip (flat)" },
    { key: "inseam", label: "Inseam" },
  ],
  dress: [
    { key: "bust", label: "Bust (flat)" },
    { key: "waist", label: "Waist (flat)" },
    { key: "hip", label: "Hip (flat)" },
  ],
  suit: [
    { key: "chest", label: "Jacket chest — pit to pit (flat)" },
    { key: "shoulder", label: "Jacket shoulder (flat)" },
    { key: "sleeve", label: "Jacket sleeve length" },
    { key: "waist", label: "Pant waist (flat)" },
    { key: "hip", label: "Pant hip (flat)" },
    { key: "inseam", label: "Pant inseam" },
  ],
  shoes: [],
  watch: [],
  // US-2225/US-2224: nothing to compare these against — the fit checker asks
  // for body measurements, and neither a bag nor a tie fits a body.
  bag: [],
  accessory: [],
  headwear: [],
  generic: [],
};

const BODY_FIELDS: Record<MeasurementGroup, string[]> = {
  top: ["chest", "shoulder", "sleeve"],
  outerwear: ["chest", "shoulder", "sleeve"],
  bottom: ["waist", "hips", "inseam"],
  dress: ["chest", "waist", "hips"],
  suit: ["chest", "shoulder", "sleeve", "waist", "hips", "inseam"],
  shoes: [],
  watch: [],
  bag: [],
  accessory: [],
  headwear: [],
  generic: [],
};

const BODY_LABEL = new Map(BODY_MEASUREMENT_FIELDS.map((f) => [f.key, f.label]));
const BODY_STORAGE_KEY = "gt-anon-body-measures-in"; // inches, anon session
const CM_PER_IN = 2.54;

const VERDICT_TONE: Record<FitVerdict, string> = {
  too_small: "text-brand-red-text",
  slim: "text-amber-600 dark:text-amber-400",
  true: "text-emerald-600 dark:text-emerald-400",
  relaxed: "text-amber-600 dark:text-amber-400",
  too_big: "text-brand-red-text",
};

function num(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function FitCheckerTool() {
  const [group, setGroup] = useState<MeasurementGroup>("top");
  const [unit, setUnit] = useState<"in" | "cm">("in");
  const [garment, setGarment] = useState<Record<string, string>>({});
  // Body values are stored in INCHES (canonical); displayed in the chosen unit.
  const [bodyIn, setBodyIn] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Hydrate anon body measurements from localStorage once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BODY_STORAGE_KEY);
      if (raw) setBodyIn(JSON.parse(raw));
    } catch {
      /* private mode / corrupt — ignore */
    }
  }, []);

  function setBody(key: string, displayValue: string) {
    const n = num(displayValue);
    const next = { ...bodyIn };
    if (n == null) delete next[key];
    else next[key] = unit === "cm" ? n / CM_PER_IN : n;
    setBodyIn(next);
    try {
      localStorage.setItem(BODY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  function bodyDisplay(key: string): string {
    const v = bodyIn[key];
    if (v == null) return "";
    return (unit === "cm" ? v * CM_PER_IN : v).toFixed(1).replace(/\.0$/, "");
  }

  const result = useMemo(() => {
    // Convert garment display inputs → inches for the engine.
    const garmentIn: Record<string, number> = {};
    for (const f of GARMENT_FIELDS[group]) {
      const n = num(garment[f.key] ?? "");
      if (n != null) garmentIn[f.key] = unit === "cm" ? n / CM_PER_IN : n;
    }
    return predictFit(group, garmentIn, bodyIn);
  }, [group, garment, bodyIn, unit]);

  function onCheck() {
    setSubmitted(true);
    track("fit_checker_result", { group, verdict: result.verdict ?? "insufficient" });
  }

  async function onShare() {
    const url = `${typeof window !== "undefined" ? window.location.origin : "https://gradethread.com"}${FIT_CHECKER_PATH}?utm_source=share&utm_medium=fit-result`;
    const text =
      result.status === "ok" && result.verdict
        ? `Fit check: ${fitVerdictLabel(result.verdict)} — checked free on GradeThread.`
        : "I used GradeThread's free fit checker.";
    track("fit_checker_share", { verdict: result.verdict ?? "insufficient" });
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ title: "GradeThread fit check", text, url });
        return;
      } catch {
        /* dismissed — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }

  const unitLabel = unit;
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border bg-card p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {GROUPS.map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => {
                  setGroup(g.value);
                  setSubmitted(false);
                }}
                className={`rounded-full border px-3 py-1 text-sm ${group === g.value ? "border-brand-navy bg-brand-navy text-white dark:border-foreground dark:bg-foreground dark:text-background" : "text-muted-foreground"}`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg border p-1 text-sm">
            {(["in", "cm"] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`rounded px-2 py-1 ${unit === u ? "bg-brand-navy text-white dark:bg-foreground dark:text-background" : "text-muted-foreground"}`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold">The garment ({unitLabel}, flat)</h2>
            <div className="mt-2 space-y-3">
              {GARMENT_FIELDS[group].map((f) => (
                <div key={f.key}>
                  <Label htmlFor={`g-${f.key}`} className="text-sm">{f.label}</Label>
                  <Input
                    id={`g-${f.key}`}
                    inputMode="decimal"
                    value={garment[f.key] ?? ""}
                    onChange={(e) => setGarment({ ...garment, [f.key]: e.target.value })}
                    className="mt-1"
                  />
                </div>
              ))}
            </div>
          </div>
          <div>
            <h2 className="text-sm font-semibold">Your body ({unitLabel})</h2>
            <div className="mt-2 space-y-3">
              {BODY_FIELDS[group].map((key) => (
                <div key={key}>
                  <Label htmlFor={`b-${key}`} className="text-sm">{BODY_LABEL.get(key) ?? key}</Label>
                  <Input
                    id={`b-${key}`}
                    inputMode="decimal"
                    value={bodyDisplay(key)}
                    onChange={(e) => setBody(key, e.target.value)}
                    className="mt-1"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <Button className="mt-6 w-full sm:w-auto" onClick={onCheck}>
          <Ruler className="mr-2 h-4 w-4" /> Check the fit
        </Button>

        {submitted && (
          <div className="mt-6 border-t pt-6">
            {result.status === "ok" && result.verdict ? (
              <>
                <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                  Fit estimate
                </p>
                <p className={`mt-1 text-3xl font-bold ${VERDICT_TONE[result.verdict]}`}>
                  {fitVerdictLabel(result.verdict)}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{result.sizeRecommendation}</p>
                {result.limitingDimension && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Limiting dimension:{" "}
                    {result.dimensions.find((d) => d.dimension === result.limitingDimension)?.label}
                  </p>
                )}
                <dl className="mt-4 grid gap-1 text-xs sm:grid-cols-2">
                  {result.dimensions.map((d) => (
                    <div key={d.dimension} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                      <dt className="text-muted-foreground">{d.label}</dt>
                      <dd className={`font-medium ${VERDICT_TONE[d.verdict]}`}>{fitVerdictLabel(d.verdict)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 text-xs text-muted-foreground">
                  An estimate from measurements and published ease tolerances — not a guarantee. Cut,
                  fabric stretch, and personal preference all affect real fit.{" "}
                  {Math.round(result.confidence * 100)}% confidence from {result.dimensions.length} dimension
                  {result.dimensions.length === 1 ? "" : "s"}.
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                  <Button size="sm" variant="outline" onClick={() => void onShare()}>
                    {copied ? (
                      <>
                        <Check className="mr-1 h-4 w-4" /> Link copied
                      </>
                    ) : (
                      <>
                        <Share2 className="mr-1 h-4 w-4" /> Share
                      </>
                    )}
                  </Button>
                  <Link to="/signup?utm_source=fit-checker">
                    <Button size="sm">
                      Save your measurements <ArrowRight className="ml-1 h-4 w-4" />
                    </Button>
                  </Link>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {result.reason ?? "Enter at least one matching garment + body measurement to check fit."}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function FitCheckerPage() {
  return (
    <MarketingLayout
      title={FIT_CHECKER_META.title}
      description={FIT_CHECKER_META.description}
      canonicalPath={FIT_CHECKER_PATH}
      breadcrumbs={fitCheckerBreadcrumbItems()}
      jsonLd={fitCheckerJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{FIT_CHECKER_META.h1}</h1>
          <p className="mt-6 text-lg text-foreground">{FIT_CHECKER_META.intro}</p>
        </div>
        <div className="mt-10">
          <FitCheckerTool />
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How it works</h2>
          <ol className="mt-8 space-y-6">
            {FIT_CHECKER_META.steps.map((s, i) => (
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
            {FIT_CHECKER_META.faqs.map((faq) => (
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
