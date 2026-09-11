// US-3319: shared predicates for the size-chart content guards.
//
// WHY THIS EXISTS. The 2026-09 size-chart backfill (US-3283..US-3297) grew the
// corpus from a couple of charts per brand to as many as seven, and it broke
// eighteen guards. Every one of them had pinned WHERE a fact was written rather
// than WHAT had to be true: "the note contains the word BODY", "there are 14
// charts in this group", "the shared outerwear chart is reachable". None of
// those is the property; they were the shape the property happened to have when
// the guard was written, with two charts in the group.
//
// The predicates here assert the property instead, so the next brand that gets
// its own chart does not read as a regression — and, more important, so a chart
// that really does stop declaring its basis still reads as one.
//
// See vault/20-domain/brands/size-chart-guard-properties.md.

import type { SizingChart } from "../lib/sizing-charts.ts";

/** Stable identity of a chart: the same triple brand_size_charts keys on. */
export function chartId(c: SizingChart): string {
  return `${c.brand}|${c.department}|${c.garment}`;
}

/**
 * The text the vision prompt actually shows for a chart.
 *
 * `formatSizingChartsForPrompt` emits `brand — department garment` as the block
 * heading and the note underneath it, so a fact written into `garment` reaches
 * the model exactly as surely as one written into `note`. The old guards read
 * `note` only, which is why "Bottoms, US numeric (body inches)" read as a chart
 * that had stopped declaring its basis.
 */
export function promptText(c: SizingChart): string {
  return `${c.garment}\n${c.note ?? ""}`;
}

const BODY_BASIS = /\bbody\b/i;
const FLAT_BASIS =
  /flat[- ]garment|garment (measurement|waist|spec)|FLAT garment specs/i;

/**
 * Every chart must SAY which basis its numbers are, in text the model sees, and
 * the prose must AGREE with the structured `measurementBasis` field.
 *
 * The agreement half is new and is the reason this is stronger than the
 * `/BODY/i.test(note)` it replaces: a chart declared `measurementBasis: "flat"`
 * whose note talked about body measurements used to pass, and that is the exact
 * mistake — ease added on top of ease — the field was added to prevent.
 */
export function declaresMeasurementBasis(c: SizingChart): boolean {
  const text = promptText(c);
  return c.measurementBasis === "flat"
    ? FLAT_BASIS.test(text)
    : BODY_BASIS.test(text);
}

/**
 * Assert a shrink-only ledger of KNOWN violations.
 *
 * This is NOT an exemption list and must not be used as one. Each entry is a
 * recorded defect with a reason, and the check fails in BOTH directions: an
 * unlisted chart that violates the property fails, and a LISTED chart that has
 * started to satisfy it fails too, demanding its entry be deleted. So the list
 * can only ever get shorter, and a guard carrying one keeps catching the next
 * regression instead of being a red test everybody has learned to skip.
 *
 * @param charts   the charts the property applies to
 * @param holds    the property
 * @param ledger   chartId -> why it is currently broken
 * @param label    what the property is, for the failure message
 */
export function assertPropertyWithLedger(
  charts: SizingChart[],
  holds: (c: SizingChart) => boolean,
  ledger: Record<string, string>,
  label: string,
): void {
  const present = new Set(charts.map(chartId));
  const broken: string[] = [];
  const fixed: string[] = [];
  for (const c of charts) {
    const id = chartId(c);
    const ok = holds(c);
    if (id in ledger) {
      if (ok) fixed.push(id);
    } else if (!ok) {
      broken.push(id);
    }
  }
  const stale = Object.keys(ledger).filter((id) => !present.has(id));
  const problems: string[] = [];
  if (broken.length > 0) {
    problems.push(
      `these charts do not ${label}, and are not recorded as known gaps:\n  ` +
        broken.join("\n  "),
    );
  }
  if (fixed.length > 0) {
    problems.push(
      `these charts now ${label} — delete their ledger entries:\n  ` +
        fixed.join("\n  "),
    );
  }
  if (stale.length > 0) {
    problems.push(
      `these ledger entries name charts that no longer exist:\n  ` +
        stale.join("\n  "),
    );
  }
  if (problems.length > 0) throw new Error(problems.join("\n\n"));
}
