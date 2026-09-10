// US-3283: the size guide the Measurements card links to.
//
// WHAT IT REPLACES. The old link read "[Brand] size guide" and, for most
// brands, went to a Google search — three ads and a reseller blog before the
// brand's own page, if the brand's page still exists at all. Meanwhile the
// answer was already on the server: 286 curated charts across 166 brands, one
// of which the composer had ALREADY FETCHED to run the size check. The link
// sent sellers away from a page that was holding the data.
//
// WHAT IT SHOWS, in the order it matters:
//   1. Where to put the tape, drawn for this garment group. The number sellers
//      get wrong is almost never the arithmetic.
//   2. The brand's chart, verbatim, with the item's own size row marked.
//   3. Where the item's measurements actually land, from the same band table
//      the inline size check uses — so the panel and the note under the form
//      can never disagree.
//   4. Honest provenance: which tier the chart is, whether the numbers are
//      body or flat, and a link to the brand's own guide when one exists.
//
// The Google search survives as the EMPTY state only. A brand with no chart
// gets the diagram plus the search, which is strictly more than it had.

import { useState } from "react";
import { ExternalLink, Ruler } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { sizeGuideUrl } from "@/lib/measurement-templates";
import {
  MEASUREMENT_TEMPLATES,
  type MeasurementGroup,
} from "@/lib/measurement-templates";
import {
  checkSize,
  resolveSizeRow,
  type SizeBandsResponse,
  type SizeChartTier,
  type SizeGuideChart,
} from "@/lib/size-check";
import { SizeGuideDiagram } from "./size-guide-diagram";

/**
 * How much the chart is worth trusting, said plainly. `none` never reaches a
 * rendered badge — a chart that exists is never tier "none" — but the type
 * covers it so a future tier cannot silently render as an empty pill.
 */
const TIER_LABEL: Record<SizeChartTier, string> = {
  verified: "Checked against the brand's own guide",
  brand: "From the brand's published guide",
  generic: "Estimate — we have no chart for this brand yet",
  none: "No chart on file",
};

function basisLine(chart: SizeGuideChart): string {
  return chart.measurementBasis === "flat"
    ? "These are garment measurements, taken flat, in inches."
    : "These are BODY measurements (the wearer), in inches — not the garment laid flat. Your own numbers below are flat, so they will read about half of these.";
}

function subtitle(chart: SizeGuideChart): string {
  const bits = [chart.department, chart.garment].filter(Boolean);
  if (chart.sizeClass && chart.sizeClass !== "standard")
    bits.push(chart.sizeClass);
  return bits.join(" · ");
}

interface ChartTableProps {
  chart: SizeGuideChart;
  /** The item's size label, marked in the run when it matches a row. */
  size: string | null;
}

