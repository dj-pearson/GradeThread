// US-3112: this suite reaches src/lib/supabase.ts through its static imports,
// so it must seed the env before that module evaluates.
import "./_env.ts";

// US-3315: what `sales.sold_at` is allowed to contain, and who may put it there.
//
// -- THE RULE THIS PINS ------------------------------------------------------
//
// `sales.sold_at` is declared `timestamptz`, and it holds two different kinds
// of value on purpose:
//
//   a MARKETPLACE INSTANT  the moment the platform said the order was placed,
//                          stored to the second (eBay, Etsy, Shopify, Depop);
//   a UTC-ANCHORED DAY     a calendar day with no time attached, widened by
//                          Postgres to 00:00:00+00 (the manual sale dialog,
//                          the CSV import, the iOS recorder, and the browser
//                          extension's Sold-page scrape).
//
// Measured on the local stack 2026-09-11: PostgREST POSTs `"2026-09-11"` and
// Postgres returns `2026-09-11T00:00:00+00:00`; POSTs `"2026-09-11T21:37:04Z"`
// and gets that instant back unchanged. The widening uses the SESSION time
// zone, and every role here runs at UTC, which is what makes the anchor UTC
// rather than an accident of the seller's clock.
//
// The rule, then: **no writer may synthesise a time of day it was not given.**
// A day is stored as a day and reads back as 00:00:00Z; an instant is stored
// verbatim. A `sold_at` built from a date plus an invented hour would be worse
// than midnight, because midnight is recognisable and an invented hour is not.
//
// -- WHAT DRIFTED LAST TIME, AND WHY THIS EXISTS -----------------------------
//
// `sale_date` carries the same mixture and nothing said so, which is how
// US-3231, US-3302 and US-3306 each shipped a month-bucket, an export range and
// a filter that read a UTC anchor on the device calendar. The declared type and
// the actual content drifted apart because nothing held them together. This is
// that holder for `sold_at`.
//
// -- WHAT THIS SUITE PROVES AND WHAT IT DOES NOT -----------------------------
//
// The two producers that are pure functions are CALLED, not scanned: a scan
// pins the spelling of a rule and never its answer (see the repo's
// guards-that-do-not-guard note, mode 0). Everything else is a site census,
// and the census derives its corpus from a TREE WALK rather than a list of
// filenames, because a hand-written scope is a second thing that can be wrong
// and its wrongness reads exactly like a clean codebase (mode 9).
//
// It does NOT prove that a value reaching a writer is the right moment. It
// proves that the set of writers is known, that each one's provenance is
// written down, and that a new one cannot appear unnoticed.

import { assert, assertEquals } from "@std/assert";
import { normalizeImportRows } from "../lib/inventory-import.ts";
import { planSaleEffects } from "../lib/marketplace-observations.ts";

// -- behaviour: the two pure producers ---------------------------------------

