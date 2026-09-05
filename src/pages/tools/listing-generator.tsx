import { useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, Copy, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { CalculatorHandoff } from "@/components/marketing/calculator-funnel";
import { useCalculatorFunnel } from "@/lib/calculator-funnel";
import { ToolLimitNotice } from "@/components/marketing/tool-limit-notice";
import { isAtCapacity, isRateLimited } from "@/lib/tool-rate-limit";
import { edgeApiUrl } from "@/lib/edge-api";
import { track } from "@/lib/analytics";
import {
  getCalculatorBySlug,
  calculatorContent,
  calculatorPath,
} from "@/lib/seo/calculators";
import { calculatorJsonLd, calculatorBreadcrumbLdItems } from "@/pages/marketing/marketing-jsonld";
import {
  LISTING_DRAFT_ENDPOINT,
  LISTING_DRAFT_MAX_PHOTOS,
  LISTING_DRAFT_PER_HOUR,
  listingTemplate,
  listingTemplates,
  TEMPLATE_PLATFORMS,
  type TemplatePlatform,
} from "@/lib/seo/listing-templates";

// US-3089. Two halves on one page, and the order matters.
//
// The TEMPLATES render from static data and are the crawlable payload: somebody
// searching "ebay listing template" gets the thing they asked for before any
// script arrives, and it keeps working if the generator is ever turned off.
// Every limit in them is read from MARKETPLACE_SPECS through
// lib/seo/listing-templates.ts, which is what stops this page becoming another
// template site quoting a character count that stopped being true in 2019.
//
// The GENERATOR is the demonstration. All browser work (media-intake,
// FileReader, fetch) happens inside the handler so the page prerenders in Node.

const CALC = getCalculatorBySlug("listing-generator");

const TEMPLATES = listingTemplates();

interface DraftTitle {
  text: string;
  limit: number | null;
  trimmed: boolean;
  warnings: string[];
}

interface DraftResult {
  target: TemplatePlatform;
  title: DraftTitle;
  itemSpecifics: Record<string, string[]>;
  description: string;
  descriptionLimit: number | null;
  conditionNote: string;
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

/** A copy button that says what it copied. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            track("calculator_used", { calculator: CALC?.slug ?? "listing-generator" });
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => {
            /* clipboard blocked — the text is on screen and selectable */
          });
      }}
    >
      {copied ? (
        <>
          <Check className="mr-1 h-4 w-4" />
          Copied
        </>
      ) : (
        <>
          <Copy className="mr-1 h-4 w-4" />
          {label}
        </>
      )}
    </Button>
  );
}

