import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { CalculatorHandoff } from "@/components/marketing/calculator-funnel";
import { useCalculatorFunnel } from "@/lib/calculator-funnel";
import {
  EBAY_CONDITIONS,
  buildSoldSearches,
  type EbayConditionId,
} from "@/lib/ebay-sold-search";
import {
  getCalculatorBySlug,
  calculatorContent,
  calculatorPath,
} from "@/lib/seo/calculators";
import {
  calculatorJsonLd,
  calculatorBreadcrumbLdItems,
} from "@/pages/marketing/marketing-jsonld";

// US-9021. The tool builds eBay sold-listing search URLs and does nothing else:
// no fetch, no account, nothing sent anywhere. That is a deliberate limit, not
// an unfinished feature — GradeThread has no source of realized sold prices
// (EBAY_MARKETPLACE_INSIGHTS has never been granted), so a page that printed
// its own "sold" numbers would be printing asking prices under the wrong word.
// eBay's sold results are real, free and public; handing the visitor a good
// search into them is the honest version of this tool and the one the query
// actually asked for.
//
// Every input lives inside the component so the explanation, the method and the
// FAQ prerender as static HTML. The page answers the question before a byte of
// script arrives, which is the whole point for a query this informational.

const CALC = getCalculatorBySlug("ebay-sold-listings");

export function EbaySoldListingsPage() {
  const [brand, setBrand] = useState("Patagonia");
  const [item, setItem] = useState("Synchilla Snap-T fleece");
  const [size, setSize] = useState("Medium");
  const [conditionId, setConditionId] = useState<EbayConditionId>("3000");

  const searches = useMemo(
    () => buildSoldSearches({ brand, item, size, conditionId }),
    [brand, item, size, conditionId],
  );

  useCalculatorFunnel(CALC?.slug ?? "", `${brand}|${item}|${size}|${conditionId}`);

  if (!CALC) throw new Error("[ebay-sold-listings] not in the calculator registry");
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
          <h2 className="text-2xl font-bold">Build the searches</h2>
          <p className="mt-3 text-muted-foreground">
            One search is not a comp set. These are the three worth opening for any
            garment, narrowest first, and they open on eBay in a new tab.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="sl-brand">Brand</Label>
              <Input
                id="sl-brand"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Patagonia"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="sl-item">Item</Label>
              <Input
                id="sl-item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="Synchilla Snap-T fleece"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="sl-size">Size (optional)</Label>
              <Input
                id="sl-size"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="Medium"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="sl-condition">Condition</Label>
              <select
                id="sl-condition"
                value={conditionId}
                onChange={(e) => setConditionId(e.target.value as EbayConditionId)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {EBAY_CONDITIONS.map((c) => (
                  <option key={c.id || "any"} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {searches.length > 0 ? (
            <ul className="mt-8 grid gap-4">
              {searches.map((s) => (
                <li key={s.rung} className="rounded-xl border p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <h3 className="text-lg font-semibold">{s.label}</h3>
                    <code className="rounded bg-muted px-2 py-1 text-xs">{s.keywords}</code>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{s.why}</p>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener nofollow"
                    className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
                  >
                    Open sold results on eBay
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-8 rounded-xl border border-dashed p-5 text-muted-foreground">
              Enter a brand or an item to build the searches.
            </p>
          )}

          <p className="mt-6 text-sm text-muted-foreground">
            Nothing you type here is sent anywhere. The searches are built in your
            browser and the links go straight to eBay.
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Doing it by hand</h2>
          <p className="mt-3 text-muted-foreground">
            The builder is a shortcut. The filter it is pressing for you is worth
            knowing, because it is the same three steps on every item.
          </p>
          <ol className="mt-6 grid gap-4">
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">1. Search the item on eBay</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Brand first, then what the thing is. Leave out the adjectives sellers
                pad titles with, because eBay matches your words against theirs and
                every extra word narrows the set.
              </p>
            </li>
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">2. Tick Sold items</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                On desktop it is in the left-hand filter column under Show only. In the
                phone app it is behind Filter. Sold results arrive already sorted by
                Ended Recently, so you do not need to change the sort.
              </p>
            </li>
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">3. Read the median, not the top price</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                The highest sold price on the page is the one everyone quotes and the
                one nobody repeats. Take the middle of the results that genuinely match
                your garment and price to that.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">What a sold price does not tell you</h2>
          <p className="mt-3 text-muted-foreground">
            Four things, all of them visible on any sold search once you know to look.
            Each was checked against a live search of sold Patagonia fleeces on
            28 August 2026 rather than taken on trust.
          </p>
          <dl className="mt-6 grid gap-5">
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">Best offer accepted hides the real price</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                Most of the sold clothing results on that search carried the label. The
                price shown is what the seller was asking; what the buyer paid is
                private. Your true median sits below what you are reading.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">Auctions and Buy It Now are different questions</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                The same fleece closed at $29 on five bids and at $65 on Buy It Now.
                Both are real sales. Averaging them describes neither, so decide which
                way you are selling before you pick a comp.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">The words matched, the garment may not have</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                A North Face fleece turned up in the Patagonia results, because the
                listing contained the words. This is why the brand-only search exists:
                when its median sits far from your narrow search, one of them caught the
                wrong item.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">Condition is invisible</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                A sold search cannot tell you whether the one that made $65 was mint or
                pilled at the cuffs, and condition is the largest single lever on resale
                price. eBay's condition filter is the seller's own label, not an
                assessment. It is a starting point, not a grade.{" "}
                <Link to="/condition-grading" className="font-medium text-primary hover:underline">
                  How condition grading works
                </Link>
                .
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Common questions</h2>
          <dl className="mt-6 grid gap-5">
            {faqs.map((f) => (
              <div key={f.q} className="rounded-xl border p-5">
                <dt className="font-semibold">{f.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-sm text-muted-foreground">
            Working out what a sale nets you after fees is the{" "}
            <Link to="/tools/ebay-fee-calculator" className="font-medium text-primary hover:underline">
              eBay fee calculator
            </Link>
            , and the rest are on the{" "}
            <Link to="/tools/calculators" className="font-medium text-primary hover:underline">
              tools hub
            </Link>
            .
          </p>
        </div>
      </section>

      <CalculatorHandoff calc={CALC} />

      <MarketingCTA
        heading="Price the item, then grade it"
        sub="A comp set tells you what comparable garments asked and closed at. It cannot tell a buyer that yours is the clean one. A GradeThread grade and certificate does, and it travels with the listing."
      />
    </MarketingLayout>
  );
}
