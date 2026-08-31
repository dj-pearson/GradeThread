import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, Loader2, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { rnLookupJsonLd } from "@/pages/marketing/marketing-jsonld";
import { edgeApiUrl } from "@/lib/edge-api";
import { track } from "@/lib/analytics";
import {
  RN_LOOKUP_META,
  RN_LOOKUP_PATH,
  TAG_READ_ENDPOINT,
} from "@/lib/seo/rn-lookup";

// US-9033: the RN lookup hub.
//
// The per-number pages at /rn/:number are edge-SSR'd static HTML, exactly like
// /style/:code. Everything interactive lives HERE, which is the same split the
// style-code family already ships (src/pages/marketing/style-code-lookup.tsx),
// and the SSR pages link back with ?rn= prefilled.
//
// All browser work (FileReader, fetch, edgeApiUrl) happens inside handlers so
// the page prerenders safely in Node — the landing copy is the crawlable half.

interface TagRead {
  rn: string | null;
  size: string | null;
  fiberContent: string | null;
  styleCode: string | null;
  brand: string | null;
  disclaimer?: string;
}

/** Digits only, leading zeros stripped — the same shape /rn/:number canonicalises to. */
export function normalizeRnInput(raw: string): string | null {
  const m = raw.trim().match(/^\s*(RN|CA)?\s*#?\s*(\d{2,7})\s*$/i);
  if (!m) return null;
  const digits = (m[2] ?? "").replace(/^0+/, "");
  return digits.length > 0 ? digits : null;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function RnSearchBox() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The SSR pages at /rn/:number link here with the number prefilled, so a
  // reader who lands on a blank answer can go straight to the tag reader.
  useEffect(() => {
    const rn = new URLSearchParams(window.location.search).get("rn");
    if (rn) setValue(rn);
  }, []);

  const submit = () => {
    const digits = normalizeRnInput(value);
    if (!digits) {
      setError("That does not look like an RN. It is two to seven digits, printed after RN on the care label.");
      return;
    }
    setError(null);
    track("rn_lookup_searched", { digits });
    navigate(`/rn/${digits}`);
  };

  return (
    <div className="rounded-2xl border bg-card p-6">
      <Label htmlFor="rn-number">RN number</Label>
      <div className="mt-2 flex gap-2">
        <Input
          id="rn-number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="e.g. 56323"
          inputMode="numeric"
          autoComplete="off"
        />
        <Button onClick={submit}>
          <Search className="mr-2 h-4 w-4" />
          Look up
        </Button>
      </div>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      <p className="mt-3 text-sm text-muted-foreground">
        Type the digits with or without the RN. Canadian CA numbers work too.
      </p>
    </div>
  );
}

/**
 * The conversion pitch, and the rule about where it goes.
 *
 * US-9033 asks for it AFTER the answer and never before. That ordering is the
 * whole deal the page offers: somebody arriving off `rn number lookup` came for
 * a company name, and a tool that withholds one until you sign up is the reason
 * they were on a free mirror in the first place. They get the answer, they watch
 * the reader pull four more fields off their own photo, and only then are they
 * asked for anything.
 *
 * Mirrors the grade checker's block (src/pages/tools/grade-checker.tsx), down to
 * the US-2526 lesson that the primary control goes to the submission flow rather
 * than to an explainer — this reader has just watched it work and does not need
 * telling how.
 */
function AfterAnswerPitch() {
  const onCta = (cta: "certify" | "signup") =>
    track("rn_lookup_cta_click", { cta });

  return (
    <div className="mt-6 border-t pt-6">
      <p className="text-sm text-foreground">
        That is the same reader our sellers run on every item they list. It also
        grades the garment&apos;s condition from photos and writes the listing.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to="/dashboard/submissions/new" onClick={() => onCta("certify")}>
          <Button size="sm">
            Grade this item
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </Link>
        <Link to="/signup" onClick={() => onCta("signup")}>
          <Button size="sm" variant="secondary">
            Create a free account
          </Button>
        </Link>
      </div>
    </div>
  );
}

function TagReader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TagRead | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const image = await readAsDataUrl(file);
      const res = await fetch(`${edgeApiUrl()}${TAG_READ_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const body = (await res.json().catch(() => null)) as
        | (TagRead & { error?: string; code?: string })
        | null;
      if (!res.ok) {
        // US-2526: a limit is not a bad photo, and telling someone to retake a
        // fine picture is how a working tool reads as broken.
        setError(
          body?.code === "rate_limited"
            ? "You have used the free tag reader a few times in the last hour. Try again later."
            : body?.error ?? "Couldn't read that tag. Try a straighter, better-lit photo.",
        );
        return;
      }
      setResult(body);
      track("rn_tag_read", { found_rn: Boolean(body?.rn) });
    } catch {
      setError("Couldn't read that tag. Try a straighter, better-lit photo.");
    } finally {
      setBusy(false);
    }
  };

  const rows: Array<[string, string | null]> = result
    ? [
      ["RN", result.rn],
      ["Brand", result.brand],
      ["Size", result.size],
      ["Fabric", result.fiberContent],
      ["Style code", result.styleCode],
    ]
    : [];

  return (
    <div className="rounded-2xl border bg-card p-6">
      <h2 className="text-xl font-semibold">Or photograph the label</h2>
      <p className="mt-2 text-muted-foreground">
        Drop a photo of the care label and we will read the RN, the size, the
        fabric content and the style code off it. No account, and the photo is
        not stored.
      </p>

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

      <Button
        className="mt-4"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        {busy
          ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          : <Upload className="mr-2 h-4 w-4" />}
        {busy ? "Reading the label" : "Upload a tag photo"}
      </Button>

      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

      {result
        ? (
          <div className="mt-6">
            <dl className="divide-y rounded-xl border">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-4 px-4 py-3">
                  <dt className="w-28 flex-shrink-0 text-sm text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="text-sm font-medium">
                    {value ?? <span className="text-muted-foreground">not readable</span>}
                  </dd>
                </div>
              ))}
            </dl>
            {result.rn && normalizeRnInput(result.rn)
              ? (
                <Button asChild variant="secondary" className="mt-4">
                  <a href={`/rn/${normalizeRnInput(result.rn)}`}>
                    See who {result.rn} belongs to
                  </a>
                </Button>
              )
              : null}
            {result.disclaimer
              ? <p className="mt-4 text-xs text-muted-foreground">{result.disclaimer}</p>
              : null}
            <AfterAnswerPitch />
          </div>
        )
        : null}
    </div>
  );
}

export function RnLookupPage() {
  return (
    <MarketingLayout
      title={RN_LOOKUP_META.title}
      description={RN_LOOKUP_META.description}
      canonicalPath={RN_LOOKUP_PATH}
      jsonLd={rnLookupJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {RN_LOOKUP_META.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{RN_LOOKUP_META.intro}</p>
        </div>
        <div className="mx-auto mt-10 grid max-w-3xl gap-6">
          <RnSearchBox />
          <TagReader />
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How it works</h2>
          <ol className="mt-8 space-y-6">
            {RN_LOOKUP_META.steps.map((s, i) => (
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
            {RN_LOOKUP_META.faqs.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </MarketingLayout>
  );
}