function ChartTable({ chart, size }: ChartTableProps) {
  // Reuses the same matcher the size check runs, so "L", "Large" and "lge" mark
  // the same row here that they resolve to there.
  const matched = resolveSizeRow(
    chart.rows.map((r) => ({ size: r.size, index: r.index, bands: {} })),
    size,
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border/60 bg-muted/50">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Size
            </th>
            {chart.columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className="px-3 py-2 text-left font-medium whitespace-nowrap"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.rows.map((row) => {
            const isItem = matched !== null && matched === row.index;
            return (
              <tr
                key={`${row.index}-${row.size}`}
                className={cn(
                  "border-b border-border/40 last:border-0",
                  isItem && "bg-primary/8",
                )}
              >
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-medium whitespace-nowrap"
                >
                  {row.size}
                  {isItem && (
                    <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      This item
                    </span>
                  )}
                </th>
                {chart.columns.map((col) => (
                  <td
                    key={col.key}
                    className="px-3 py-2 whitespace-nowrap tabular-nums"
                  >
                    {row.values[col.key] ?? (
                      <span className="text-muted-foreground/60">&mdash;</span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {chart.rows.some((r) => r.footnote) && (
        <ul className="space-y-1 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          {chart.rows
            .filter((r) => r.footnote)
            .map((r) => (
              <li key={`fn-${r.index}`}>
                <span className="font-medium">{r.size}:</span> {r.footnote}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

interface Props {
  brand: string | null | undefined;
  /** Garment group, already resolved from the item's category by the form. */
  group: MeasurementGroup;
  /** The size-bands response the form has already fetched. */
  bands: SizeBandsResponse;
  size: string | null | undefined;
  values: Record<string, number | string>;
}

/**
 * Everything below the dialog's title bar, as a plain component with no Radix
 * primitives in it.
 *
 * Split from the trigger so it can be rendered and asserted on directly. A
 * Radix dialog's content lives behind a portal, which renderToStaticMarkup —
 * the only rendering tool this repo's tests use — emits as nothing at all, so
 * testing through the trigger would only prove that a closed dialog is closed.
 */
export function SizeGuideBody({ brand, group, bands, size, values }: Props) {
  // Which chart is on screen. Index into [chart, ...alternates]; a brand that
  // sells to two departments and an item that does not say which is the case
  // this exists for, and it is common enough that hiding the other chart
  // behind "search the web" is what the old link amounted to.
  const [pick, setPick] = useState(0);

  const charts = [bands.chart, ...bands.alternates].filter(
    (c): c is SizeGuideChart => c !== null,
  );
  const chart = charts[Math.min(pick, charts.length - 1)] ?? null;

  const sizeText = (size ?? "").trim() || null;
  const brandText = (brand ?? "").trim() || null;

  // Where the item's own numbers land in the run. Straight from the band table
  // the inline check uses, so this line and the note under the form are the
  // same claim rather than two claims that can drift apart.
  const verdict = checkSize({
    bands: bands.rows,
    rowIndex: resolveSizeRow(bands.rows, sizeText),
    measurements: values,
    tier: bands.tier,
  });

  // Every field the form asks for. The diagram draws the ones it has a line
  // for and silently drops the rest, which is why this is the whole template
  // rather than a hand-kept subset that could fall out of step with it.
  const fields = MEASUREMENT_TEMPLATES[group].map((f) => f.key);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)] sm:items-start">
        <SizeGuideDiagram
          group={group}
          fields={fields}
          className="mx-auto w-full max-w-[200px] text-brand-red-text"
        />
        <div className="space-y-2 text-xs">
          {chart ? (
            <>
              <p className="font-medium">{subtitle(chart)}</p>
              <Badge variant="outline" className="font-normal">
                {TIER_LABEL[chart.tier]}
              </Badge>
              <p className="text-muted-foreground">{basisLine(chart)}</p>
              {chart.sizeSystem && (
                <p className="text-muted-foreground">
                  Sizes are written in the {chart.sizeSystem} system.
                </p>
              )}
              {chart.note && <p className="text-muted-foreground">{chart.note}</p>}
            </>
          ) : (
            <p className="text-muted-foreground">
              We have no chart for this brand yet, so this is where each
              measurement is taken and nothing more. Measure the garment laid
              flat and enter the numbers on the form.
            </p>
          )}
          <a
            href={sizeGuideUrl(brandText ?? "", chart?.sourceUrl ?? bands.sourceUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-red-text hover:underline"
          >
            {chart?.sourceUrl ? "The brand's own guide" : "Search the web"}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {charts.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {charts.map((c, i) => (
            <button
              key={`${c.department}-${c.garment}`}
              type="button"
              onClick={() => setPick(i)}
              aria-pressed={c === chart}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-xs",
                c === chart
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-border hover:bg-muted",
              )}
            >
              {c.department} &middot; {c.garment}
            </button>
          ))}
        </div>
      )}

      {chart && <ChartTable chart={chart} size={sizeText} />}

      {verdict.impliedSize && sizeText && (
        <p className="text-xs text-muted-foreground">
          {verdict.status === "ok"
            ? `Your measurements agree with ${sizeText}.`
            : `Your measurements land closer to ${verdict.impliedSize} than to ${sizeText}.`}
        </p>
      )}
    </div>
  );
}

export function SizeGuidePanel(props: Props) {
  const [open, setOpen] = useState(false);
  const brandText = (props.brand ?? "").trim() || null;
  const title = brandText ? `${brandText} size guide` : "Size guide";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-brand-red-text hover:underline"
        >
          <Ruler className="h-3 w-3" />
          {title}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Where to measure, and the size run this brand publishes.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: the chart table is the widest thing in the
            composer and there is no reason to build one for every item a seller
            scrolls past in the queue. */}
        {open && <SizeGuideBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}
