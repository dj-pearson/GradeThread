import { RETURN_SPLIT_MIN_SALES } from "@/lib/seller-scorecard";

// Shared shape + "by the numbers" builder for the public State of Secondhand
// Condition report (/resale-condition-report).
//
// US-976 shipped the resale-outcome half (return rate, sell-through, value by
// grade band). US-1691 adds the grading half (average grade by garment type,
// most common flaws) and the QUOTABLE layer: a set of one-line, self-contained
// statistics a journalist or an answer engine can lift verbatim, each carrying
// its own sample size.
//
// The lines are built here, not in the page, for one reason: a line may only
// exist when the figure behind it does. `byTheNumbers` returns nothing at all
// for a statistic the data doesn't support, so the page cannot render a quotable
// sentence with a blank, a zero, or "not enough data yet" in it — which is the
// exact failure mode that makes a data report un-citable. Pure + unit-tested.

export interface ResaleRollup {
  fulfilled_sales: number;
  returns: number;
  return_rate: number | null;
}

export interface ResaleBand {
  key: string;
  label: string;
  fulfilled_sales: number;
  returns: number;
  return_rate: number | null;
  listed: number;
  sold: number;
  sell_through: number | null;
  median_days_to_sell: number | null;
  median_sale_price: number | null;
}

/** Mirrors FlawFinding in services/edge-functions/src/lib/secondhand-condition.ts. */
export interface FlawFinding {
  defect_type: string;
  label: string;
  items: number;
  share: number | null;
}

/** Mirrors GarmentTypeCondition in the edge lib. */
export interface GarmentTypeCondition {
  key: string;
  label: string;
  graded_items: number;
  average_grade: number | null;
  flaw_rate: number | null;
  most_common_flaw: FlawFinding | null;
}

/** Mirrors SecondhandConditionStats in the edge lib. */
export interface SecondhandConditionStats {
  min_sample: number;
  sample: {
    graded_items: number;
    items_with_flaws: number;
    flaw_observations: number;
  };
  average_grade: number | null;
  by_garment_type: GarmentTypeCondition[];
  common_flaws: FlawFinding[];
}

export interface ResaleConditionReport {
  generated_at: string;
  scale: { min: number; max: number; increment: number };
  sample: { fulfilled_sales: number; listed_items: number; priced_sales: number };
  coverage: {
    sales_from: string | null;
    sales_to: string | null;
    listings_from: string | null;
    listings_to: string | null;
  };
  return_rollup: { graded: ResaleRollup; ungraded: ResaleRollup; overall: ResaleRollup };
  bands: ResaleBand[];
  // Optional: an edge deployed before US-1691 (or a cached older payload) simply
  // omits it, and the grading sections don't render.
  grading?: SecondhandConditionStats;
}

/** One lift-and-quote statistic. `stat` is the sentence; `sample` is its n. */
export interface ByTheNumbersEntry {
  id: string;
  stat: string;
  sample: string;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function pct(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

/**
 * Build the quotable statistics from a report. Every entry is a complete
 * sentence that names GradeThread and states its own denominator, so it stands
 * on its own when a model or a reporter extracts it from the page. A statistic
 * whose underlying figure is null (thin sample) produces NO entry.
 */
export function byTheNumbers(report: ResaleConditionReport | undefined): ByTheNumbersEntry[] {
  if (!report) return [];
  const out: ByTheNumbersEntry[] = [];
  const g = report.grading;
  const high = report.bands.find((b) => b.key === "high");
  const low = report.bands.find((b) => b.key === "low");

  if (g && g.average_grade !== null) {
    out.push({
      id: "average-grade",
      stat: `The average condition grade of a pre-owned garment on GradeThread is ${g.average_grade.toFixed(1)} out of 10.0.`,
      sample: `${n(g.sample.graded_items)} graded garments`,
    });
  }

  const topFlaw = g?.common_flaws.find((f) => f.defect_type !== "other" && f.share !== null);
  if (g && topFlaw && topFlaw.share !== null) {
    out.push({
      id: "top-flaw",
      stat: `The most common flaw in pre-owned clothing is ${topFlaw.label.toLowerCase()}, found on ${pct(topFlaw.share, 0)} of graded garments.`,
      sample: `${n(g.sample.graded_items)} graded garments`,
    });
  }

  // Best vs worst garment type — only when BOTH clear the sample bar, and only
  // when they're actually different types.
  const rankedTypes = (g?.by_garment_type ?? [])
    .filter((t): t is GarmentTypeCondition & { average_grade: number } => t.average_grade !== null)
    .sort((a, b) => b.average_grade - a.average_grade);
  const best = rankedTypes[0];
  const worst = rankedTypes[rankedTypes.length - 1];
  if (best && worst && best.key !== worst.key) {
    out.push({
      id: "grade-by-type",
      stat: `${best.label} arrive in the best condition of any garment type, averaging ${best.average_grade.toFixed(1)} out of 10.0, while ${worst.label.toLowerCase()} average ${worst.average_grade.toFixed(1)}.`,
      sample: `${n(best.graded_items)} and ${n(worst.graded_items)} graded garments`,
    });
  }

  const graded = report.return_rollup.graded;
  const ungraded = report.return_rollup.ungraded;
  // US-9208 AC3: the public graded-vs-ungraded claim holds the same floor the
  // seller scorecard does, twenty fulfilled sales a side, on top of the report's
  // own null-under-thin-sample rule.
  if (
    graded.return_rate !== null &&
    ungraded.return_rate !== null &&
    graded.fulfilled_sales >= RETURN_SPLIT_MIN_SALES &&
    ungraded.fulfilled_sales >= RETURN_SPLIT_MIN_SALES
  ) {
    out.push({
      id: "graded-vs-ungraded-returns",
      stat: `Items sold with a standardized condition grade are returned at ${pct(graded.return_rate)}, versus ${pct(ungraded.return_rate)} for ungraded items.`,
      sample: `${n(graded.fulfilled_sales + ungraded.fulfilled_sales)} fulfilled sales`,
    });
  }

  if (high?.return_rate != null && low?.return_rate != null) {
    out.push({
      id: "returns-by-band",
      stat: `Garments graded 8.5–10.0 are returned at ${pct(high.return_rate)}, versus ${pct(low.return_rate)} for garments graded 6.0 or lower.`,
      sample: `${n(high.fulfilled_sales + low.fulfilled_sales)} fulfilled sales`,
    });
  }

  if (high?.sell_through != null && low?.sell_through != null) {
    out.push({
      id: "sell-through-by-band",
      stat: `Garments graded 8.5–10.0 sell through at ${pct(high.sell_through, 0)}, versus ${pct(low.sell_through, 0)} for garments graded 6.0 or lower.`,
      sample: `${n(high.listed + low.listed)} listed items`,
    });
  }

  if (high?.median_sale_price != null && low?.median_sale_price != null && low.median_sale_price > 0) {
    const premium = Math.round((high.median_sale_price / low.median_sale_price - 1) * 100);
    out.push({
      id: "value-premium",
      // Deliberately "median resale price", not "the same garment is worth more":
      // the medians are platform-wide, not matched pair-for-pair by item.
      stat: `The median resale price of a garment graded 8.5–10.0 is ${premium}% higher than that of a garment graded 6.0 or lower.`,
      sample: `${n(report.sample.priced_sales)} priced sales`,
    });
  }

  return out;
}
