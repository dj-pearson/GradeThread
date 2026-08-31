// US-9029: read the FTC public RN search, signed out.
//
// ── WHY THIS IS ALLOWED, recorded because it will be questioned ─────────────
//
// The Rules of Behavior published at rn.ftc.gov govern ACCOUNTS on that system,
// which exists so a business can apply for, update or cancel its OWN RN. That
// system's landing page says a login is needed "only if you wish to update or
// cancel the RN". The SEARCH is a different surface: it lives on ftc.gov, takes
// a query string, and returns server-rendered HTML with no session at all. We
// create no account, hold no credential, and bypass no access control. What we
// owe the registry is politeness, so the seeder paces its calls and every row
// it writes carries the FTC URL it came from.
//
// CORRECTION: migration 00466 records the FTC RN database as "auth-gated" and
// declines to seed RNs on that basis. It is not auth-gated, and that mistake is
// why only six brands in the whole knowledge base carry a registered number.
// The migration is applied and immutable; this comment and
// vault/40-growth/rn-lookup.md are the correction.
//
// ── WHAT AN RN IS, WHICH BOUNDS WHAT THIS CAN ANSWER ───────────────────────
//
// An RN names the COMPANY that made, imported, distributed or sold a textile
// item — never the brand on the tag, and never the item's authenticity. See
// lib/registered-numbers.ts, which already encodes those limits for the
// cross-check, and never let this module's output be presented as more.
//
// Parsing is pure and the fetcher is injectable, so every rule below is tested
// against captured fixtures and the test suite never touches the network.

/** One row of the FTC results table. */
export interface FtcRnRecord {
  /** "RN" (US FTC) or "CA" (Canadian), as the Type column prints it. */
  kind: "RN" | "CA";
  /** Digits only, leading zeros stripped — comparable with registeredNumberKey(). */
  digits: string;
  /** The registrant's legal business name, exactly as the registry holds it. */
  legalName: string;
  /** Zero or more product lines. Absent for most registrants. */
  productLines: string[];
  /** The search URL this row was read from. Stored as the row's provenance. */
  sourceUrl: string;
}

const FTC_SEARCH = "https://www.ftc.gov/rn-database/search";

/** The URL a human would land on for the same query. */
export function ftcSearchUrl(term: string): string {
  return `${FTC_SEARCH}?search=${encodeURIComponent(term)}`;
}

const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<td[^>]*>([\s\S]*?)<\/td>/gi;
// Each product line is its own taxonomy term, rendered as an <h3 class="term-title">.
// Reading them individually rather than splitting the cell's text is what keeps
// "Women's apparel Men's apparel" from becoming one made-up category.
const TERM_RE = /<h3[^>]*class="[^"]*term-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi;

/** Strip tags, decode the handful of entities Drupal emits, collapse space. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a results page into records.
 *
 * Returns an empty list for a no-match page, for markup we do not recognise,
 * and for an empty string. It NEVER throws: the seeder walks about 180 brands
 * in one run, and a single odd page must read as "no match" — which is already
 * the common and correct outcome — rather than ending the run.
 */
export function parseFtcResults(html: string): FtcRnRecord[] {
  const out: FtcRnRecord[] = [];
  if (!html) return out;

  for (const row of html.matchAll(ROW_RE)) {
    const cells = [...row[1].matchAll(CELL_RE)];
    // Type | No. | Legal Business Name | Product Line. A <thead> row has <th>
    // cells and matches nothing here, so it cannot be read as a record.
    if (cells.length < 3) continue;

    const kind = cellText(cells[0][1]).toUpperCase();
    if (kind !== "RN" && kind !== "CA") continue;

    const digits = cellText(cells[1][1]).replace(/\D/g, "").replace(/^0+/, "");
    if (!digits) continue;

    const legalName = cellText(cells[2][1]);
    if (!legalName) continue;

    const productLines = cells[3]
      ? [...cells[3][1].matchAll(TERM_RE)].map((m) => cellText(m[1])).filter(Boolean)
      : [];

    out.push({ kind, digits, legalName, productLines, sourceUrl: "" });
  }
  return out;
}

/** What the seeder should do with one brand's search results. */
export type SeedDecision =
  | { action: "write"; record: FtcRnRecord }
  | { action: "review"; reason: string; candidates: FtcRnRecord[] }
  | { action: "skip"; reason: string };

/**
 * Decide whether a search result may become a registry row.
 *
 * EXACTLY ONE MATCH WRITES. Anything else refuses, and the two refusals mean
 * different things:
 *
 *  - Zero matches is a SKIP and is completely normal. Most brands on a tag are
 *    labelled by a parent company under a name nobody searches for.
 *  - Two or more is a REVIEW, never a guess. "Patagonia" returns both
 *    PATAGONIA INC. and PATAGONIA TRADING CO. (measured 2026-08-31), and there
 *    is nothing in the results page that says which one labels the fleece in
 *    someone's hands. A wrong company name under a page that shows its
 *    provenance is worse than no page at all, because the provenance is the
 *    only reason to trust us over the free mirrors.
 *
 * Pure, so both rules are testable without a database or a request.
 */
export function decideSeedRow(brand: string, results: FtcRnRecord[]): SeedDecision {
  if (results.length === 0) {
    return { action: "skip", reason: `no FTC match for ${JSON.stringify(brand)}` };
  }
  if (results.length > 1) {
    return {
      action: "review",
      reason: `${results.length} FTC matches for ${JSON.stringify(brand)}`,
      candidates: results,
    };
  }
  return { action: "write", record: results[0] };
}

/**
 * One search. The caller does the pacing — this deliberately has no sleep and
 * no retry, so the seeder owns the request rate in one readable place.
 *
 * Throws on a non-200 so a run halts rather than recording thousands of
 * silent "no match" rows the moment the endpoint changes shape or rate-limits.
 */
export async function searchFtc(
  term: string,
  fetcher: typeof fetch = fetch,
): Promise<FtcRnRecord[]> {
  const url = ftcSearchUrl(term);
  const res = await fetcher(url, {
    headers: {
      // Say who we are. A registry that wants to throttle us should be able to.
      "user-agent": "GradeThread RN seeder (support@gradethread.com)",
      "accept": "text/html",
    },
  });
  if (!res.ok) {
    throw new Error(`FTC search returned ${res.status} for ${JSON.stringify(term)}`);
  }
  return parseFtcResults(await res.text()).map((r) => ({ ...r, sourceUrl: url }));
}
