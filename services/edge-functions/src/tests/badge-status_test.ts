// US-1913: the STATUS format of the embeddable badges.
//
// A status badge puts a seller's Grade Integrity tier, level and confirmed-
// accuracy share on somebody else's storefront. Three properties have to hold
// or the badge becomes a claim we cannot stand behind:
//
//   1. Nothing appears that has not been EARNED (AC4). No placeholder, no
//      "0% confirmed", no percentage without a tier under it.
//   2. A tier CHANGE reaches a badge already pasted into a live listing (AC3) —
//      so the status render must not be frozen in the durable asset bucket, and
//      its staleness must be bounded to 24h.
//   3. `?s=embed` keeps meaning exactly what it meant (AC5); the plain/status
//      split rides a separate axis.
//
// The first is a pure function, tested directly. The other two are properties of
// route code, so they are asserted structurally — the same shape the other
// content-public guards use.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const { buildBadgeStatusLine, buildSellerBadgeHtml, buildCertBadgeHtml } = await import(
  "../lib/cert-og-template.ts"
);
const { aggregateClicksByVariant, normalizeBadgeVariant } = await import(
  "../lib/badge-analytics.ts"
);

function readSource(url: URL): string {
  // Normalize at the read: this repo is checked out with CRLF on Windows, and a
  // needle written with "\n" silently fails to match otherwise.
  return Deno.readTextFileSync(url).replace(/\r\n/g, "\n");
}

const ROUTE = readSource(new URL("../routes/content-public.ts", import.meta.url));

// ─── AC4: only what has been earned ────────────────────────────────────────

Deno.test("AC4: a full standing renders tier · level · accuracy", () => {
  assertEquals(
    buildBadgeStatusLine({
      tierLabel: "Trusted Grader",
      accuracyPct: 98,
      level: 12,
      levelTierName: "Curator",
    }),
    "Trusted Grader · Level 12 Curator · 98% confirmed accurate",
  );
});

Deno.test("AC4: no tier ⇒ no accuracy percentage either", () => {
  // A seller below the confirmed-outcome floor has no tier. Printing their raw
  // percentage anyway would route straight around the floor — the number IS the
  // claim the floor exists to withhold.
  assertEquals(
    buildBadgeStatusLine({ tierLabel: null, accuracyPct: 100, level: 4, levelTierName: "Picker" }),
    "Level 4 Picker",
  );
});

Deno.test("AC4: nothing earned ⇒ empty line, so the PLAIN badge renders", () => {
  assertEquals(buildBadgeStatusLine({}), "");
  assertEquals(buildBadgeStatusLine({ tierLabel: "", level: 0, accuracyPct: 0 }), "");
});

Deno.test("AC4: level 0 is the un-earned rung and never renders", () => {
  const line = buildBadgeStatusLine({ tierLabel: "Verified Grader", accuracyPct: 92, level: 0 });
  assertEquals(line, "Verified Grader · 92% confirmed accurate");
  assert(!line.includes("Level"));
});

Deno.test("AC4: a percentage is clamped and rounded, never invented", () => {
  assertEquals(
    buildBadgeStatusLine({ tierLabel: "Elite Grader", accuracyPct: 99.6 }),
    "Elite Grader · 100% confirmed accurate",
  );
  assertEquals(
    buildBadgeStatusLine({ tierLabel: "Elite Grader", accuracyPct: 140 }),
    "Elite Grader · 100% confirmed accurate",
  );
  // A non-numeric percentage is dropped rather than rendered as NaN%.
  assertEquals(
    buildBadgeStatusLine({ tierLabel: "Elite Grader", accuracyPct: Number.NaN }),
    "Elite Grader",
  );
});

Deno.test("an empty status line leaves both badge templates byte-identical", () => {
  // The status format must be strictly additive: a seller who turns it on before
  // earning anything sees exactly the badge they already had.
  const sellerArgs = {
    width: 700,
    height: 180,
    displayName: "Jane",
    totalGraded: 12,
    totalIsCapped: false,
    averageGrade: 8.4,
  };
  assertEquals(
    buildSellerBadgeHtml({ ...sellerArgs, statusLine: "" }),
    buildSellerBadgeHtml(sellerArgs),
  );
  const certArgs = { score: 8.5, gradeTier: "Excellent", title: "Denim jacket" };
  assertEquals(
    buildCertBadgeHtml({ ...certArgs, statusLine: null }),
    buildCertBadgeHtml(certArgs),
  );
});

