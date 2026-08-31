// US-9030: what the public RN lookup answers, and what it refuses to.
//
// Someone reads a number off a care label and types it. This turns that string
// into either a company with its provenance, or an honest blank — and the blank
// is the common case for a long time, because the registry fills at the speed
// of the seed run rather than the speed of wanting it full.
//
// ── THE THREE RULES THIS FILE EXISTS TO HOLD ───────────────────────────────
//
// 1. AN RN NAMES THE COMPANY, NEVER THE BRAND, AND NEVER AUTHENTICITY.
//    lib/registered-numbers.ts has encoded that since US-2211 and this surface
//    must not soften it: URBN's RN 66170 covers Urban Outfitters,
//    Anthropologie AND Free People, so an answer is "one of these", and a
//    counterfeit prints a real RN too. `brands` is a list for that reason. It
//    is never reduced to a winner.
//
// 2. INDEXABLE ONLY WITH A RESOLVED COMPANY. Computed HERE, not in the
//    renderer and not in the sitemap query, so the page and
//    sitemap-rn.xml cannot disagree about which URLs exist. A sitemapped URL
//    that renders noindex is the contradiction that gets a whole section
//    ignored (US-2748 learned this on style codes).
//
// 3. "NO REFERENCE" IS NOT A NEGATIVE SIGNAL. A number we cannot resolve means
//    we have no record, never that the number is wrong. Nothing downstream may
//    render it as invalid, fake or suspicious.
//
// Pure shaping: the caller does the reads, so every rule above is testable
// without a database.

import { parseRegisteredNumber, registeredNumberKey } from "./registered-numbers.ts";

/** A resolved registrant, as registered_number_registry holds it (00502). */
export interface RegistryRowForPublic {
  registry_key: string;
  kind: "RN" | "CA";
  digits: string;
  company_name: string | null;
  brand_keys?: string[] | null;
  source_url?: string | null;
  notes?: string | null;
}

export interface PublicRegisteredNumber {
  /** Canonical comparable form, e.g. "RN:56323". */
  key: string;
  kind: "RN" | "CA";
  /** The canonical digits. This is the URL segment. */
  digits: string;
  /** Exactly what the visitor typed, echoed so the page can say so. */
  requested: string;
  /** False when `requested` is a different spelling of `digits` — the route
   *  301s rather than serving one answer at several URLs. */
  canonical: boolean;
  /** The registrant's legal name, or null when nothing has answered yet. */
  companyName: string | null;
  /** Display names of the brands this registrant labels. Often empty, and
   *  often longer than one. Never collapsed to a single winner. */
  brands: string[];
  /** Product lines as the FTC records them. Display only. */
  productLines: string[];
  /** The FTC record this came from, so a reader can check us. */
  sourceUrl: string | null;
  /** How many real garment tags we have read this number off. Null when we
   *  have never seen it, which is different from having seen it zero times. */
  sightings: number | null;
  /** Indexable ONLY with a resolved company. See rule 2. */
  indexable: boolean;
}

/** Product lines are stashed in `notes` by the seeder, as one prefixed line. */
const NOTES_PREFIX = "FTC product lines:";

export function productLinesFromNotes(notes: string | null | undefined): string[] {
  if (!notes || !notes.startsWith(NOTES_PREFIX)) return [];
  return notes
    .slice(NOTES_PREFIX.length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Shape the answer. Pure: the caller does the reads.
 *
 * `registry` is null when no row answers the number, which is the honest blank
 * rather than a guess.
 */
export function publicRegisteredNumber(args: {
  requested: string;
  registry: RegistryRowForPublic | null;
  /** Display names for registry.brand_keys, resolved by the caller. */
  brandNames?: string[];
  /** registered_number_sightings.sighting_count, or null if no row. */
  sightings: number | null;
}): PublicRegisteredNumber | null {
  const { requested, registry, brandNames, sightings } = args;

  const parsed = parseRegisteredNumber(requested);
  // Not a registry number at all. The route turns this into a 400, and the
  // page into a 404 — this URL does not name anything and never will.
  if (!parsed) return null;

  const digits = registry?.digits ?? parsed.digits;
  const kind = registry?.kind ?? parsed.kind;
  const key = registryKeyFor(kind, digits);
  const companyName = registry?.company_name?.trim() || null;

  return {
    key,
    kind,
    digits,
    requested,
    // "RN56323", "rn 56323", "056323" and "RN# 56323" are all the same garment
    // tag read aloud differently. One URL per number.
    //
    // Compared WITHOUT trimming on purpose: "%20" padding round a number is a
    // second URL serving one answer, so it earns a 301 like every other
    // spelling rather than being quietly accepted as canonical.
    canonical: requested === digits,
    companyName,
    brands: companyName ? (brandNames ?? []).filter(Boolean) : [],
    productLines: companyName ? productLinesFromNotes(registry?.notes) : [],
    sourceUrl: companyName ? (registry?.source_url ?? null) : null,
    sightings,
    // A number we cannot name has nothing a search result could usefully show,
    // and thousands of those is thin content that costs the whole domain rather
    // than just this section.
    indexable: companyName !== null,
  };
}

function registryKeyFor(kind: "RN" | "CA", digits: string): string {
  return registeredNumberKey({ kind, digits });
}

/** A row as the sitemap query selects it. */
export interface SitemapNumberRow {
  registry_key: string;
  kind?: string | null;
  digits: string;
  company_name: string | null;
  updated_at?: string | null;
}

/**
 * The numbers that belong in sitemap-rn.xml.
 *
 * Exported and pure so it can be driven by the SAME fixtures as
 * publicRegisteredNumber, which is the only way to know the two agree.
 *
 * RN only. A CA number still renders a page when asked for, but there is no
 * measured demand for the Canadian register, and a sitemap is a claim that
 * these URLs are worth crawling.
 */
export function indexableNumbers(
  rows: readonly SitemapNumberRow[],
): Array<{ digits: string; updated_at: string | null }> {
  const newest = new Map<string, string | null>();
  for (const row of rows) {
    // The SAME condition publicRegisteredNumber applies: a resolved company.
    if (!(row.company_name ?? "").trim()) continue;
    if (row.kind !== undefined && row.kind !== null && row.kind !== "RN") continue;
    const digits = (row.digits ?? "").trim();
    if (!digits) continue;
    const prior = newest.get(digits);
    const at = row.updated_at ?? null;
    if (prior === undefined || (at !== null && (prior === null || at > prior))) {
      newest.set(digits, at);
    }
  }
  return [...newest.entries()].map(([digits, updated_at]) => ({ digits, updated_at }));
}
