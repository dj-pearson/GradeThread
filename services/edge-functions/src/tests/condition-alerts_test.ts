// US-1807: buyer condition-alerts matching engine — the pure matching, curve
// resolution, due-search budgeting, and alert-body rendering.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  matchesSearch,
  pickCurveSlugForCert,
  selectDueSearches,
  buildAlertBody,
  DEFAULT_ALERTS_CONFIG,
  SAVED_SEARCH_SCAN_CAP,
  entitledSearchIds,
} = await import("../lib/condition-alerts.ts");
const { BUYER_PLAN_ENTITLEMENTS } = await import("../lib/buyer-plans.ts");

type Search = Parameters<typeof matchesSearch>[1];
// Taken from pickCurveSlugForCert, not matchesSearch: US-1808 widened
// matchesSearch's parameter to the structural MatchableItem subset so an
// extension-ingested marketplace listing (which has no certificate id) can be
// judged by the same predicate. The full CandidateCert is still what the curve
// resolver and the alert body take, and it satisfies MatchableItem, so one
// factory keeps serving all three.
type Cert = Parameters<typeof pickCurveSlugForCert>[0];

function search(o: Partial<Search> = {}): Search {
  return {
    id: "s1",
    user_id: "u1",
    label: "test",
    brands: [],
    categories: [],
    keywords: [],
    min_grade: null,
    max_price_cents: null,
    last_matched_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}
function cert(o: Partial<Cert> = {}): Cert {
  return {
    certificateId: "GT-1",
    brand: "Nike",
    title: "Air Hoodie",
    category: "tops",
    grade: 8.5,
    ...o,
  };
}

Deno.test("empty criteria = wildcard: any public cert matches", () => {
  assert(matchesSearch(cert(), search()));
});

Deno.test("brand filter is case-insensitive and exclusive", () => {
  assert(matchesSearch(cert({ brand: "Nike" }), search({ brands: ["nike"] })));
  assert(
    !matchesSearch(cert({ brand: "Adidas" }), search({ brands: ["nike"] })),
  );
  assert(!matchesSearch(cert({ brand: null }), search({ brands: ["nike"] })));
});

Deno.test("category filter matches the garment_category slug", () => {
  assert(
    matchesSearch(cert({ category: "tops" }), search({ categories: ["tops"] })),
  );
  assert(
    !matchesSearch(
      cert({ category: "footwear" }),
      search({ categories: ["tops"] }),
    ),
  );
});

Deno.test("min_grade is an inclusive floor", () => {
  assert(matchesSearch(cert({ grade: 8.0 }), search({ min_grade: 8.0 })));
  assert(!matchesSearch(cert({ grade: 7.9 }), search({ min_grade: 8.0 })));
});

Deno.test("keywords match against title + brand, case-insensitively", () => {
  assert(
    matchesSearch(
      cert({ title: "Vintage Hoodie" }),
      search({ keywords: ["vintage"] }),
    ),
  );
  assert(
    matchesSearch(
      cert({ brand: "Supreme", title: "Box Tee" }),
      search({ keywords: ["supreme"] }),
    ),
  );
  assert(
    !matchesSearch(
      cert({ title: "Plain Tee" }),
      search({ keywords: ["vintage"] }),
    ),
  );
});

Deno.test("all criteria compose (AND)", () => {
  const s = search({
    brands: ["nike"],
    categories: ["tops"],
    min_grade: 8,
    keywords: ["air"],
  });
  assert(matchesSearch(cert(), s));
  assert(!matchesSearch(cert({ grade: 6 }), s)); // fails grade
  assert(!matchesSearch(cert({ title: "Court Hoodie" }), s)); // fails keyword
});

// ── pickCurveSlugForCert ─────────────────────────────────────────────────────
type Hub = Parameters<typeof pickCurveSlugForCert>[1];
const hubItem = (brandSlug: string, itemSlug: string, slug: string) =>
  ({
    brandSlug,
    itemSlug,
    slug,
    brand: brandSlug,
    label: "",
    overall: null,
    refreshedAt: "",
  }) as unknown as Hub[number];

Deno.test("curve pick: exact item-slug match on the brand wins", () => {
  const hub = [
    hubItem("nike", "tops", "nike-tops"),
    hubItem("nike", "footwear", "nike-footwear"),
  ];
  assertEquals(
    pickCurveSlugForCert(cert({ brand: "Nike", category: "tops" }), hub),
    "nike-tops",
  );
});

Deno.test("curve pick: single brand curve is used even without an item match", () => {
  const hub = [hubItem("nike", "outerwear", "nike-outerwear")];
  assertEquals(
    pickCurveSlugForCert(
      cert({ brand: "Nike", category: "tops", title: "Plain" }),
      hub,
    ),
    "nike-outerwear",
  );
});

Deno.test("curve pick: ambiguous brand (2 non-matching curves) → null (don't guess)", () => {
  const hub = [
    hubItem("nike", "footwear", "nike-footwear"),
    hubItem("nike", "bags", "nike-bags"),
  ];
  assertEquals(
    pickCurveSlugForCert(
      cert({ brand: "Nike", category: "tops", title: "Plain" }),
      hub,
    ),
    null,
  );
});

Deno.test("curve pick: no curve for the brand → null", () => {
  const hub = [hubItem("adidas", "tops", "adidas-tops")];
  assertEquals(pickCurveSlugForCert(cert({ brand: "Nike" }), hub), null);
  assertEquals(pickCurveSlugForCert(cert({ brand: null }), hub), null);
});

// ── selectDueSearches ────────────────────────────────────────────────────────
Deno.test("due selection: never-checked first, then oldest, budget-capped", () => {
  const searches = [
    search({ id: "recent", last_matched_at: "2026-07-09T00:00:00Z" }),
    search({ id: "never", last_matched_at: null }),
    search({ id: "old", last_matched_at: "2026-01-01T00:00:00Z" }),
  ];
  const sel = selectDueSearches(searches, {
    ...DEFAULT_ALERTS_CONFIG,
    maxSearchesPerRun: 2,
  }, Date.now());
  assertEquals(sel.batch.map((s) => s.id), ["never", "old"]);
  assertEquals(sel.dueCount, 3);
  assert(sel.budgetCapped);
});

Deno.test("due selection: within budget → nothing capped", () => {
  const sel = selectDueSearches([search()], DEFAULT_ALERTS_CONFIG, Date.now());
  assertEquals(sel.budgetCapped, false);
});

// ── buildAlertBody ───────────────────────────────────────────────────────────
Deno.test("alert body includes fair value when known, omits it when not", () => {
  const withPrice = buildAlertBody(
    cert({ brand: "Nike", title: "Hoodie", grade: 9 }),
    4200,
  );
  assert(withPrice.includes("$42"));
  assert(withPrice.includes("9.0/10"));
  const without = buildAlertBody(
    cert({ brand: "Nike", title: "Hoodie", grade: 9 }),
    null,
  );
  assert(!without.includes("$"));
  assert(without.includes("matches your watch"));
});

// ── US-2315: a throwing search must not starve every other buyer ─────
//
// selectDueSearches orders MOST STALE FIRST, with a null last_matched_at
// coerced to 0. The stamp used to run only after the per-cert inner loop
// completed, so a search that threw kept its old stamp, stayed the stalest, and
// was picked first on every subsequent run — permanently ahead of everyone
// else's alerts. These pin the ordering property that makes that possible, and
// the rotation that breaks it.

Deno.test("US-2315: the stalest search really is picked first (the starvation vector)", () => {
  const mk = (id: string, last: string | null) => ({
    id,
    user_id: "u",
    label: id,
    brands: [],
    categories: [],
    keywords: [],
    min_grade: null,
    max_price_cents: null,
    last_matched_at: last,
    created_at: "2026-01-01T00:00:00.000Z",
  });
  // "never matched" sorts ahead of every dated one — that is the null → 0 rule.
  const sel = selectDueSearches(
    [
      mk("recent", "2026-08-02T10:00:00Z"),
      mk("never", null),
      mk("old", "2026-07-01T10:00:00Z"),
    ],
    { ...DEFAULT_ALERTS_CONFIG, maxSearchesPerRun: 50 },
    Date.parse("2026-08-02T12:00:00Z"),
  );
  assertEquals(sel.batch.map((s) => s.id), ["never", "old", "recent"]);
});

Deno.test("US-2315: a search that is never re-stamped stays first forever", () => {
  // The failure this story is about, stated as a property: if the stamp does
  // not move, the same search leads the batch on the next run, and the run
  // after that. Nothing else can be reached past it once it throws.
  const mk = (id: string, last: string | null) => ({
    id,
    user_id: "u",
    label: id,
    brands: [],
    categories: [],
    keywords: [],
    min_grade: null,
    max_price_cents: null,
    last_matched_at: last,
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const cfg = { ...DEFAULT_ALERTS_CONFIG, maxSearchesPerRun: 1 };
  const searches = [mk("poison", null), mk("waiting", "2026-07-01T10:00:00Z")];

  // Run 1 and run 2 with the poison search NEVER stamped: identical batch.
  const a = selectDueSearches(
    searches,
    cfg,
    Date.parse("2026-08-02T12:00:00Z"),
  );
  const b = selectDueSearches(
    searches,
    cfg,
    Date.parse("2026-08-02T12:15:00Z"),
  );
  assertEquals(a.batch.map((s) => s.id), ["poison"]);
  assertEquals(b.batch.map((s) => s.id), ["poison"]);

  // Stamp it — as the failure path now does — and the other search is reached.
  const stamped = [
    { ...searches[0], last_matched_at: "2026-08-02T12:00:00Z" },
    searches[1],
  ];
  const c = selectDueSearches(stamped, cfg, Date.parse("2026-08-02T12:15:00Z"));
  assertEquals(c.batch.map((s) => s.id), ["waiting"]);
});

Deno.test("US-2315: runConditionAlerts stamps on the FAILURE path too", async () => {
  // Source assertion: the defect was an ABSENT write, so there is no wrong
  // value to catch — what matters is that the catch block rotates the search.
  const src = await Deno.readTextFile(
    new URL("../lib/condition-alerts.ts", import.meta.url),
  );
  const catchBlock = src.slice(src.indexOf("} catch (err) {"));
  assert(
    catchBlock.includes("stampSearch(search, nowMs)"),
    "the catch path must stamp, or a throwing search stays the stalest forever",
  );
  assert(
    src.includes("failed?: number") || src.includes("failed: number"),
    "the run must report a failed count for the US-2312 cron recorder to read",
  );
});

// ── US-2317: the saved-search read is bounded, and ordered ───────────
//
// The read had no limit — every active saved search across every buyer was
// materialized, then selectDueSearches sorted it and kept maxSearchesPerRun. So
// the per-run budget bounded the WORK but not the READ, and the read is what
// grows with the buyer base.
//
// The ordering is what makes the cap safe rather than merely small: because the
// query now sorts stalest-first at the database, the rows the cap keeps are the
// rows selectDueSearches would have picked anyway. A bare .limit() with no
// order would have silently changed WHICH buyers get evaluated, differently on
// every run — the defect recorded against buyer-digest in US-2319.

Deno.test("US-2317: the saved-search read is capped AND ordered stalest-first", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/condition-alerts.ts", import.meta.url),
  );
  // Located by regex rather than indexOf with a literal newline: this file is
  // LF in the blob and CRLF in a Windows working tree, so `\n` between the two
  // chained calls matched nothing locally and this guard reported that the cap
  // had been removed when it had not (US-2429). A guard that cries wolf on a
  // checkout detail is a guard people stop reading.
  const found = /\.from\("saved_searches"\)\s*\.select\(/.exec(src);
  assert(found !== null, "the saved_searches read was not found");
  const at = found.index;
  const window = src.slice(at, at + 700);
  assert(
    window.includes(".limit(SAVED_SEARCH_SCAN_CAP)"),
    "the read must declare a named cap",
  );
  assert(
    window.includes('.order("last_matched_at"'),
    "the cap must be paired with an order, or WHICH buyers are evaluated becomes arbitrary",
  );
  assert(
    window.includes("nullsFirst: true"),
    "a never-matched search is the MOST stale — it must sort first, not last",
  );
});

Deno.test("US-2317: the cap sits far above the per-run budget", () => {
  // If the cap were near maxSearchesPerRun it would act as a second, hidden
  // budget. It is a growth bound: everything it drops is, by the ordering,
  // more recently checked than everything it keeps.
  assert(
    SAVED_SEARCH_SCAN_CAP > DEFAULT_ALERTS_CONFIG.maxSearchesPerRun * 100,
    "the read cap must not double as a per-run budget",
  );
});

// ── US-1805: the plan cap on concurrently-active alerts ──────────────────────
//
// activeAlertsCap was advertised on both halves of the plan matrix and
// parity-tested, but nothing read it — saved searches are written client-side
// under RLS, so this engine is the only place the cap can be enforced.

function capRow(id: string, created_at: string) {
  return { id, created_at };
}

Deno.test("US-1805: a limited plan entitles only its OLDEST N active searches", () => {
  const mine = [
    capRow("a", "2026-01-01T00:00:00Z"),
    capRow("b", "2026-02-01T00:00:00Z"),
    capRow("c", "2026-03-01T00:00:00Z"),
    capRow("d", "2026-04-01T00:00:00Z"),
  ];
  const entitled = entitledSearchIds(mine, 3, true);
  assertEquals(entitled.size, 3);
  assert(entitled.has("a") && entitled.has("b") && entitled.has("c"));
  assert(!entitled.has("d"), "the newest search is the one over the cap");
});

Deno.test("US-1805: the entitled subset is STABLE regardless of input order", () => {
  const mine = [
    capRow("c", "2026-03-01T00:00:00Z"),
    capRow("a", "2026-01-01T00:00:00Z"),
    capRow("b", "2026-02-01T00:00:00Z"),
  ];
  // Shuffled input, same answer — otherwise an over-cap buyer would get a
  // different arbitrary subset alerted on every sweep.
  assertEquals([...entitledSearchIds(mine, 2, true)].sort(), ["a", "b"]);
  assertEquals([...entitledSearchIds([...mine].reverse(), 2, true)].sort(), ["a", "b"]);
});

Deno.test("US-1805: same-instant rows tie-break on id, so the result is deterministic", () => {
  const same = "2026-01-01T00:00:00Z";
  const mine = [capRow("z", same), capRow("a", same), capRow("m", same)];
  assertEquals([...entitledSearchIds(mine, 2, true)].sort(), ["a", "m"]);
});

Deno.test("US-1805: an unlimited cap entitles everything", () => {
  const mine = Array.from({ length: 40 }, (_, i) => capRow(`s${i}`, "2026-01-01T00:00:00Z"));
  assertEquals(entitledSearchIds(mine, -1, true).size, 40);
});

Deno.test("US-1805: a plan without the alerts flag entitles NOTHING, cap notwithstanding", () => {
  const mine = [capRow("a", "2026-01-01T00:00:00Z")];
  assertEquals(entitledSearchIds(mine, -1, false).size, 0);
  assertEquals(entitledSearchIds(mine, 25, false).size, 0);
});

Deno.test("US-1805: a cap of zero entitles nothing", () => {
  assertEquals(entitledSearchIds([capRow("a", "2026-01-01T00:00:00Z")], 0, true).size, 0);
});

Deno.test("US-1805: the caps the engine enforces are the ENFORCED plan matrix's", () => {
  // Guards the binding, not the numbers — buyer-plan-limits-parity.test.ts is
  // what keeps the advertised and enforced numbers equal.
  const mine = Array.from({ length: 30 }, (_, i) =>
    capRow(`s${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
  const free = BUYER_PLAN_ENTITLEMENTS.free;
  const guard = BUYER_PLAN_ENTITLEMENTS.guard;
  const conn = BUYER_PLAN_ENTITLEMENTS.connoisseur;
  assertEquals(
    entitledSearchIds(mine, free.allowances.activeAlertsCap, free.gateFlags.conditionAlerts).size,
    3,
  );
  assertEquals(
    entitledSearchIds(mine, guard.allowances.activeAlertsCap, guard.gateFlags.conditionAlerts).size,
    25,
  );
  assertEquals(
    entitledSearchIds(mine, conn.allowances.activeAlertsCap, conn.gateFlags.conditionAlerts).size,
    30,
  );
});