Deno.test("US-3315: the CSV importer hands sold_at a calendar day, never an invented instant", () => {
  const rows = normalizeImportRows([
    { title: "Carhartt jacket", sale: { sale_price: 25, sold_at: "2026-09-11" } },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(
    rows[0]?.sale?.sold_at,
    "2026-09-11",
    "the importer must pass the seller's day through untouched; anything it " +
      "appended would be a time of day nobody supplied",
  );
});

Deno.test("US-3315: the CSV importer refuses a value carrying a time of day rather than truncating it", () => {
  const rows = normalizeImportRows([
    { title: "Carhartt jacket", sale: { sale_price: 25, sold_at: "2026-09-11T21:37:04Z" } },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(
    rows[0]?.sale?.sold_at,
    null,
    "isoDate() matches ^YYYY-MM-DD$ exactly, so an instant is dropped whole. " +
      "That is the honest half. The cost is real and is named in the vault " +
      "note: a spreadsheet that DOES carry the moment loses it here.",
  );

  // And the cost, pinned so it is a decision rather than a surprise: with no
  // price alongside it, dropping the timestamp drops the entire sale row.
  const priceless = normalizeImportRows([
    { title: "Carhartt jacket", sale: { sold_at: "2026-09-11T21:37:04Z" } },
  ]);
  assertEquals(priceless[0]?.sale, null);
});

Deno.test("US-3315: the extension sync passes soldAt through and derives the day from its UTC calendar", () => {
  // What observe.js produces for a Sold page printing "Today" or "Aug 18":
  // Date.UTC(y, m, d) -- a day wearing an instant's clothes, already anchored.
  const anchored = planSaleEffects([
    {
      listingId: "11111111-1111-1111-1111-111111111111",
      itemId: "22222222-2222-2222-2222-222222222222",
      soldPriceCents: 2500,
      soldAt: "2026-09-11T00:00:00.000Z",
      dedupeKey: "poshmark:order:abc",
    },
  ]);
  assertEquals(anchored[0]?.soldAt, "2026-09-11T00:00:00.000Z");
  assertEquals(anchored[0]?.saleDate, "2026-09-11");

  // And a page that DID print a real timestamp keeps it to the second.
  const instant = planSaleEffects([
    {
      listingId: "11111111-1111-1111-1111-111111111111",
      itemId: "22222222-2222-2222-2222-222222222222",
      soldPriceCents: 2500,
      soldAt: "2026-09-11T21:37:04.000Z",
      dedupeKey: "poshmark:order:abc",
    },
  ]);
  assertEquals(
    instant[0]?.soldAt,
    "2026-09-11T21:37:04.000Z",
    "the sync writer must not round, floor or re-anchor an instant it was given",
  );
  assertEquals(
    instant[0]?.saleDate,
    "2026-09-11",
    "sale_date is the UTC day of sold_at, taken as its first ten characters",
  );
});

// -- the census --------------------------------------------------------------

/** Repo root: src/tests/ -> src/ -> edge-functions/ -> services/ -> root. */
const REPO_ROOT = new URL("../../../../", import.meta.url);

/** Never walked: vendored, generated, or not source anybody here wrote. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-ext",
  "coverage",
  "build",
  ".vite",
  "test-results",
  "vendor",
  ".gradle",
  ".idea",
  "Pods",
  "DerivedData",
  "target",
  "out",
  ".next",
  "tasks",
  "temp_prd",
]);

/**
 * Where source lives. Not a list of files to check -- every file under each of
 * these is walked. The distinction is the whole point: a list of FILES goes
 * stale silently, a list of ROOTS goes stale only when a whole new client
 * appears, which is not something anybody adds by accident.
 */
const SOURCE_ROOTS = [
  "src",
  "services/edge-functions/src",
  "ios",
  "android",
  "extension",
  "extension-unified",
  "extension-condition",
  "functions",
  "sdk",
  "scripts",
  "remotion",
] as const;

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".mjs", ".cjs", ".js", ".swift", ".kt"];

/**
 * Tests name columns as fixtures and assertions; that is their job, and this
 * file is one of them, so excluding tests also excludes SELF. Writing about a
 * guard is writing input to it (guards-that-do-not-guard, mode 7) and the
 * registry below quotes every line it is asserting on.
 */
function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests|test)\//.test(path) ||
    /(_test|\.test|\.spec)\.[a-z]+$/.test(path) ||
    /Tests\.swift$/.test(path);
}

function walkSource(dir: URL, prefix: string, out: string[]): void {
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSource(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`, out);
    } else if (
      entry.isFile && SOURCE_EXTENSIONS.some((x) => entry.name.endsWith(x))
    ) {
      out.push(`${prefix}${entry.name}`);
    }
  }
}

const ALL_SOURCE: readonly string[] = (() => {
  const out: string[] = [];
  for (const root of SOURCE_ROOTS) {
    walkSource(new URL(`${root}/`, REPO_ROOT), `${root}/`, out);
  }
  return out;
})();

const SCANNED: readonly string[] = ALL_SOURCE.filter((p) => !isTestPath(p));

/**
 * Comments removed, LINE COUNT PRESERVED.
 *
 * Preserving the count is not cosmetic: the failure message is a `file:line`
 * the reader is meant to open, and collapsing a block comment to one newline
 * makes every number after it a lie. Blocks are stripped as blocks first,
 * because stripping by line prefix leaves the interior of a block comment
 * behind, and the interior is exactly where a column name gets quoted in prose.
 */
function codeLines(src: string): string[] {
  return src
    .replace(
      /\/\*[\s\S]*?\*\//g,
      (m) => "\n".repeat((m.match(/\n/g) ?? []).length),
    )
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    });
}

/** An assignment or declaration of the column, as opposed to a select or filter. */
const SOLD_AT_ASSIGNMENT = /\bsold_at\b\s*[:=]/;

interface FoundSite {
  file: string;
  line: number;
  text: string;
}

function findSites(files: readonly string[]): FoundSite[] {
  const out: FoundSite[] = [];
  for (const file of files) {
    const src = Deno.readTextFileSync(new URL(file, REPO_ROOT));
    if (!src.includes("sold_at")) continue;
    codeLines(src).forEach((line, i) => {
      if (SOLD_AT_ASSIGNMENT.test(line)) {
        out.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
  return out;
}

const FOUND: readonly FoundSite[] = findSites(SCANNED);

// -- the registry ------------------------------------------------------------

type SiteKind =
  /** Assigns the column on a row going into public.sales. */
  | "sales_write"
  /** Produces the value a sales_write later hands over. */
  | "sales_write_source"
  /** Assigns a column of the same name on a DIFFERENT table. */
  | "other_table_write"
  /** Reads the column, or maps it onto an outbound payload. */
  | "read"
  /** A type declaration or a schema shape, not a value. */
  | "shape";

type Provenance =
  /** The marketplace reported the moment; stored verbatim, to the second. */
  | "marketplace_instant"
  /** As above, but the connector stamps its own clock when nothing was reported. */
  | "marketplace_instant_or_import_clock"
  /** A calendar day with no time; Postgres widens it to 00:00:00+00. */
  | "utc_anchored_day"
  /** Scraped from a Sold page: an instant only if the page printed one. */
  | "scraped_day_or_instant";

interface Site {
  text: string;
  kind: SiteKind;
  provenance?: Provenance;
  table?: string;
  why?: string;
}

/**
 * Every place in non-test source that assigns something called `sold_at`,
 * in file order.
 *
 * Keyed by ORDINAL within the file rather than by line number, so an edit
 * elsewhere in the file does not move it, and adding or removing a `sold_at`
 * line does -- which is when this is supposed to fire.
 */
const REGISTRY: Record<string, readonly Site[]> = {
  // US-3367: the Record Sale dialog no longer writes sales itself; it posts to
  // POST /api/flipdesk/sales/record and lib/record-sale.ts is the writer.
  "services/edge-functions/src/lib/record-sale.ts": [
    {
      text: "sold_at: saleDate,",
      kind: "sales_write",
      provenance: "utc_anchored_day",
      why:
        "the dialog's <input type=\"date\"> (seeded with todayLocalDate()), or " +
        "today's UTC date when the seller left it blank. There is no instant " +
        "on that screen to supply and stamping Date.now() would record when " +
        "the seller typed, not when the item sold.",
    },
  ],
  "src/hooks/use-ebay.ts": [{ text: "sold_at: string | null;", kind: "shape" }],
  "src/hooks/use-ship-queue.ts": [{ text: "sold_at: string | null;", kind: "shape" }],
  "src/hooks/use-sold-sync.ts": [
    {
      text: "sold_at: string | null;",
      kind: "shape",
      table: "marketplace_sync_reviews",
    },
  ],
  "src/pages/admin/marketplace-ops.tsx": [
    {
      text: "sold_at: string | null;",
      kind: "shape",
      table: "flipdesk_ebay_orphan_sales",
    },
  ],
  "src/pages/flipdesk/import.tsx": [
    {
      text: "sold_at: saleDate,",
      kind: "sales_write_source",
      provenance: "utc_anchored_day",
      why:
        "parseDate() in src/lib/import-mapping.ts returns a bare YYYY-MM-DD. " +
        "POSTed to /api/flipdesk/import, which writes it.",
    },
  ],
  "src/types/database.ts": [
    { text: "sold_at: string | null;", kind: "shape" },
    { text: "sold_at: string | null;", kind: "shape" },
  ],
  "services/edge-functions/src/lib/api-items.ts": [
    { text: "sold_at: string | null;", kind: "shape" },
    {
      text: "sold_at: (row.sale_date as string | null) ?? null,",
      kind: "read",
      why:
        "the public API's sold_at field is served from items_full.sale_date, " +
        "which is COALESCE(sales.sold_at, sales.sale_date). openapi-spec.ts " +
        "declares it date-time, so the API promises an instant too.",
    },
  ],
  "services/edge-functions/src/lib/api-listings.ts": [
    { text: "sold_at: string | null;", kind: "shape" },
    { text: "sold_at: (row.sale_date as string | null) ?? null,", kind: "read" },
  ],
  "services/edge-functions/src/lib/consignor-payout.ts": [
    {
      text: "sold_at: string | null;",
      kind: "shape",
      why:
        "read at :273 as the base of the consignor hold window. For a manual " +
        "sale that base is 00:00Z, so a hold lapses up to a day early.",
    },
  ],
  "services/edge-functions/src/lib/depop-orders.ts": [
    {
      text: "sold_at: soldAt,",
      kind: "sales_write",
      provenance: "marketplace_instant_or_import_clock",
      why:
        "depop-api.ts takes created_at || purchased_at || date and passes it " +
        "through with no shape check; :114 falls back to new Date() when the " +
        "order carried none.",
    },
  ],
  "services/edge-functions/src/lib/etsy-orders.ts": [
    {
      text: "sold_at: soldAt,",
      kind: "sales_write",
      provenance: "marketplace_instant_or_import_clock",
      why: "created_timestamp is epoch seconds; tsToIso turns it into a full instant.",
    },
  ],
  "services/edge-functions/src/lib/inventory-import.ts": [
    {
      text: "sold_at: isoDate(raw.sold_at),",
      kind: "sales_write_source",
      provenance: "utc_anchored_day",
      why: "isoDate matches ^YYYY-MM-DD$ exactly, so this is always a bare day or null.",
    },
    { text: "if (out.sale_price === null && out.sold_at === null) return null;", kind: "read" },
  ],
  "services/edge-functions/src/lib/listing-acceptance.ts": [
    {
      text: ".update({ sold: true, sold_at: new Date().toISOString() })",
      kind: "other_table_write",
      table: "listing_prompt_acceptance",
      why:
        "a different column on a different table: when the sell-through flag " +
        "was flipped, not when the item sold. A real instant of a real event.",
    },
  ],
  "services/edge-functions/src/lib/openapi-spec.ts": [
    {
      text: 'sold_at: { type: "string", format: "date-time", nullable: true },',
      kind: "shape",
      why: "the public API declares an instant. See the vault note before narrowing this.",
    },
  ],
  "services/edge-functions/src/lib/orphan-sale-match.ts": [
    { text: "sold_at: string | null;", kind: "shape" },
    {
      text: "sold_at: orphan.sold_at,",
      kind: "sales_write",
      provenance: "marketplace_instant",
      why:
        "copied verbatim from flipdesk_ebay_orphan_sales.sold_at, which is " +
        "eBay's order.creationDate.",
    },
  ],
  "services/edge-functions/src/lib/rewards-pipeline.ts": [
    {
      text: "sold_at: string | null;",
      kind: "shape",
      why: "read at :220 as the timestamp of the item_sold XP event.",
    },
  ],
  "services/edge-functions/src/lib/shopify-orders.ts": [
    {
      text: "sold_at: soldAt,",
      kind: "sales_write",
      provenance: "marketplace_instant_or_import_clock",
      why: "processed_at, else created_at; both ISO 8601 instants.",
    },
  ],
  "services/edge-functions/src/routes/flipdesk-ebay.ts": [
    { text: "sold_at: string | null;", kind: "shape" },
    {
      text: "sold_at: order.creationDate,",
      kind: "other_table_write",
      table: "flipdesk_ebay_orphan_sales",
    },
    {
      text: "sold_at: order.creationDate ?? null,",
      kind: "sales_write",
      provenance: "marketplace_instant",
      why:
        "the Sell Fulfillment order's creationDate, an ISO 8601 instant. This " +
        "is the writer that makes the column worth keeping as a timestamptz: " +
        "resolveShipBy adds handling_days to it.",
    },
  ],
  "services/edge-functions/src/routes/flipdesk-equity.ts": [
    {
      text: "{ inventory_item_id: string; sale_date: string | null; sold_at: string | null }",
      kind: "shape",
    },
  ],
  "services/edge-functions/src/routes/flipdesk-forecast.ts": [
    { text: "sold_at: string | null;", kind: "shape" },
  ],
  "services/edge-functions/src/routes/flipdesk-import.ts": [
    {
      text: "sold_at: row.sale.sold_at ?? null,",
      kind: "sales_write",
      provenance: "utc_anchored_day",
      why: "normalizeImportRows already reduced this to a bare day or null.",
    },
  ],
  "services/edge-functions/src/routes/flipdesk-sync.ts": [
    {
      text: "sold_at: r.soldAt,",
      kind: "other_table_write",
      table: "marketplace_sync_reviews",
    },
    {
      text: "sold_at: u.soldAt,",
      kind: "other_table_write",
      table: "marketplace_sync_reviews",
    },
    {
      text: "sold_at: sale.soldAt,",
      kind: "other_table_write",
      table: "marketplace_sync_observations",
    },
    {
      text: "sold_at: sale.soldAt,",
      kind: "sales_write",
      provenance: "scraped_day_or_instant",
      why:
        "Poshmark, Mercari, Grailed, Vinted and Facebook come through the " +
        "extension's Sold-page scrape. parseSoldAt in " +
        "extension-unified/sync/observe.js turns 'Today', 'N days ago' and " +
        "'Aug 18' into Date.UTC(y, m, d) -- a UTC-anchored day in instant " +
        "clothing. Those pages do not print a clock time, so this is the " +
        "day half in practice.",
    },
  ],
  "ios/GradeThread/Sales/SaleRecorder.swift": [
    { text: "let sold_at: String", kind: "shape" },
    {
      text: "sold_at: day",
      kind: "sales_write",
      provenance: "utc_anchored_day",
      why:
        "dayString(values.saleDate) is a bare YYYY-MM-DD, and since US-3310 " +
        "it delegates to MoneyDate rather than owning a second copy of the rule.",
    },
  ],
};

/** The nine sites that assign the column on a public.sales row. */
const SALES_WRITE_FILES = [
  "services/edge-functions/src/lib/record-sale.ts",
  "services/edge-functions/src/lib/depop-orders.ts",
  "services/edge-functions/src/lib/etsy-orders.ts",
  "services/edge-functions/src/lib/orphan-sale-match.ts",
  "services/edge-functions/src/lib/shopify-orders.ts",
  "services/edge-functions/src/routes/flipdesk-ebay.ts",
  "services/edge-functions/src/routes/flipdesk-import.ts",
  "services/edge-functions/src/routes/flipdesk-sync.ts",
  "ios/GradeThread/Sales/SaleRecorder.swift",
] as const;

// -- corpus controls ---------------------------------------------------------

Deno.test("US-3315: the census walks the tree, and still contains every writer", () => {
  // A floor, so an exclusion that quietly swallowed src/lib cannot pass by
  // finding nothing. 3,766 non-test source files when this was written.
  assert(
    SCANNED.length > 3000,
    `the scan walked only ${SCANNED.length} files; something in SKIP_DIRS or ` +
      `SOURCE_ROOTS is eating the corpus`,
  );

  // And specifically: the files that DO write the column are in the set. The
  // two exclusions fail in opposite directions -- a broken test exclusion makes
  // this suite loudly red, an exclusion that swallows src/lib makes it quietly
  // green -- so the quiet direction gets its own assertion.
  for (const file of SALES_WRITE_FILES) {
    assert(
      SCANNED.includes(file),
      `${file} writes sales.sold_at and is not in the scanned set`,
    );
  }

  // Self-exclusion: this file quotes every line it asserts on.
  assert(
    !SCANNED.some((p) => p.endsWith("sold-at-provenance_test.ts")),
    "this suite is in its own corpus, so its registry would satisfy itself",
  );
});

Deno.test("US-3315: the matcher fires on writes and not on prose", () => {
  // A positive control on the detector, so a regex that stops matching cannot
  // read as a clean codebase.
  const fixture = [
    "const payload = {",
    "  sold_at: order.creationDate,",
    "};",
    '  .update({ listing_status: "sold", sold_at: sale.soldAt })',
    "  let sold_at: String",
    '  .select("sold_at, sale_date")',
    '  .gte("sold_at", windowStart)',
    "// sold_at: this line is prose about the column",
    "/* sold_at: so is this */",
  ].join("\n");
  const matched = codeLines(fixture).filter((l) => SOLD_AT_ASSIGNMENT.test(l));
  assertEquals(
    matched.length,
    3,
    `expected the object write, the update and the declaration; got ${
      JSON.stringify(matched)
    }`,
  );

  // Line numbers survive a block comment, or every failure message is a lie.
  const numbered = codeLines("/* a\nb\nc */\nsold_at: x,");
  assertEquals(numbered.length, 4);
  assertEquals(numbered[3]?.trim(), "sold_at: x,");
});

// -- the census matches the registry, both directions ------------------------

Deno.test("US-3315: every sold_at assignment in the tree is registered", () => {
  const byFile = new Map<string, FoundSite[]>();
  for (const site of FOUND) {
    const list = byFile.get(site.file) ?? [];
    list.push(site);
    byFile.set(site.file, list);
  }

  for (const [file, sites] of byFile) {
    const declared = REGISTRY[file];
    assert(
      declared !== undefined,
      `${file}:${sites[0]?.line} assigns sold_at and no entry in REGISTRY ` +
        `covers it: ${JSON.stringify(sites[0]?.text)}. Classify it -- a new ` +
        `writer of sales.sold_at must state whether it has a marketplace ` +
        `instant or only a calendar day, and must not invent a time of day.`,
    );
    assertEquals(
      sites.length,
      declared.length,
      `${file} has ${sites.length} sold_at assignments and REGISTRY declares ` +
        `${declared.length}. Lines: ${
          sites.map((s) => `${s.line} ${JSON.stringify(s.text)}`).join(", ")
        }`,
    );
    sites.forEach((site, i) => {
      assertEquals(
        site.text,
        declared[i]?.text,
        `${file}:${site.line} changed. REGISTRY expected ${
          JSON.stringify(declared[i]?.text)
        }. Re-read what the new expression hands the column before updating ` +
          `this -- the whole point is that the value cannot change quietly.`,
      );
    });
  }
});

Deno.test("US-3315: no registry entry has gone stale", () => {
  const seen = new Set(FOUND.map((s) => s.file));
  for (const file of Object.keys(REGISTRY)) {
    assert(
      seen.has(file),
      `REGISTRY names ${file}, which no longer assigns sold_at. Delete the ` +
        `entry -- a registry that can only grow stops being read.`,
    );
  }
});

// -- the rule itself ---------------------------------------------------------

Deno.test("US-3315: every sales writer declares a provenance, and the nine are these nine", () => {
  const writers: Array<[string, Site]> = [];
  for (const [file, sites] of Object.entries(REGISTRY)) {
    for (const site of sites) {
      if (site.kind === "sales_write") writers.push([file, site]);
    }
  }

  assertEquals(
    [...new Set(writers.map(([f]) => f))].sort(),
    [...SALES_WRITE_FILES].sort(),
    "the set of files writing sales.sold_at changed",
  );
  assertEquals(
    writers.length,
    9,
    "nine sites assign sales.sold_at; flipdesk-ebay.ts and flipdesk-sync.ts " +
      "each also write a same-named column on another table",
  );

  for (const [file, site] of writers) {
    assert(
      site.provenance !== undefined,
      `${file} writes sales.sold_at without saying where the value comes from`,
    );
  }

  // Five of the nine can reach a real instant. Four cannot, and naming them is
  // the point: a date picker, a spreadsheet cell, an iOS day and a scraped
  // "3 days ago" have no moment to supply, so they store the day honestly.
  const dayOnly = writers.filter(([, s]) =>
    s.provenance === "utc_anchored_day" || s.provenance === "scraped_day_or_instant"
  );
  assertEquals(
    dayOnly.map(([f]) => f).sort(),
    [
      "ios/GradeThread/Sales/SaleRecorder.swift",
      "services/edge-functions/src/lib/record-sale.ts",
      "services/edge-functions/src/routes/flipdesk-import.ts",
      "services/edge-functions/src/routes/flipdesk-sync.ts",
    ],
    "a writer moved between having a marketplace instant and not having one",
  );
});

Deno.test("US-3315: no sales writer stamps its own clock at the write site", () => {
  for (const [file, sites] of Object.entries(REGISTRY)) {
    for (const site of sites) {
      if (site.kind !== "sales_write" && site.kind !== "sales_write_source") continue;
      assert(
        !/new Date\(|Date\.now\(|Date\(\)/.test(site.text),
        `${file} builds sales.sold_at from the machine's clock: ` +
          `${site.text}. The moment a row is written is not the moment an ` +
          `item sold. Where the marketplace reported nothing, the three API ` +
          `connectors fall back to now() on a separate line and say so in ` +
          `their provenance; a write site that does it inline is the ` +
          `regression this guards.`,
      );
    }
  }
});

Deno.test("US-3315: Android writes no sold_at, and that is a fact rather than an oversight", () => {
  const android = FOUND.filter((s) => s.file.startsWith("android/"));
  assertEquals(
    android,
    [],
    "Android gained a sold_at assignment. It has no record-sale path today -- " +
      "SyncService decodes the column and MutationReplayer only patches " +
      "shipped_at -- so a new one needs a registry entry and a provenance.",
  );
});
