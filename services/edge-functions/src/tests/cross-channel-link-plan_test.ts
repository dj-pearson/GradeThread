// US-3197 AC3/AC4: which joins actually happen across a whole closet.
//
// EVERY CASE HERE IS A WAY THE NAIVE VERSION MERGES TWO DIFFERENT GARMENTS.
// There is no unmerge button, so the bar is not "does it link the obvious
// pair" -- decideLink already answers that and is tested for it -- but "what
// does it refuse to link when the pairwise score says yes".

import { assert, assertEquals } from "@std/assert";
import {
  alreadyJoined,
  type LinkableRow,
  planCrossChannelLinks,
} from "../lib/cross-channel-link-plan.ts";

let n = 0;
function row(
  platform: string,
  title: string,
  over: Partial<LinkableRow> & Partial<LinkableRow["candidate"]> = {},
): LinkableRow {
  n++;
  const id = (over as { listingId?: string }).listingId ?? `L${n}`;
  return {
    listingId: id,
    inventoryItemId: (over as { inventoryItemId?: string }).inventoryItemId ?? `I${n}`,
    draftId: (over as { draftId?: string | null }).draftId ?? null,
    createdAt: (over as { createdAt?: string }).createdAt ?? `2026-09-0${(n % 9) + 1}T00:00:00Z`,
    candidate: {
      platform,
      title,
      brand: (over as { brand?: string | null }).brand ?? null,
      size: (over as { size?: string | null }).size ?? null,
      color: (over as { color?: string | null }).color ?? null,
      price: (over as { price?: number | null }).price ?? null,
    },
  };
}

