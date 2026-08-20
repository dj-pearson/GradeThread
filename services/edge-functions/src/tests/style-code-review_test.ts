// US-2693: what an admin sees first in the style-code index.
//
// The queue's whole value is the ORDER. A list sorted by brand or by date is a
// list nobody opens twice, so every test here is about which code surfaces
// above which.
import { assert, assertEquals } from "@std/assert";

// style-code-review.ts transitively imports the service-role supabase client at
// load (through style-code-consensus.ts) — dummy env BEFORE the import.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  groupStyleCodeRows,
  keywordsForPromotedStyle,
  orderReviewQueue,
  effectivePromotionSource,
  promotionRefusal,
  reviewItemFor,
  sameName,
  REVIEW_PRIORITY,
} = await import("../lib/style-code-review.ts");

type Row = Parameters<typeof groupStyleCodeRows>[0][number];

function row(over: Partial<Row> = {}): Row {
  return {
    id: "row-1",
    brand_key: "lululemon",
    style_code_norm: "LM7A83S",
    style_code_raw: "LM7A83S",
    name: "Commission Short Relaxed Warpstreme",
    source: "consensus",
    supporting: 6,
    confidence: 0.7,
    evidence_url: null,
    rejected_at: null,
    ...over,
  } as Row;
}

function itemFor(rows: Row[]) {
  const groups = groupStyleCodeRows(rows);
  assertEquals(groups.length, 1, "fixture should describe exactly one code");
  return reviewItemFor(groups[0]!);
}

Deno.test("US-2693: two sources naming a code differently is the top of the queue", () => {
  const item = itemFor([
    row({ id: "a", source: "consensus", name: "Commission Short" }),
    row({ id: "b", source: "seller", name: "Commission Pant", supporting: 1 }),
  ]);
  assert(item.conflicting);
  assertEquals(item.priority, REVIEW_PRIORITY.conflicting);
  // The loser is still shown — picking between them is the point of the screen.
  assertEquals(item.candidates.length, 2);
  assertEquals(item.resolved!.source, "seller");
});

Deno.test("US-2693: the same answer spelled twice is not a conflict", () => {
  const item = itemFor([
    row({ id: "a", source: "consensus", name: "Commission Short" }),
    row({ id: "b", source: "seller", name: "commission short.", supporting: 1 }),
  ]);
  assert(!item.conflicting, "punctuation and case are not disagreement");
  assert(sameName("Commission Short", "COMMISSION  short!"));
  assert(!sameName("Commission Short", "Commission Pant"));
});

Deno.test("US-2693: a rejected row cannot create a conflict", () => {
  const item = itemFor([
    row({ id: "a", source: "consensus", name: "Commission Short" }),
    row({
      id: "b",
      source: "seller",
      name: "Something Wrong",
      rejected_at: "2026-08-19T00:00:00Z",
    }),
  ]);
  assert(!item.conflicting);
  assertEquals(item.resolved!.name, "Commission Short");
  // Still listed, marked, so an admin can see what was thrown away.
  assertEquals(item.candidates.find((c) => c.id === "b")!.rejected, true);
});

Deno.test("US-2693: a code whose only names were rejected is its own bucket", () => {
  const item = itemFor([
    row({ rejected_at: "2026-08-19T00:00:00Z" }),
  ]);
  assertEquals(item.resolved, null);
  assertEquals(item.priority, REVIEW_PRIORITY.rejected);
});

Deno.test("US-2693: thin evidence outranks settled, and both sit below conflict", () => {
  const thin = itemFor([row({ supporting: 1 })]);
  const settled = itemFor([row({ supporting: 20 })]);
  assertEquals(thin.priority, REVIEW_PRIORITY.thin);
  assertEquals(settled.priority, REVIEW_PRIORITY.settled);
  assert(REVIEW_PRIORITY.conflicting < REVIEW_PRIORITY.thin);
  assert(REVIEW_PRIORITY.thin < REVIEW_PRIORITY.settled);
});

Deno.test("US-2693: the queue puts conflicts first and the best-attested last", () => {
  const items = [
    itemFor([row({ style_code_norm: "SETTLED1", supporting: 30 })]),
    itemFor([
      row({ style_code_norm: "CONFLICT", id: "a", name: "One Name" }),
      row({ style_code_norm: "CONFLICT", id: "b", source: "seller", name: "Other Name" }),
    ]),
    itemFor([row({ style_code_norm: "THIN0001", supporting: 1 })]),
    itemFor([row({ style_code_norm: "SETTLED2", supporting: 8 })]),
  ];
  assertEquals(
    orderReviewQueue(items).map((i) => i.styleCodeNorm),
    ["CONFLICT", "THIN0001", "SETTLED2", "SETTLED1"],
  );
});

