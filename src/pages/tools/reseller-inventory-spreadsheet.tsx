import { useState } from "react";
import { Link } from "react-router";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { CalculatorHandoff } from "@/components/marketing/calculator-funnel";
import { useCalculatorFunnel } from "@/lib/calculator-funnel";
import { track } from "@/lib/analytics";
import {
  TEMPLATE_COLUMNS,
  TEMPLATE_FILENAME,
  buildInventoryTemplateCsv,
} from "@/lib/reseller-inventory-template";
import {
  getCalculatorBySlug,
  calculatorContent,
  calculatorPath,
} from "@/lib/seo/calculators";
import {
  calculatorJsonLd,
  calculatorBreadcrumbLdItems,
} from "@/pages/marketing/marketing-jsonld";

// US-9022. Only 1,600/mo, which is small, but the top-of-page bid is $21.71 —
// three times anything else in either keyword pull — and the searcher is
// precisely the person FlipDesk is for.
//
// THE FILE IS ABOVE THE FOLD AND UNGATED, on purpose. Asking for an email
// would raise a lead count and lose the ranking, and the ranking is the asset.
// /blog/when-should-resellers-stop-using-spreadsheets-inventory already makes
// the argument without handing over the file, and it earns nothing.
//
// The CSV is generated in the browser from the same TEMPLATE_COLUMNS the page
// renders as its column guide, so the file and the description of the file
// cannot drift apart. Nothing is uploaded and no account is involved.

const CALC = getCalculatorBySlug("reseller-inventory-spreadsheet");

export function ResellerInventorySpreadsheetPage() {
  const [downloaded, setDownloaded] = useState(false);

  useCalculatorFunnel(CALC?.slug ?? "", downloaded ? "downloaded" : "");

  if (!CALC) throw new Error("[reseller-inventory-spreadsheet] not in the calculator registry");
  const { intro, faqs } = calculatorContent(CALC);

  function download() {
    const blob = new Blob([buildInventoryTemplateCsv()], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = TEMPLATE_FILENAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    track("inventory_template_downloaded", { slug: CALC!.slug });
  }

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
          <div className="mt-8">
            <Button size="lg" onClick={download} className="gap-2">
              <Download className="h-5 w-5" aria-hidden="true" />
              Download the spreadsheet
            </Button>
            <p className="mt-3 text-sm text-muted-foreground">
              CSV, {TEMPLATE_COLUMNS.length} columns, formulas included. No email, no
              account.
              {downloaded ? " Saved to your downloads folder." : ""}
            </p>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">What is in it</h2>
          <p className="mt-3 text-muted-foreground">
            Nineteen columns. The last three calculate themselves; the rest you fill in
            as the item moves.
          </p>
          <div className="mt-6 overflow-x-auto rounded-xl border">
            <table className="w-full min-w-125 text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Column</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">What goes in it</th>
                </tr>
              </thead>
              <tbody>
                {TEMPLATE_COLUMNS.map((c) => (
                  <tr key={c.letter} className="border-t">
                    <td className="px-4 py-3 align-top font-medium whitespace-nowrap">
                      {c.header}
                      {c.formula ? (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                          calculated
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      {c.note || <span aria-hidden="true">&mdash;</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">The column every other template leaves out</h2>
          <p className="mt-4 text-muted-foreground">
            Condition grade, column H, on the 1.0 to 10.0 scale. It is the difference
            between a spreadsheet that records what happened and one that tells you what
            to buy next.
          </p>
          <p className="mt-4 text-muted-foreground">
            Two Patagonia fleeces bought for nine dollars each, sold six weeks apart,
            one for $65 and one for $28. In a normal spreadsheet that is variance and
            you learn nothing from it. With a grade in the row it is a 7.5 and a 4.0,
            and the lesson is a sourcing rule you can act on this weekend.
          </p>
          <p className="mt-4 text-muted-foreground">
            Grade it consistently or the column is noise. The{" "}
            <Link to="/condition-grading" className="font-medium text-primary hover:underline">
              grading scale
            </Link>{" "}
            is published, and{" "}
            <Link to="/tools/grade-checker" className="font-medium text-primary hover:underline">
              the free grade checker
            </Link>{" "}
            will give you a number from photos if you would rather not eyeball it.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Getting it into Google Sheets</h2>
          <ol className="mt-6 grid gap-4">
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">1. Download it</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                The button above. It saves as {TEMPLATE_FILENAME}.
              </p>
            </li>
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">2. File, then Import</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                In a new Google Sheet, choose File then Import, upload the file and pick
                Replace spreadsheet. Dragging it into Drive works too.
              </p>
            </li>
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">3. Format the margin column</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Column R arrives as a decimal. Select it and format as a percentage.
                This is the one thing a CSV cannot carry for you.
              </p>
            </li>
          </ol>
          <p className="mt-6 text-sm text-muted-foreground">
            Excel and Numbers open it by double-clicking, with the formulas already
            live.
          </p>
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
            The fees column is easier to fill in with the{" "}
            <Link to="/tools/ebay-fee-calculator" className="font-medium text-primary hover:underline">
              eBay fee calculator
            </Link>{" "}
            open next to it.
          </p>
        </div>
      </section>

      <CalculatorHandoff calc={CALC} />

      <MarketingCTA
        heading="The grade column, filled in for you"
        sub="Column H is the one that makes the file worth keeping and the one that is tedious to fill in honestly. GradeThread grades from photos and gives the buyer a certificate they can check."
      />
    </MarketingLayout>
  );
}