Deno.test("a status line reaches both rendered badges", () => {
  const line = "Trusted Grader · Level 12 Curator · 98% confirmed accurate";
  assert(
    buildSellerBadgeHtml({
      width: 700,
      height: 180,
      displayName: "Jane",
      totalGraded: 12,
      totalIsCapped: false,
      averageGrade: 8.4,
      statusLine: line,
    }).includes("98% confirmed accurate"),
  );
  assert(
    buildCertBadgeHtml({ score: 8.5, gradeTier: "Excellent", statusLine: line })
      .includes("98% confirmed accurate"),
  );
});

// ─── AC3: a pasted badge tracks the current tier ───────────────────────────

Deno.test("AC3: the status badge is exempt from the durable asset bucket", () => {
  // A stored cert asset is only invalidated on RE-GRADE. A standing moves for
  // reasons that have nothing to do with the grade, so a stored status badge
  // would freeze a tier until the item was graded again — i.e. potentially
  // forever, and only fixable by the seller re-pasting their HTML.
  assert(
    ROUTE.includes("if (!wantsStatus) {\n      const { data: cached } = await supabaseAdmin"),
    "the status badge reads the stored cert asset, so it can serve a frozen tier",
  );
  assert(
    ROUTE.includes("if (!wantsStatus) {\n      await supabaseAdmin.storage"),
    "the status badge is written into the durable bucket, freezing the tier it drew",
  );
});

Deno.test("AC3: the status cache has no stale-while-revalidate window", () => {
  // The plain badges carry stale-while-revalidate=604800, which lets a CDN serve
  // a WEEK-old copy. Right for a grade (it never changes), wrong for a standing.
  const decl = ROUTE.slice(ROUTE.indexOf("const BADGE_STATUS_CACHE ="));
  const value = decl.slice(0, decl.indexOf("\n"));
  assert(value.includes("max-age=86400"), "the status badge cache is not bounded to 24h");
  assert(
    !value.includes("stale-while-revalidate"),
    "the status badge may be served stale beyond the 24h bound",
  );
});

Deno.test("AC3: both badge routes serve the bounded header for a status render", () => {
  const uses = ROUTE.match(/wantsStatus \? BADGE_STATUS_CACHE : CERT_IMG_CACHE/g) ?? [];
  assertEquals(
    uses.length,
    2,
    "one of the cert / seller badge routes still serves the 7-day SWR header for a status render",
  );
});

// ─── AC5: the funnel axis ──────────────────────────────────────────────────

Deno.test("AC5: an unknown or absent variant reads as plain", () => {
  // Every click recorded before US-1913 has no variant, and "plain" is the
  // truthful reading: there was no other badge format to be.
  assertEquals(normalizeBadgeVariant(undefined), "plain");
  assertEquals(normalizeBadgeVariant(null), "plain");
  assertEquals(normalizeBadgeVariant("STATUS"), "plain");
  assertEquals(normalizeBadgeVariant("status"), "status");
});

Deno.test("AC5: clicks split by variant without touching the source split", () => {
  const rows = [
    { source: "embed", badge_variant: "status" },
    { source: "embed", badge_variant: "plain" },
    { source: "embed", badge_variant: null },
    { source: "qr" },
  ];
  assertEquals(aggregateClicksByVariant(rows), { plain: 3, status: 1 });
});

Deno.test("AC5: the ?s= source allow-list is unchanged by the variant split", async () => {
  // The whole point of a second column is that `embed` still means "an
  // off-platform badge sent them" for both formats. A `status`-flavoured source
  // would fork the funnel and retroactively redefine every historical row.
  const { BADGE_CLICK_SOURCES } = await import("../lib/badge-analytics.ts");
  assertEquals(
    [...BADGE_CLICK_SOURCES].sort(),
    ["badge", "buyer", "embed", "qr", "share"],
  );
});