Deno.test("US-2693: the same data always produces the same page", () => {
  const a = itemFor([row({ style_code_norm: "AAAA1111", supporting: 9 })]);
  const b = itemFor([row({ style_code_norm: "BBBB2222", supporting: 9 })]);
  // Equal priority and equal support — the code breaks the tie, both ways round.
  assertEquals(orderReviewQueue([a, b]).map((i) => i.styleCodeNorm), [
    "AAAA1111",
    "BBBB2222",
  ]);
  assertEquals(orderReviewQueue([b, a]).map((i) => i.styleCodeNorm), [
    "AAAA1111",
    "BBBB2222",
  ]);
});

Deno.test("US-2693: one code per (brand, code), and codes do not merge across brands", () => {
  const groups = groupStyleCodeRows([
    row({ brand_key: "lululemon", style_code_norm: "AB1234", id: "a" }),
    row({ brand_key: "lululemon", style_code_norm: "AB1234", id: "b", source: "seller" }),
    row({ brand_key: "patagonia", style_code_norm: "AB1234", id: "c" }),
  ]);
  assertEquals(groups.length, 2);
  assertEquals(groups.find((g) => g.brandKey === "lululemon")!.rows.length, 2);
});

Deno.test("US-2693: a promoted style carries keywords, which is what makes it usable", () => {
  // US-2216: a brand_styles row without keywords cannot be found by the
  // extractor, so promoting without them would write a row that does nothing.
  assertEquals(
    keywordsForPromotedStyle("Commission Short Relaxed *Warpstreme 11\""),
    ["commission", "short", "relaxed", "warpstreme", "11"],
  );
  // Repeats collapse and single characters are dropped.
  assertEquals(keywordsForPromotedStyle("Align Align A Pant"), ["align", "pant"]);
});

// ── promoting a name into permanent knowledge ───────────────────────────────
// This is the point at which a machine-derived name becomes a brand_styles row
// the extractor trusts, so every refusal is a test rather than a route comment.

function candidate(over: Record<string, unknown> = {}) {
  return {
    brand_key: "lululemon",
    name: "Commission Short Relaxed Warpstreme",
    source: "consensus",
    rejected_at: null,
    ...over,
  } as Parameters<typeof promotionRefusal>[0];
}

const SRC = "https://www.ebay.com/itm/123";

Deno.test("US-2693: a good candidate is promotable", () => {
  assertEquals(promotionRefusal(candidate(), SRC), null);
  assertEquals(promotionRefusal(candidate({ source: "seller" }), SRC), null);
  assertEquals(promotionRefusal(candidate({ source: "official" }), SRC), null);
});

Deno.test("US-2693: promoting without a source is refused, because Postgres refuses it", () => {
  // brand_styles carries CHECK (brand_fact_is_sourced(source_url, confidence)).
  // Found by inserting the route's exact row shape against the real schema: the
  // first version would have 500'd on every seller-sourced promotion, since the
  // correction trigger has no URL to record.
  assertEquals(promotionRefusal(candidate(), null)?.status, 400);
  assertEquals(promotionRefusal(candidate(), "   ")?.status, 400);
});

Deno.test("US-2693: the admin's source wins, the learned evidence is the fallback", () => {
  assertEquals(effectivePromotionSource("https://typed", "https://evidence"), "https://typed");
  assertEquals(effectivePromotionSource("  ", "https://evidence"), "https://evidence");
  assertEquals(effectivePromotionSource(undefined, "https://evidence"), "https://evidence");
  assertEquals(effectivePromotionSource(undefined, null), null);
  assertEquals(effectivePromotionSource(42, null), null);
});

Deno.test("US-2693: a rejected name cannot be promoted by a later click", () => {
  const refusal = promotionRefusal(
    candidate({ rejected_at: "2026-08-19T00:00:00Z" }),
    SRC,
  );
  assertEquals(refusal?.status, 409);
});

Deno.test("US-2693: a code with no brand cannot be promoted", () => {
  // brand_styles is only ever read through a brand pack, so a row with no brand
  // is knowledge nothing can load.
  assertEquals(promotionRefusal(candidate({ brand_key: "" }), SRC)?.status, 400);
  assertEquals(promotionRefusal(candidate({ brand_key: "  " }), SRC)?.status, 400);
});

Deno.test("US-2693: a source outside the known set is refused, not trusted", () => {
  assertEquals(
    promotionRefusal(candidate({ source: "scraped_from_somewhere" }), SRC)?.status,
    400,
  );
});

Deno.test("US-2693: a blank name is refused", () => {
  assertEquals(promotionRefusal(candidate({ name: "   " }), SRC)?.status, 400);
});
