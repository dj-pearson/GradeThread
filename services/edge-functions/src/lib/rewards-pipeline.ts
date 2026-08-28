// US-2970: derive which FlipDesk pipeline stages an item PROVABLY reached.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS DERIVED AND NOT EMITTED.
//
// Every other rewardable act in the system calls grantReward at its source: a
// grade finishes, a badge is served, a marketplace connects. The pipeline can't
// work that way. 252 lines across services/edge-functions/src/routes/flipdesk-*.ts
// write inventory_items.status, there is no choke point to wrap, and any hook
// set assembled by hand would be incomplete on the day it shipped and would rot
// as routes were added. A missing hook is invisible: it looks exactly like a
// seller who did not do the work.
//
// So the marks are read off durable state instead. The sweep (US-2971) grants
// whatever is missing, keyed on "<item id>:<stage>", and 00417's UNIQUE index
// uq_reputation_event_ref makes a repeat grant impossible at the database level.
// One consequence worth stating plainly: this same function IS the backfill.
// There is no separate one-time script to write, test and throw away.
//
// ⚠ inventory_items.status is deliberately NOT an input. Items move backward —
// returned, relisted, archived — and a single enum value cannot say which
// earlier stages actually happened. Only evidence that survives counts.
//
// ⚠ Comps that predate migration 00679 cannot be recovered. The comp stage left
// no reliable mark: repricing_suggestions.listing_id is NOT NULL, so a comp run
// before the item had a listing wrote no row at all, and comped_at did not
// exist. Those items lose item_comped (3 XP) and keep every other stage. This
// is a known, permanent gap, not a bug to go hunting for.
//
// Design: docs/superpowers/specs/2026-08-28-pipeline-xp-rewards-design.md
// ─────────────────────────────────────────────────────────────────────────────

/** The seven pipeline stages, in the order a seller works them. */
export type PipelineStage =
  | "item_cataloged"
  | "item_measured"
  | "item_photographed"
  | "item_comped"
  | "item_drafted"
  | "item_listed"
  | "item_sold";

export interface PipelineMark {
  stage: PipelineStage;
  /** ISO timestamp the stage actually happened — becomes the event's occurred_at. */
  occurredAt: string;
}

// The row shapes below are the COLUMNS THIS FUNCTION READS, not the full tables.
// Narrow on purpose: the sweep selects exactly these, and a reader can see the
// entire evidence surface without opening a migration.

export interface PipelineItem {
  id: string;
  brand: string | null;
  garment_type: string | null;
  measurements: unknown | null;
  comped_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelinePhoto {
  created_at: string;
}

export interface PipelineListing {
  /** Non-empty only once the listing is really live on a marketplace. */
  platform_listing_id: string | null;
  listed_at: string | null;
  created_at: string;
}

export interface PipelineSale {
  sale_price: number | string | null;
  sold_at: string | null;
  sale_date: string;
}

export interface PipelineRepricing {
  created_at: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A text column that is present and not just whitespace. */
function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * True when `measurements` holds anything. The column is jsonb, so an
 * abandoned measure screen leaves `{}` and an array is legal too — neither is
 * a measurement.
 */
function hasMeasurements(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return false;
}

/** A sale row counts only when money actually changed hands. */
function hasPrice(value: number | string | null | undefined): boolean {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * The earliest parseable timestamp in `candidates`, falling back to `fallback`.
 *
 * Backfill reads real production rows written across years by a dozen code
 * paths, so a null or a junk date is expected rather than exceptional. It must
 * not write a junk occurred_at into an append-only log and must not throw
 * mid-sweep, which is why every stage's date goes through here.
 */
function parseable(value: string | null | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The row's own best date: its preferred column, else its backup column.
 *
 * This is a PREFERENCE and not `earliest` of the two. A listing's created_at is
 * usually before its listed_at, so taking the earlier of the pair would date
 * every publication to the moment its draft was written and quietly erase the
 * gap between drafting and going live.
 */
function preferred(
  first: string | null | undefined,
  second: string | null | undefined,
): string | null {
  return parseable(first) ?? parseable(second);
}

function earliest(candidates: Array<string | null | undefined>, fallback: string): string {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const ms = Date.parse(c);
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = c;
    }
  }
  return best ?? fallback;
}

// ── the derivation ───────────────────────────────────────────────────────────

/**
 * Which stages this item provably reached, in pipeline order.
 *
 * Pure: no database, no clock, no environment. Everything the sweep needs to
 * decide is an argument, so the whole reward policy for the pipeline is
 * testable as plain data.
 *
 * Each stage pays at most once per item however many listings, photos or comp
 * runs it accumulated — cross-posting one item to four marketplaces is still
 * one item's work.
 */
export function pipelineMarksForItem(
  item: PipelineItem,
  photos: PipelinePhoto[],
  listings: PipelineListing[],
  sales: PipelineSale[],
  repricing: PipelineRepricing[],
): PipelineMark[] {
  const marks: PipelineMark[] = [];
  // Every fallback lands on the item's own creation date: it is the one
  // timestamp guaranteed to exist and to precede everything else about the item.
  const fallback = item.created_at;
  const add = (stage: PipelineStage, occurredAt: string) => marks.push({ stage, occurredAt });

  // Cataloged: someone typed something identifying. Deliberately NOT title —
  // title is NOT NULL, so every row would qualify and the stage would be free.
  if (filled(item.brand) || filled(item.garment_type)) {
    add("item_cataloged", earliest([item.created_at], fallback));
  }

  if (hasMeasurements(item.measurements)) {
    add("item_measured", earliest([item.updated_at], fallback));
  }

  if (photos.length > 0) {
    add("item_photographed", earliest(photos.map((p) => p.created_at), fallback));
  }

  // Comped: either evidence will do, and the earliest one wins.
  if (repricing.length > 0 || filled(item.comped_at)) {
    add(
      "item_comped",
      earliest([...repricing.map((r) => r.created_at), item.comped_at], fallback),
    );
  }

  // Drafted: any listing row at all. Listed: a listing that really went live.
  //
  // listings.listed_at is NOT NULL DEFAULT now(), so it is populated on drafts
  // too and cannot be the published marker. platform_listing_id is the only
  // column that means the marketplace accepted it.
  if (listings.length > 0) {
    add("item_drafted", earliest(listings.map((l) => l.created_at), fallback));

    const published = listings.filter((l) => filled(l.platform_listing_id));
    if (published.length > 0) {
      add(
        "item_listed",
        earliest(published.map((l) => preferred(l.listed_at, l.created_at)), fallback),
      );
    }
  }

  const paidSales = sales.filter((s) => hasPrice(s.sale_price));
  if (paidSales.length > 0) {
    add(
      "item_sold",
      earliest(paidSales.map((s) => preferred(s.sold_at, s.sale_date)), fallback),
    );
  }

  return marks;
}

/** The dedupe key for one mark. 00417's UNIQUE index makes this idempotent. */
export function pipelineReferenceId(itemId: string, stage: PipelineStage): string {
  return `${itemId}:${stage}`;
}