Deno.test("two channels, one garment: a confident mutual pair joins", () => {
  const a = row("ebay", "Patagonia Better Sweater fleece jacket", {
    brand: "Patagonia",
    size: "M",
    color: "navy",
    price: 89,
    listingId: "A",
    inventoryItemId: "IA",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const b = row("poshmark", "Patagonia Better Sweater fleece jacket", {
    brand: "Patagonia",
    size: "M",
    color: "navy",
    price: 95,
    listingId: "B",
    inventoryItemId: "IB",
    createdAt: "2026-05-01T00:00:00Z",
  });
  const plan = planCrossChannelLinks([a, b]);
  assertEquals(plan.links.length, 1, JSON.stringify(plan));
  assertEquals(plan.reviews.length, 0);
  // The OLDER item anchors: it is the one the seller has had longer and is
  // likelier to have measured, photographed or edited.
  assertEquals(plan.links[0].keepItemId, "IA");
  assertEquals(plan.links[0].mergeItemId, "IB");
  assertEquals(plan.links[0].listingIds, ["A", "B"]);
});

Deno.test("the anchor is the older item, whichever order the rows arrive in", () => {
  const mk = (createdAt: string, id: string, item: string, platform: string) =>
    row(platform, "Patagonia Better Sweater fleece jacket", {
      brand: "Patagonia",
      size: "M",
      color: "navy",
      price: 90,
      listingId: id,
      inventoryItemId: item,
      createdAt,
    });
  const older = mk("2026-01-01T00:00:00Z", "A", "IA", "ebay");
  const newer = mk("2026-06-01T00:00:00Z", "B", "IB", "poshmark");
  for (const rows of [[older, newer], [newer, older]]) {
    const plan = planCrossChannelLinks(rows);
    assertEquals(plan.links.length, 1);
    assertEquals(plan.links[0].keepItemId, "IA");
  }
});

Deno.test("a one-sided best match is demoted to review, not linked", () => {
  // A's closest match is B, but B's closest is C. Linking A to B anyway is
  // how one attractive row swallows a garment that belongs elsewhere.
  //
  // THE FIRST VERSION OF THIS CASE PROVED NOTHING: three bare "black tee"
  // titles with no brand or size score below REVIEW_THRESHOLD, so bestMatch
  // returned null and the plan was empty. `links.length === 0` passed for the
  // wrong reason. The rows below reach a verdict, which is what makes the
  // demotion observable.
  const common = { brand: "Nike", size: "M" };
  const a = row("ebay", "Nike Tech Fleece hoodie grey", {
    ...common,
    listingId: "A",
    inventoryItemId: "IA",
  });
  const b = row("poshmark", "Nike Tech Fleece hoodie grey joggers", {
    ...common,
    listingId: "B",
    inventoryItemId: "IB",
  });
  const c = row("mercari", "Nike Tech Fleece hoodie grey joggers set", {
    ...common,
    listingId: "C",
    inventoryItemId: "IC",
  });
  const plan = planCrossChannelLinks([a, b, c]);
  // A must not be joined to anything: its interest is not returned.
  const linkedListings = plan.links.flatMap((l) => l.listingIds);
  assertEquals(linkedListings.includes("A"), false, JSON.stringify(plan));
  // And it is held for a human rather than dropped, because it is still the
  // best evidence anyone has about A.
  assert(
    plan.reviews.some((r) => r.listingIds.includes("A")),
    `A was neither linked nor reviewed: ${JSON.stringify(plan)}`,
  );
});

Deno.test("a row is joined at most once per run, so no three-way merge", () => {
  // A-B and B-C both scoring as links would, with transitive closure, put
  // three garments on one item off two pairwise decisions. Neither decision
  // was asked that question.
  const base = { brand: "Nike", size: "M", color: "black", price: 40 };
  const a = row("ebay", "Nike Tech Fleece hoodie black", {
    ...base,
    listingId: "A",
    inventoryItemId: "IA",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const b = row("poshmark", "Nike Tech Fleece hoodie black", {
    ...base,
    listingId: "B",
    inventoryItemId: "IB",
    createdAt: "2026-02-01T00:00:00Z",
  });
  const c = row("mercari", "Nike Tech Fleece hoodie black", {
    ...base,
    listingId: "C",
    inventoryItemId: "IC",
    createdAt: "2026-03-01T00:00:00Z",
  });
  const plan = planCrossChannelLinks([a, b, c]);
  const touched = plan.links.flatMap((l) => l.listingIds);
  assertEquals(new Set(touched).size, touched.length, "a listing appears in two links");
  const items = plan.links.flatMap((l) => [l.keepItemId, l.mergeItemId]);
  assertEquals(new Set(items).size, items.length, "an item appears in two links");
  assert(plan.links.length <= 1, `${plan.links.length} links from three identical rows`);
});

Deno.test("rows already on one item are skipped, which is the idempotency case", () => {
  const a = row("ebay", "Patagonia fleece", {
    brand: "Patagonia",
    size: "M",
    price: 80,
    listingId: "A",
    inventoryItemId: "SAME",
  });
  const b = row("poshmark", "Patagonia fleece", {
    brand: "Patagonia",
    size: "M",
    price: 80,
    listingId: "B",
    inventoryItemId: "SAME",
  });
  const plan = planCrossChannelLinks([a, b]);
  assertEquals(plan.links.length, 0);
  assertEquals(plan.reviews.length, 0);
  assertEquals(plan.alreadyLinked, 1);
});

Deno.test("rows already sharing a draft_id are skipped too", () => {
  const a = row("ebay", "Patagonia fleece", {
    brand: "Patagonia",
    size: "M",
    price: 80,
    listingId: "A",
    inventoryItemId: "IA",
    draftId: "GROUP",
  });
  const b = row("poshmark", "Patagonia fleece", {
    brand: "Patagonia",
    size: "M",
    price: 80,
    listingId: "B",
    inventoryItemId: "IB",
    draftId: "GROUP",
  });
  assert(alreadyJoined(a, b));
  assertEquals(planCrossChannelLinks([a, b]).links.length, 0);
});

Deno.test("the group anchor's null draft_id does not hide an existing join", () => {
  // The shape the eBay writeback leaves: the anchor carries no draft_id of
  // its own and the sibling points at the anchor's ITEM. Reading that as
  // unlinked would re-join a pair that is already one garment.
  const anchor = row("ebay", "Patagonia fleece", {
    listingId: "A",
    inventoryItemId: "IA",
    draftId: null,
  });
  const sibling = row("poshmark", "Patagonia fleece", {
    listingId: "B",
    inventoryItemId: "IB",
    draftId: "IA",
  });
  assert(alreadyJoined(anchor, sibling));
});

Deno.test("two rows from the same platform never link, at group level either", () => {
  const a = row("poshmark", "Patagonia Better Sweater", {
    brand: "Patagonia",
    size: "M",
    price: 80,
    listingId: "A",
    inventoryItemId: "IA",
  });
  const b = row("poshmark", "Patagonia Better Sweater", {
    brand: "Patagonia",
    size: "M",
    price: 80,
    listingId: "B",
    inventoryItemId: "IB",
  });
  const plan = planCrossChannelLinks([a, b]);
  assertEquals(plan.links.length, 0);
  assertEquals(plan.reviews.length, 0);
  assertEquals(plan.unmatched, 2);
});

Deno.test("different brands are refused however close the titles are", () => {
  const a = row("ebay", "Better Sweater fleece jacket navy medium", {
    brand: "Patagonia",
    size: "M",
    listingId: "A",
    inventoryItemId: "IA",
  });
  const b = row("poshmark", "Better Sweater fleece jacket navy medium", {
    brand: "Arcteryx",
    size: "M",
    listingId: "B",
    inventoryItemId: "IB",
  });
  const plan = planCrossChannelLinks([a, b]);
  assertEquals(plan.links.length, 0);
  assertEquals(plan.reviews.length, 0);
});

Deno.test("a plan is reproducible: same rows in any order, same result", () => {
  const rows = [
    row("ebay", "Levis 501 straight jeans", {
      brand: "Levis",
      size: "32",
      price: 45,
      listingId: "A",
      inventoryItemId: "IA",
      createdAt: "2026-01-01T00:00:00Z",
    }),
    row("poshmark", "Levis 501 straight jeans", {
      brand: "Levis",
      size: "32",
      price: 48,
      listingId: "B",
      inventoryItemId: "IB",
      createdAt: "2026-02-01T00:00:00Z",
    }),
    row("mercari", "Madewell perfect vintage jeans", {
      brand: "Madewell",
      size: "28",
      price: 60,
      listingId: "C",
      inventoryItemId: "IC",
      createdAt: "2026-03-01T00:00:00Z",
    }),
  ];
  const forward = planCrossChannelLinks(rows);
  const backward = planCrossChannelLinks([...rows].reverse());
  // Compared WITHOUT sorting here on purpose: the plan sorts its own output,
  // and sorting again in the test would hide it if it stopped. The review
  // queue is a screen a seller works through, so a list that reshuffles on
  // re-run is a list they lose their place in.
  assertEquals(forward.links, backward.links);
  assertEquals(forward.reviews, backward.reviews);
});

Deno.test("identical createdAt still gives one deterministic anchor", () => {
  const same = "2026-04-04T00:00:00Z";
  const a = row("ebay", "Patagonia Better Sweater fleece", {
    brand: "Patagonia",
    size: "M",
    color: "navy",
    price: 80,
    listingId: "ZZZ",
    inventoryItemId: "IZ",
    createdAt: same,
  });
  const b = row("poshmark", "Patagonia Better Sweater fleece", {
    brand: "Patagonia",
    size: "M",
    color: "navy",
    price: 80,
    listingId: "AAA",
    inventoryItemId: "IY",
    createdAt: same,
  });
  const plan = planCrossChannelLinks([a, b]);
  assertEquals(plan.links.length, 1);
  // Listing id breaks the tie, so the answer does not depend on row order.
  assertEquals(plan.links[0].listingIds, ["AAA", "ZZZ"]);
  assertEquals(planCrossChannelLinks([b, a]).links[0].listingIds, ["AAA", "ZZZ"]);
});

Deno.test("a single row, or none, plans nothing and says so", () => {
  assertEquals(planCrossChannelLinks([]).unmatched, 0);
  const one = planCrossChannelLinks([row("ebay", "a thing")]);
  assertEquals(one.links.length, 0);
  assertEquals(one.unmatched, 1);
});

Deno.test("every planned link and review carries its reasons", () => {
  // A review the seller cannot understand is a review they will not do, and
  // an unexplained merge is one they cannot audit.
  const plan = planCrossChannelLinks([
    row("ebay", "Patagonia Better Sweater fleece", {
      brand: "Patagonia",
      size: "M",
      price: 80,
      listingId: "A",
      inventoryItemId: "IA",
    }),
    row("poshmark", "Patagonia Better Sweater fleece", {
      brand: "Patagonia",
      size: "M",
      price: 85,
      listingId: "B",
      inventoryItemId: "IB",
    }),
  ]);
  for (const entry of [...plan.links, ...plan.reviews]) {
    assert(entry.reasons.length > 0, "an entry with no reasons");
    assert(entry.score > 0);
  }
});

// ── the three rules the cases above did NOT isolate ────────────────
//
// Sabotage found it: removing the mutual-best rule, the one-join-per-run rule
// and the output sort each left the suite GREEN. Every one of those cases
// passed for a reason other than the rule it names -- the one-sided case was
// actually blocked by the join limit, the three-identical case was demoted by
// bestMatch's own ambiguity rule before reaching the join limit, and the
// reproducibility fixture produced one link, which cannot be misordered.
//
// A rule that no test can break is a rule that is not being tested. These
// three isolate one each, and each was measured RED against the sabotage
// before being kept.

Deno.test("mutual-best alone: one-sided is reviewed and the real pair still links", () => {
  // A's best is B; B's best is C; C's best is B. So A's interest in B is not
  // returned, and linking it anyway is how one row swallows a garment that
  // belongs to another pair.
  //
  // THE FIXTURE IS BUILT TO LEAVE ONLY THIS RULE STANDING, and getting there
  // took three attempts. A and C are BOTH on eBay, so decideLink refuses that
  // pair outright and A is left with exactly one candidate -- which is what
  // stops bestMatch's own ambiguity rule from demoting A before this rule is
  // reached. That is what the earlier versions got wrong: they asserted the
  // right outcome and proved the ambiguity rule, not this one. A's eBay price
  // is padded, so A-B (0.93) sits a clear 0.07 under B-C (1.00).
  const T = "Nike Tech Fleece hoodie grey mens";
  const common = { brand: "Nike", size: "M", color: "grey" };
  const a = row("ebay", T, {
    ...common,
    price: 500,
    listingId: "A",
    inventoryItemId: "IA",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const b = row("poshmark", T, {
    ...common,
    price: 50,
    listingId: "B",
    inventoryItemId: "IB",
    createdAt: "2026-02-01T00:00:00Z",
  });
  const c = row("ebay", T, {
    ...common,
    price: 50,
    listingId: "C",
    inventoryItemId: "IC",
    createdAt: "2026-03-01T00:00:00Z",
  });
  const plan = planCrossChannelLinks([a, b, c]);
  // The mutual pair lands...
  assertEquals(
    plan.links.map((l) => l.listingIds.join("-")),
    ["B-C"],
    JSON.stringify(plan),
  );
  // ...and the one-sided interest is held for a human rather than joined or
  // dropped. Without the rule these two swap over.
  assert(
    plan.reviews.some((r) => r.listingIds.join("-") === "A-B"),
    `A-B should be reviewed: ${JSON.stringify(plan)}`,
  );
});

Deno.test("no listing ends up in two links, whatever the fixture", () => {
  // THE INVARIANT, asserted directly rather than through the guard that
  // enforces it. Sabotage showed the listing-level check in the planner is
  // UNREACHABLE while the mutual-best rule holds -- mutual best matching is a
  // matching, so its pairs are disjoint by construction and no test can make
  // that branch fire. The guard stays as belt and braces on a merge with no
  // undo, but pretending a case covers it would be the false-green this file
  // already had three of. What is worth pinning is the property.
  const T = "Nike Tech Fleece hoodie grey mens";
  const common = { brand: "Nike", size: "M", color: "grey" };
  const rows = ["ebay", "poshmark", "mercari", "depop", "grailed"].map((platform, i) =>
    row(platform, T, {
      ...common,
      price: 50 + i,
      listingId: `L${i}`,
      inventoryItemId: `I${i}`,
      createdAt: `2026-0${i + 1}-01T00:00:00Z`,
    })
  );
  const plan = planCrossChannelLinks(rows);
  const listings = plan.links.flatMap((l) => l.listingIds);
  assertEquals(new Set(listings).size, listings.length, JSON.stringify(plan));
  const items = plan.links.flatMap((l) => [l.keepItemId, l.mergeItemId]);
  assertEquals(new Set(items).size, items.length, JSON.stringify(plan));
});

Deno.test("one join per run: two mutual pairs sharing an ITEM cannot both land", () => {
  // The realistic shape rule 3 exists for. One inventory item already carries
  // two channel listings; each of them mutual-matches a DIFFERENT item. Both
  // joins would put that item in two groups at once, and pairwise matching
  // cannot see it because neither pair shares a listing.
  const shared = "ISHARED";
  const l1 = row("ebay", "Levis 501 straight jeans indigo", {
    brand: "Levis",
    size: "32",
    color: "indigo",
    price: 45,
    listingId: "L1",
    inventoryItemId: shared,
    createdAt: "2026-01-01T00:00:00Z",
  });
  const l2 = row("poshmark", "Madewell perfect vintage jeans black", {
    brand: "Madewell",
    size: "28",
    color: "black",
    price: 60,
    listingId: "L2",
    inventoryItemId: shared,
    createdAt: "2026-01-01T00:00:00Z",
  });
  const l3 = row("mercari", "Levis 501 straight jeans indigo", {
    brand: "Levis",
    size: "32",
    color: "indigo",
    price: 46,
    listingId: "L3",
    inventoryItemId: "IY",
    createdAt: "2026-02-01T00:00:00Z",
  });
  const l4 = row("depop", "Madewell perfect vintage jeans black", {
    brand: "Madewell",
    size: "28",
    color: "black",
    price: 61,
    listingId: "L4",
    inventoryItemId: "IZ",
    createdAt: "2026-03-01T00:00:00Z",
  });
  const plan = planCrossChannelLinks([l1, l2, l3, l4]);
  // Both pairs are genuine mutual links on their own. Only one may land.
  assertEquals(plan.links.length, 1, JSON.stringify(plan));
  const items = plan.links.flatMap((l) => [l.keepItemId, l.mergeItemId]);
  assertEquals(items.filter((i) => i === shared).length, 1);
  // The other is held, not silently dropped.
  assert(plan.reviews.length >= 1, JSON.stringify(plan));
});

Deno.test("two independent links come out in the same order whichever way in", () => {
  // Needs TWO links: one cannot be misordered, which is why the earlier
  // reproducibility case could not see the sort disappear.
  const pair = (
    brand: string,
    size: string,
    title: string,
    ids: [string, string],
    items: [string, string],
  ) => [
    row("ebay", title, {
      brand,
      size,
      price: 50,
      listingId: ids[0],
      inventoryItemId: items[0],
      createdAt: "2026-01-01T00:00:00Z",
    }),
    row("poshmark", title, {
      brand,
      size,
      price: 52,
      listingId: ids[1],
      inventoryItemId: items[1],
      createdAt: "2026-02-01T00:00:00Z",
    }),
  ];
  const rows = [
    ...pair("Levis", "32", "Levis 501 straight jeans indigo", ["A1", "A2"], ["I1", "I2"]),
    ...pair("Madewell", "28", "Madewell perfect vintage jeans black", ["B1", "B2"], ["I3", "I4"]),
  ];
  const forward = planCrossChannelLinks(rows);
  const backward = planCrossChannelLinks([...rows].reverse());
  assertEquals(forward.links.length, 2, JSON.stringify(forward));
  assertEquals(
    forward.links.map((l) => l.listingIds.join("-")),
    backward.links.map((l) => l.listingIds.join("-")),
  );
});