function TemplatePanel({ platform }: { platform: TemplatePlatform }) {
  const t = listingTemplate(platform);
  return (
    <div className="space-y-6">
      {t.titlePattern ? (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-lg font-medium">Title pattern</h3>
            <p className="text-sm text-muted-foreground">
              {t.titleLimit} characters max
            </p>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-xl border bg-muted/30 p-4 text-sm">
            {t.titlePattern}
          </pre>
          <div className="mt-2">
            <CopyButton text={t.titlePattern} label="Copy title pattern" />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-muted/30 p-4">
          <h3 className="text-lg font-medium">No title field</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.label} has no separate title. The first line of the description is
            what a buyer sees, so it does the title&apos;s job.
          </p>
        </div>
      )}

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg font-medium">Description template</h3>
          <p className="text-sm text-muted-foreground">
            {t.descriptionLimit
              ? `${t.descriptionLimit.toLocaleString("en-US")} characters max`
              : "No length limit"}
          </p>
        </div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl border bg-muted/30 p-4 text-sm">
          {t.descriptionTemplate}
        </pre>
        <div className="mt-2">
          <CopyButton text={t.descriptionTemplate} label="Copy description template" />
        </div>
      </div>

      <div>
        <h3 className="text-lg font-medium">What {t.label} asks for</h3>
        <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
          {t.fields.map((f) => (
            <li key={f.key} className="text-muted-foreground">
              <span className="text-foreground">{f.label}</span>
              {f.required ? " (required)" : ""}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-lg font-medium">Condition wording on {t.label}</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {t.conditions.map((c) => c.value).join(" · ")}
        </p>
      </div>

      <div>
        <h3 className="text-lg font-medium">Worth knowing</h3>
        <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
          {t.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ListingGeneratorTool() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<TemplatePlatform>("ebay");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState<string | null | false>(false);
  const [capacity, setCapacity] = useState(false);
  const [result, setResult] = useState<DraftResult | null>(null);
  const [brand, setBrand] = useState("");
  const [size, setSize] = useState("");

  async function onFiles(files: File[]) {
    setBusy(true);
    setError(null);
    setLimited(false);
    setCapacity(false);
    setResult(null);
    try {
      // Dynamic import: media-intake pulls in browser-only HEIC libs — keep it
      // out of the prerender / module-eval path.
      const { normalizeToImageFile } = await import("@/lib/media-intake");
      const images: string[] = [];
      for (const file of files.slice(0, LISTING_DRAFT_MAX_PHOTOS)) {
        images.push(await readAsDataUrl(await normalizeToImageFile(file)));
      }
      const res = await fetch(`${edgeApiUrl()}${LISTING_DRAFT_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          images,
          target,
          ...(brand.trim() ? { brand: brand.trim() } : {}),
          ...(size.trim() ? { size: size.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | DraftResult
        | { error?: string; code?: string }
        | null;

      if (!res.ok || !body || !("title" in body)) {
        // US-2526, and the order of these three branches is the whole point.
        // A limit is not a bad photo, and being at capacity is neither.
        if (isRateLimited(res.status, body)) {
          setLimited(body && "error" in body && body.error ? body.error : null);
          return;
        }
        if (isAtCapacity(res.status, body)) {
          setCapacity(true);
          return;
        }
        setError(
          body && "error" in body && body.error
            ? body.error
            : "Couldn't write a listing for those photos. Try clearer, well-lit shots.",
        );
        return;
      }
      setResult(body);
      track("calculator_used", { calculator: CALC?.slug ?? "listing-generator" });
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
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void onFiles(files);
            e.target.value = "";
          }}
        />
        {!result ? (
          <div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="lg-brand" className="text-sm">
                  Brand <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="lg-brand"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="e.g. Patagonia"
                  disabled={busy}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="lg-size" className="text-sm">
                  Size <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="lg-size"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  placeholder="e.g. M"
                  disabled={busy}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium">Write it for</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {TEMPLATE_PLATFORMS.map((p) => (
                  <Button
                    key={p}
                    size="sm"
                    variant={target === p ? "default" : "outline"}
                    onClick={() => setTarget(p)}
                    disabled={busy}
                  >
                    {listingTemplate(p).label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="mt-6 text-center">
              <Button
                size="lg"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="w-full sm:w-auto"
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Writing the listing…
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Add up to {LISTING_DRAFT_MAX_PHOTOS} photos
                  </>
                )}
              </Button>
              <p className="mt-3 text-sm text-muted-foreground">
                Front, back and the care label works best. No signup.{" "}
                {LISTING_DRAFT_PER_HOUR} listings an hour per visitor, because
                each one costs a vision-model call.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-medium">
                Written for {listingTemplate(result.target).label}
              </h3>
              <p className="text-sm text-muted-foreground">
                {result.title.limit
                  ? `${result.title.text.length} / ${result.title.limit} characters`
                  : "No title field on this platform"}
              </p>
            </div>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl border bg-muted/30 p-4 text-sm">
              {result.title.text}
            </pre>
            <div className="mt-2 flex flex-wrap gap-2">
              <CopyButton text={result.title.text} label="Copy title" />
            </div>
            {result.title.trimmed ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Trimmed to fit the {result.title.limit}-character limit, on whole
                words.
              </p>
            ) : null}
            {result.title.warnings.length ? (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {result.title.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}

            {Object.keys(result.itemSpecifics).length ? (
              <div className="mt-6">
                <h3 className="text-lg font-medium">Item specifics</h3>
                <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                  {Object.entries(result.itemSpecifics).map(([k, v]) => (
                    <div key={k}>
                      <dt className="inline text-muted-foreground">{k}: </dt>
                      <dd className="inline">{v.join(", ")}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}

            <div className="mt-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-medium">Description</h3>
                <p className="text-sm text-muted-foreground">
                  {result.descriptionLimit
                    ? `${result.description.length} / ${result.descriptionLimit.toLocaleString("en-US")} characters`
                    : `${result.description.length} characters`}
                </p>
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl border bg-muted/30 p-4 text-sm">
                {result.description}
              </pre>
              <div className="mt-2">
                <CopyButton text={result.description} label="Copy description" />
              </div>
            </div>

            {result.conditionNote ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Condition note: {result.conditionNote}
              </p>
            ) : null}

            <p className="mt-6 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              {result.disclaimer}
            </p>

            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link to="/signup">
                <Button size="sm">
                  Create a free account
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
              <Button size="sm" variant="outline" onClick={() => setResult(null)}>
                Write another
              </Button>
            </div>
          </div>
        )}

        {limited !== false ? (
          <ToolLimitNotice toolLabel="listings" message={limited} />
        ) : capacity ? (
          <div className="mt-4 rounded-lg border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              The generator is at capacity right now
            </p>
            <p className="mt-1">
              That is us, not you, and not your photo. Nothing was used from your
              allowance. Try again a bit later, or copy the template above and
              write it yourself in the meantime.
            </p>
          </div>
        ) : error ? (
          <p className="mt-4 text-center text-sm text-brand-red-text">{error}</p>
        ) : null}
      </div>
    </div>
  );
}

function TemplateTabs() {
  const [active, setActive] = useState<TemplatePlatform>("ebay");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Roving focus. WAI-ARIA Authoring Practices expects arrow keys to move
  // between tabs in a tablist, and only the selected tab to be in the tab
  // order — otherwise a keyboard user pages through four buttons to reach the
  // content, on a page whose whole job is handing over text to copy.
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    const step = keys[e.key];
    const at = TEMPLATE_PLATFORMS.indexOf(active);
    let next: TemplatePlatform | undefined;
    if (step !== undefined) {
      next = TEMPLATE_PLATFORMS[(at + step + TEMPLATE_PLATFORMS.length) % TEMPLATE_PLATFORMS.length];
    } else if (e.key === "Home") {
      next = TEMPLATE_PLATFORMS[0];
    } else if (e.key === "End") {
      next = TEMPLATE_PLATFORMS[TEMPLATE_PLATFORMS.length - 1];
    }
    if (!next) return;
    e.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Listing templates by marketplace"
        className="flex flex-wrap gap-2"
      >
        {TEMPLATES.map((t) => (
          <button
            key={t.platform}
            type="button"
            role="tab"
            id={`tpl-tab-${t.platform}`}
            ref={(el) => {
              tabRefs.current[t.platform] = el;
            }}
            aria-selected={active === t.platform}
            aria-controls={`tpl-panel-${t.platform}`}
            tabIndex={active === t.platform ? 0 : -1}
            onKeyDown={onKeyDown}
            onClick={() => setActive(t.platform)}
            className={
              active === t.platform
                ? "rounded-full bg-brand-navy px-4 py-2 text-sm font-medium text-white dark:bg-foreground dark:text-background"
                : "rounded-full border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Every panel is in the DOM, so all four templates are in the static
          HTML the prerender emits and a reader with no JavaScript still gets
          them. Only the inactive ones are hidden. */}
      {TEMPLATES.map((t) => (
        <div
          key={t.platform}
          role="tabpanel"
          id={`tpl-panel-${t.platform}`}
          aria-labelledby={`tpl-tab-${t.platform}`}
          className={active === t.platform ? "mt-8" : "hidden"}
        >
          <TemplatePanel platform={t.platform} />
        </div>
      ))}
    </div>
  );
}

export function ListingGeneratorPage() {
  useCalculatorFunnel(CALC?.slug ?? "", null);

  if (!CALC) throw new Error("[listing-generator] not in the calculator registry");
  const { intro, faqs } = calculatorContent(CALC);

  return (
    <MarketingLayout
      title={CALC.title}
      description={CALC.description}
      canonicalPath={calculatorPath(CALC.slug)}
      breadcrumbs={calculatorBreadcrumbLdItems(CALC)}
      jsonLd={calculatorJsonLd(CALC)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{CALC.h1}</h1>
          <p className="mt-6 text-lg text-foreground">{intro}</p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Copy a template</h2>
          <p className="mt-2 text-muted-foreground">
            Every limit below is read from the same table our software uses when
            it pushes a real listing, so it changes when the marketplace does.
          </p>
          <div className="mt-8">
            <TemplateTabs />
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center text-3xl font-bold">
            Or drop a photo and have it written
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            The same words a template asks you to supply, taken off the garment
            instead. No price and no category, because both need comparable sales
            and an account to scope them to.
          </p>
        </div>
        <div className="mt-10">
          <ListingGeneratorTool />
        </div>
      </section>

      {/* US-3089 AC5: the handoff sits BELOW both halves. Above them it would be
          an advert in front of the thing the visitor came for. */}
      <CalculatorHandoff calc={CALC} />

      <section className="px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
          <dl className="mt-10 space-y-6">
            {faqs.map((faq) => (
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
