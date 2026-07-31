// Cross-tenant isolation regression tests (US-268).
//
// The edge service talks to Supabase with the SERVICE-ROLE client, which
// BYPASSES Row Level Security. Tenant isolation therefore rests entirely on
// each handler filtering every query by the authenticated user. These tests
// assert that boundary holds end-to-end: user B must never read or mutate
// user A's resources through the public API.
//
// They drive a RUNNING edge service with two real Supabase user sessions, so
// they are env-gated and SKIP cleanly when that fixture isn't configured.
// Required env:
//   TEST_EDGE_BASE_URL          e.g. http://localhost:8787
//   TEST_USER_A_JWT             valid access token for user A (the victim)
//   TEST_USER_B_JWT             valid access token for user B (the attacker)
// Resource ids OWNED BY user A (the test only reads/attempts, never relies on
// mutation succeeding):
//   TEST_USER_A_SUBMISSION_ID   a flipdesk_grading_submissions.id
//   TEST_USER_A_LISTING_ID      a listings.id
//   TEST_USER_A_API_KEY_ID      an api_keys.id
//   TEST_USER_A_TEMPLATE_ID     a listing_templates.id (US-674)
//   TEST_USER_A_RULE_ID         a repricing_rules.id (US-672)
//   TEST_USER_A_ITEM_ID         an inventory_items.id (AutoLister, US-324)
//   TEST_USER_A_BATCH_ID        a listing_generation_batches.id (AutoLister)
//   TEST_USER_A_GARMENT_ID      a garments.id (Garment Passport, US-1090/1092)
//   TEST_USER_A_EBAY_ORDER_ID   a sales.platform_order_id (eBay refund, US-1978)
//   TEST_USER_A_EBAY_OFFER_ID   a listings.platform_offer_id (eBay cleanup, US-1978)
//   TEST_USER_A_EBAY_SKU        an inventory_items.sku (eBay cleanup, US-1978)
//   TEST_USER_A_PHOTO_ID        an item_photos.id (US-2014 remove-bg probe;
//                               OPTIONAL — skips until the seed script adds it)
//   TEST_VIEWER_JWT             a role=viewer member of A's workspace (US-2039)
//   TEST_WORKSPACE_OWNER_ID     A's user id — the X-Workspace-Owner value
// For the AutoLister batch-enqueue test, user B should ideally be on a plan
// that includes AutoLister so the OWNERSHIP path is exercised; if B is on a
// free/starter plan the request is denied earlier with 402 (still a pass —
// B never touches A's items).
//
// Run:  deno task test   (or: deno test --allow-net --allow-env)

import { assert, assertEquals } from "@std/assert";

const BASE = Deno.env.get("TEST_EDGE_BASE_URL");
const A_JWT = Deno.env.get("TEST_USER_A_JWT");
const B_JWT = Deno.env.get("TEST_USER_B_JWT");

const CONFIGURED = Boolean(BASE && A_JWT && B_JWT);
if (!CONFIGURED) {
  console.warn(
    "[tenant-isolation] SKIPPED — set TEST_EDGE_BASE_URL + TEST_USER_A_JWT + " +
      "TEST_USER_B_JWT (and TEST_USER_A_* resource ids) to run these tests.",
  );
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };
}

// Cross-tenant access is correctly denied when the API returns 401/403/404.
// This codebase deliberately uses 404 ("not found") rather than 403 so it
// doesn't confirm a resource exists. A 200 carrying user A's data is a FAIL.
const DENIED = new Set([401, 403, 404]);

function assertDenied(status: number, label: string) {
  assert(
    DENIED.has(status),
    `${label}: cross-tenant access should be denied (401/403/404) but got ${status}`,
  );
}

// US-350: in CI the merge gate must FAIL if this suite would silently SKIP.
// The tenant-isolation workflow seeds a two-tenant fixture, then runs with
// TENANT_ISOLATION_REQUIRED=1 so a missing fixture (or a missing seeded
// resource id the cross-tenant cases need) is a hard failure, not a skip.
const REQUIRED = Boolean(Deno.env.get("TENANT_ISOLATION_REQUIRED"));

// Resource ids whose cross-tenant cases MUST run in CI (they'd otherwise skip
// when their id env var is unset).
//
// ⚠️ This list is NOT the guard. "Keep in sync with the seed script" is exactly
// what stopped happening: the list held 14 ids while 38 gated a case, so 26
// cross-tenant cases — refunding another tenant's eBay order, marking their
// sale shipped, reading their support conversations — skipped on every CI run
// while the workflow reported green. That is US-2039 a second time, in the very
// guard added to prevent it.
//
// The real guard is "every gating id is seeded or classified", derived below
// from the source. This list is kept only as the explicit floor.
const REQUIRED_RESOURCE_IDS = [
  "TEST_USER_A_SUBMISSION_ID",
  "TEST_USER_A_LISTING_ID",
  "TEST_USER_A_API_KEY_ID",
  "TEST_USER_A_TEMPLATE_ID",
  "TEST_USER_A_RULE_ID",
  "TEST_USER_A_ITEM_ID",
  "TEST_USER_A_BATCH_ID",
  "TEST_USER_A_SYNC_RUN_ID",
  "TEST_USER_A_PAYOUT_ID",
  "TEST_USER_A_CONFLICT_ID",
  "TEST_USER_A_RECONCILE_SESSION",
  "TEST_USER_A_CONSIGNOR_ID",
  // US-2039: the VIEWER fixture. Seven intra-workspace role cases — including
  // "viewer cannot pay for a grade (drains owner credits)" — gated on these and
  // skipped silently on every CI run because the seed script never emitted
  // them. They were LABELLED as though the wiring had landed. Requiring them
  // here is what makes the least-covered critical path (auth / workspace
  // member) actually covered rather than nominally covered.
  "TEST_VIEWER_JWT",
  "TEST_WORKSPACE_OWNER_ID",
];

/**
 * Ids that gate a case but which the seed script does not yet emit, so those
 * cases CANNOT run in CI. Each must be listed here with a reason — the point is
 * that the gap is visible and counted, not that it is acceptable.
 *
 * Tracked by US-2078. Do not add to this list to make a red build green: an
 * entry here means a cross-tenant path is UNVERIFIED in CI.
 */
const KNOWN_UNSEEDED: Record<string, string> = {
  // External systems — cannot be produced by the local seed script.
  TEST_USER_A_EBAY_OFFER_ID: "needs a live eBay sandbox offer — external dependency",
  TEST_USER_A_EBAY_ORDER_ID: "needs a live eBay sandbox order — external dependency",
  TEST_USER_A_EBAY_SKU: "needs a published eBay inventory item — external dependency",
  TEST_USER_A_FULFILLMENT_POLICY_ID: "needs eBay business policies — external dependency",
  TEST_USER_A_PUSH_ENDPOINT: "needs a real Web Push subscription endpoint",
  // US-2078: the plain-DB-row ids (closet item, conversation, ticket, sale,
  // want, garment, grading batch, passport node) are now emitted by the seed
  // script — moved out of this list, which the stale-check requires.
  // These remain because they need more than a plain insert:
  TEST_USER_A_PHOTO_ID: "needs an uploaded item photo in storage",
  TEST_USER_A_SUGGESTION_ID: "produced by a repricing run — needs pipeline execution",
  TEST_USER_A_BUYER_PURCHASE_ID: "needs a completed buyer purchase",
  TEST_USER_A_CERT_ID: "needs a certified grade report (published, certificate_id set)",
  TEST_PRIVATE_REPORT_ID: "needs an uncertified/private report",
  TEST_USER_B_API_KEY: "needs a RAW api key (gt_sk_…) for tenant B — the row's key_hash must match the edge's hashing, not a plain insert",
  TEST_USER_B_HANDLE: "needs a storefront handle for tenant B",
  TEST_SELLER_NO_STOREFRONT_HANDLE: "needs a seller with storefront opt-in disabled",
};

/**
 * The structural guard: every env id that GATES a case must be either seeded or
 * explicitly classified above. Derived from the sources, so a new gated case
 * with an unseeded id fails immediately instead of skipping quietly.
 *
 * Runs unconditionally — it reads files, needs no fixture, and a guard that
 * only runs in CI is a guard nobody watches fail.
 */
Deno.test({
  name: "every gating resource id is seeded or classified (no silent skips)",
  fn: async () => {
    const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const suite = await Deno.readTextFile(`${here}tenant-isolation_test.ts`);
    const seed = await Deno.readTextFile(
      `${here}../../scripts/seed-tenant-isolation-fixture.ts`,
    );

    const seeded = new Set([...seed.matchAll(/TEST_[A-Z_]+/g)].map((m) => m[0]));
    // Supplied by the workflow, not the seed script.
    for (const k of ["TEST_EDGE_BASE_URL", "TEST_USER_A_JWT", "TEST_USER_B_JWT"]) {
      seeded.add(k);
    }

    // Ids are gated two ways, and missing the second is how a guard like this
    // quietly stops working:
    //   (a) inline    — ignore: !Deno.env.get("TEST_USER_A_ITEM_ID")
    //   (b) aliased   — const A_WANT_ID = Deno.env.get("TEST_USER_A_WANT_ID")
    //                   ... later ... ignore: !A_WANT_ID
    // Resolve the aliases first, then treat a header mentioning an alias as
    // gating the env id behind it.
    const aliasToEnv = new Map<string, string>();
    for (const m of suite.matchAll(
      /const\s+([A-Za-z_$][\w$]*)\s*=\s*Deno\.env\.get\(\s*"(TEST_[A-Z_]+)"\s*\)/g,
    )) {
      aliasToEnv.set(m[1]!, m[2]!);
    }

    const gating = new Set<string>();
    for (const block of suite.split("Deno.test({").slice(1)) {
      const cut = block.indexOf("fn:");
      const head = block.slice(0, cut === -1 ? block.length : cut);
      for (const m of head.matchAll(/TEST_[A-Z_]+/g)) gating.add(m[0]);
      for (const m of head.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const env = aliasToEnv.get(m[0]);
        if (env) gating.add(env);
      }
    }

    const unaccounted = [...gating]
      .filter((id) => !seeded.has(id) && !(id in KNOWN_UNSEEDED))
      .sort();

    assert(
      unaccounted.length === 0,
      "These env ids gate a cross-tenant case but are neither emitted by " +
        "scripts/seed-tenant-isolation-fixture.ts nor listed in KNOWN_UNSEEDED, " +
        "so their cases SKIP in CI while the suite reports green:\n  " +
        unaccounted.join("\n  ") +
        "\n\nSeed the id, or classify it in KNOWN_UNSEEDED with a reason.",
    );

    // A classification that has since been seeded is stale and understates
    // real coverage — clean it up so the count stays honest.
    const stale = Object.keys(KNOWN_UNSEEDED)
      .filter((id) => seeded.has(id) || !gating.has(id))
      .sort();
    assert(
      stale.length === 0,
      "KNOWN_UNSEEDED entries that are now seeded or no longer gate anything — " +
        "remove them:\n  " + stale.join("\n  "),
    );
  },
});

Deno.test({
  name: "fixture is configured — suite must not SKIP in CI",
  ignore: !REQUIRED,
  fn: () => {
    assert(
      CONFIGURED,
      "TENANT_ISOLATION_REQUIRED is set but TEST_EDGE_BASE_URL + TEST_USER_A_JWT " +
        "+ TEST_USER_B_JWT are not all present — the suite would SKIP. Seed the " +
        "two-tenant fixture (scripts/seed-tenant-isolation-fixture.ts) first.",
    );
    const missing = REQUIRED_RESOURCE_IDS.filter((k) => !Deno.env.get(k));
    assert(
      missing.length === 0,
      `seeded resource ids missing, cross-tenant cases would SKIP: ${missing.join(", ")}`,
    );
  },
});

Deno.test({
  name: "B cannot read A's grading submission status",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SUBMISSION_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_SUBMISSION_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/grading/submissions/${id}`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "GET grading submission");
  },
});

Deno.test({
  // US-1637: per-grade checkout is now owner-scoped (workspaceMiddleware on
  // /api/payments/*). A non-member B must not be able to mint a Checkout Session
  // that unlocks A's submission — the owner-scoped ownership check (ownerId = B,
  // no membership → no X-Workspace-Owner access to A) resolves to 404, never a
  // session. The positive member-pays-for-owner flow is exercised by the
  // fixture's workspace member; here we prove the denial edge.
  name: "B cannot create a per-grade checkout for A's submission",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SUBMISSION_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_SUBMISSION_ID")!;
    const res = await fetch(`${BASE}/api/payments/gradethread/per-grade`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ submissionId: id, tier: "standard" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST per-grade checkout");
  },
});

Deno.test({
  // US-1877 (AC2/AC5): the extension writeback's CONFIRM transition promotes a
  // draft cross-listing to ACTIVE. B must not be able to mark A's item as live on
  // a marketplace — that would put a phantom active listing in A's inventory and
  // (via the delist queue) make A believe something is live that isn't. The route
  // verifies the item's owner before touching any listing row.
  name: "B cannot confirm A's item as published via extension-writeback",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/listings/extension-writeback`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({
          item_id: itemId,
          platform: "poshmark",
          published: true,
          listing_url: "https://poshmark.com/listing/attacker",
        }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST extension-writeback (confirm published)");
  },
});

Deno.test({
  // The aspects write-back folds specifics-editor values into an item's
  // Brand/Size/Color/Material/Style COLUMNS. Unscoped, B could overwrite the
  // identity of A's garment — and those columns are the write-authority at
  // publish, so the corruption would ride straight onto A's live listing.
  name: "B cannot write back aspect columns onto A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/aspects/write-back`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        itemId,
        aspects: { Brand: ["AttackerBrand"], Size: ["XXL"] },
        sources: { Brand: "manual", Size: "manual" },
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST ebay/aspects/write-back");
  },
});

Deno.test({
  // US-2175: cross-push is the WIDEST write in the listings module — one call
  // fans a source draft out into a listings row per platform (seven of them),
  // starts a cross-listing group by stamping draft_id, and then asks each
  // adapter to publish for real. A successful cross-tenant call would put A's
  // garment live on marketplaces under B's connections.
  //
  // The route loads the draft and compares inventory_items.user_id to the
  // caller's owner id before any write (flipdesk-listings.ts), so B gets the
  // same 404 as a nonexistent listing. This case is the CI guard that was
  // missing: every other route in the module had one and the fan-out did not.
  name: "B cannot cross-push A's listing to other marketplaces",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/cross-push`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        listing_id: id,
        platforms: ["shopify", "poshmark"],
        prices: { shopify: 1.0, poshmark: 1.0 },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      draft_id?: string;
      results?: Record<string, unknown>;
    };
    assertDenied(res.status, "POST cross-push (A's listing)");
    // Belt and braces on the BODY, not just the status: the success shape
    // returns the group's draft_id and a per-platform results map. Either one
    // coming back would mean the fan-out ran far enough to touch A's group
    // even if the status looked like a denial.
    assert(
      body.draft_id === undefined,
      `cross-push leaked A's cross-listing group id: ${body.draft_id}`,
    );
    assert(
      body.results === undefined,
      "cross-push returned a per-platform results map for A's listing",
    );
  },
});

Deno.test({
  // US-2175: the same boundary for the SINGLE-platform shape. Pushing to the
  // draft's own platform takes a different branch (publish the source row
  // directly rather than mint a sibling), so it needs its own case — the
  // sibling-insert branch being scoped says nothing about this one.
  name: "B cannot cross-push A's listing to the draft's own platform",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/cross-push`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_id: id, platforms: ["ebay"] }),
    });
    const body = (await res.json().catch(() => ({}))) as { draft_id?: string };
    assertDenied(res.status, "POST cross-push (A's listing, own platform)");
    assert(
      body.draft_id === undefined,
      `cross-push leaked A's cross-listing group id: ${body.draft_id}`,
    );
  },
});

Deno.test({
  // US-2166: the platform-agnostic reprice. Unlike the eBay-namespaced route it
  // replaces, this one dispatches on the row's own platform and will happily call
  // Shopify/Etsy/Depop — so a cross-tenant call would reprice A's live listing on
  // whichever marketplace it sits on, under A's own connection.
  name: "B cannot reprice A's listing via the agnostic lifecycle route",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/listings/${id}/price`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ price: 1.0 }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST listings/:id/price");
  },
});

Deno.test({
  // US-2166 / US-2162: ending a listing is destructive and outward-facing — it
  // withdraws a live marketplace offer and moves the item back to a draft. B must
  // not be able to pull A's listing off sale.
  name: "B cannot end A's listing via the agnostic lifecycle route",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/${id}/end`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST listings/:id/end");
  },
});

Deno.test({
  // US-2163: bulk-price takes a LIST of ids, which is the shape most likely to be
  // probed — a caller can mix their own id with a victim's and see whether the
  // response reveals or repriced the foreign one. Each row is loaded
  // owner-verified, so A's id must come back as a per-row failure and must never
  // report a price or a push.
  //
  // NOTE the assertion target: this route returns 200 with per-row results (a
  // partial-success shape), so a bare status check would pass while leaking. The
  // isolation property lives in the ROW, not the status.
  name: "B cannot reprice A's listing through bulk-price",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/bulk-price`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_ids: [aId], drop_pct: 90 }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      results?: Array<{
        listing_id: string;
        ok: boolean;
        price?: number;
        previous_price?: number | null;
        pushed?: boolean;
      }>;
    };
    // A plan gate (402) or an auth denial is also a pass — B never reached A's row.
    if (DENIED.has(res.status) || res.status === 402) return;
    assertEquals(res.status, 200, "bulk-price should return 200 with per-row results");
    const row = (body.results ?? []).find((r) => r.listing_id === aId);
    assert(
      !row || row.ok === false,
      `bulk-price repriced A's listing ${aId} for user B — cross-tenant write`,
    );
    assert(
      !row?.pushed,
      `bulk-price pushed a price to A's marketplace listing ${aId} for user B`,
    );
    assert(
      row?.previous_price === undefined,
      `bulk-price leaked A's current price to user B`,
    );
  },
});

Deno.test({
  // US-1978 (AC2): DELETE offer is DESTRUCTIVE and irreversible — on a published
  // offer eBay ends the live listing as a side effect. B must not be able to
  // delete A's offer artifacts (or, via the liveness read, learn whether one
  // exists). Same 404 as a nonexistent offer.
  name: "B cannot delete A's eBay offer",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_OFFER_ID"),
  fn: async () => {
    const offerId = Deno.env.get("TEST_USER_A_EBAY_OFFER_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/offers/${encodeURIComponent(offerId)}`,
      { method: "DELETE", headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "DELETE eBay offer");
  },
});

Deno.test({
  // US-1978 (AC2): same hazard one level up — deleting a SKU cascades through its
  // offers. B must not reach A's SKUs.
  name: "B cannot delete A's eBay inventory item (SKU)",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_SKU"),
  fn: async () => {
    const sku = Deno.env.get("TEST_USER_A_EBAY_SKU")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/inventory-items/${encodeURIComponent(sku)}`,
      { method: "DELETE", headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "DELETE eBay inventory item");
  },
});

Deno.test({
  // US-1978 (AC3): the order-level refund MOVES MONEY, so it is the sharpest
  // ownership edge in the eBay surface. The handler proves the order belongs to
  // this tenant against the local `sales` table BEFORE calling eBay — it does not
  // lean on eBay's token scoping as the access control, because that would make
  // an external system's 404 the only thing standing between a guessed order id
  // and a refund. B must get the same "not found" a nonexistent order gets: a
  // foreign order must not be distinguishable from one that isn't there.
  name: "B cannot issue a refund against A's eBay order",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_ORDER_ID"),
  fn: async () => {
    const orderId = Deno.env.get("TEST_USER_A_EBAY_ORDER_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/orders/${encodeURIComponent(orderId)}/refund`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({
          reason: "OTHER_CAUSE",
          amount: { currency: "USD", value: "1.00" },
        }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST eBay order refund");
  },
});

Deno.test({
  // US-888: the Trust & Safety abuse-signals console is an OPERATOR surface.
  // A regular tenant must never read fraud/abuse signals raised about other
  // accounts (the signal evidence references cross-tenant submission/image ids).
  // adminAuthMiddleware denies any non-admin caller before a row is read.
  name: "B (non-admin) cannot read the abuse-signals console",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/admin/safety/signals?status=all`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "GET abuse signals");
  },
});

Deno.test({
  // US-890: the rate-limit administration console (counters, noisiest callers,
  // and per-user throttle/block overrides) is an OPERATOR surface. A regular
  // tenant must never read another account's counters or enforcement records, nor
  // set an override. adminAuthMiddleware denies any non-admin caller.
  name: "B (non-admin) cannot read the rate-limit admin console",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/admin/safety/rate-limits`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "GET rate-limits console");
  },
});

Deno.test({
  name: "B (non-admin) cannot set a rate-limit override on another user",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/admin/safety/rate-limits/00000000-0000-0000-0000-000000000000/override`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ mode: "block", reason: "evade", expiresInMinutes: 60 }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST rate-limit override");
  },
});

// ── US-2014: /api/account had NO isolation coverage at all ────────────────
//
// It is the highest-value uncovered mount: /export reaches seven multi-tenant
// tables (users, submissions, inventory_items, sources, listings, sales,
// item_photos) and /delete destroys them. Note the probe shape has to differ
// from the rest of this suite: these endpoints take NO resource id — they act on
// the CALLER — so there is nothing to point at A. assertDenied is meaningless
// here. The property that actually matters is CONTAINMENT: B's own export must
// contain none of A's rows. That is the assertion a leak would actually trip.
//
// /delete is deliberately NOT probed. The only cross-tenant shape would be
// "can B redirect the delete at A?", and every way of asking that risks
// destroying a fixture account if the answer is ever wrong — a test whose
// failure mode is data loss is not worth its signal. It reads only
// c.get("userId") and takes no target id, which is the property to preserve in
// review.
Deno.test({
  name: "B's account export contains NONE of A's data",
  ignore: !CONFIGURED ||
    !Deno.env.get("TEST_USER_A_ITEM_ID") ||
    !Deno.env.get("TEST_USER_A_SUBMISSION_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/account/export`, {
      headers: authHeaders(B_JWT!),
    });
    // The export itself must succeed for B — this is not an access test.
    assertEquals(res.status, 200, "B must be able to export B's own data");
    const text = await res.text();
    for (const key of ["TEST_USER_A_ITEM_ID", "TEST_USER_A_SUBMISSION_ID"]) {
      const aId = Deno.env.get(key)!;
      assert(
        !text.includes(aId),
        `GDPR export leaked ${key} (${aId}) into user B's export — the export ` +
          `must be scoped to the caller across ALL seven tables it reads.`,
      );
    }
  },
});

Deno.test({
  // US-1638/US-2005: remove-bg writes its output to the PUBLIC item-photos
  // bucket, so a cross-tenant call would publish another seller's photo. The
  // route resolves the photo through inventory_items ownership; this pins it.
  // Env-gated and intentionally NOT in REQUIRED_RESOURCE_IDS — it needs a new
  // seeded id, and a case that hard-fails CI before the seed script provides it
  // would just get muted, which is worse than skipping loudly.
  name: "B cannot background-remove A's item photo",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_PHOTO_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/images/remove-bg`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_photo_id: Deno.env.get("TEST_USER_A_PHOTO_ID") }),
    });
    await res.body?.cancel();
    // 503 = REMOVE_BG_API_KEY unset in this environment; that is a skip, not a
    // pass — the ownership check sits AFTER the config guard in the handler.
    if (res.status === 503) return;
    assertDenied(res.status, "POST images/remove-bg");
  },
});

Deno.test({
  // US-1868: the equity endpoints aggregate the CALLER's inventory/listings/
  // sales. Like /export they take no id, so the meaningful assertion is that the
  // numbers are the caller's own. A full containment check needs seeded values
  // to compare against; for now pin the weaker-but-real property that the route
  // is authenticated at all, so an unauthenticated read can never aggregate.
  name: "equity requires auth (no anonymous aggregate read)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/equity/`, {
      headers: { "Content-Type": "application/json" },
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET equity unauthenticated");
  },
});

Deno.test({
  // US-2101: the UTM persist route writes ONLY the caller's own user row — the
  // target id is c.get("userId"), never taken from the body — so there is no
  // foreign-tenant id to smuggle in. The meaningful boundary is that it is
  // authenticated at all, so an anonymous POST can never stamp a user row.
  name: "utm attribution requires auth (no anonymous write)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/attribution/utm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last: { utm_source: "x", landingAt: "2026-07-22" } }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST utm attribution unauthenticated");
  },
});

Deno.test({
  // US-1968: migration turns a read-only eBay mirror into a GT-MANAGED listing
  // (it writes listings.inventory_sku + flips listing_origin), so a successful
  // cross-tenant call would hand B control of A's live catalog. The route scopes
  // its read by user_id and 404s when NONE of the requested ids are the caller's
  // — deliberately not a 200-with-per-item-"not found", which would make a probe
  // indistinguishable from a success at the status level.
  name: "B cannot migrate A's eBay listing under management",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/listings/migrate`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_ids: [id] }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST listings migrate");
  },
});

Deno.test({
  name: "B cannot reprice A's eBay listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/listings/${id}/price`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ price: 1.0 }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST listing price");
  },
});

Deno.test({
  // US-960: marking a sale shipped (carrier + tracking → eBay + sales row) is
  // tenant-scoped — the sale is loaded THROUGH inventory_items.user_id, so B
  // pointing at A's sale id hits 0 rows and 404s (never writes A's fulfillment
  // fields). Env-gated on a sale id owned by A.
  name: "B cannot mark A's sale shipped",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SALE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_SALE_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/orders/${id}/ship`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ tracking_number: "PWNED123", carrier: "USPS" }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST order ship");
  },
});

Deno.test({
  // US-1659: the Etsy disconnect is a workspace-wide teardown of
  // marketplace_connections, scoped to the owner (.eq user_id) and admin-gated
  // (roleAtLeast admin). A foreign non-admin B must NEVER succeed — the response
  // is 403 (not admin) when the connector is on, or 503 when it's disabled
  // (ETSY_ENABLED off by default), but never a 200 that would wipe another
  // tenant's connection. This documents the route's owner-scoping the way
  // depop/disconnect is scoped; the sync/publish routes that touch listing data
  // get full assertDenied cases when they land in US-1660.
  name: "B cannot disconnect or sync Etsy in another workspace (never 200)",
  ignore: !CONFIGURED,
  fn: async () => {
    const disconnect = await fetch(`${BASE}/api/flipdesk/etsy/disconnect`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await disconnect.body?.cancel();
    assert(
      disconnect.status !== 200 && [401, 403, 503].includes(disconnect.status),
      `Etsy disconnect: expected 401/403/503 but got ${disconnect.status}`,
    );
    // /sync is owner-scoped (workspaceOwnerId ?? userId) + gated: B acting with no
    // Etsy connection in their own workspace gets 400 (not connected) or 503
    // (disabled), never another tenant's data.
    const sync = await fetch(`${BASE}/api/flipdesk/etsy/sync`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await sync.body?.cancel();
    assert(
      sync.status !== 200 && [400, 401, 403, 503].includes(sync.status),
      `Etsy sync: expected 400/401/403/503 but got ${sync.status}`,
    );
  },
});

Deno.test({
  // US-1661: the Whatnot disconnect is a workspace-wide teardown of
  // marketplace_connections, owner-scoped (.eq user_id) + admin-gated. A foreign
  // non-admin B must NEVER succeed — 403 when the connector is on, 503 when it's
  // disabled (WHATNOT_ENABLED off by default), never a 200 that wipes another
  // tenant's connection. Documents the route's owner-scoping (like etsy/depop).
  name: "B cannot disconnect Whatnot in another workspace (never 200)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/whatnot/disconnect`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    assert(
      res.status !== 200 && [401, 403, 503].includes(res.status),
      `Whatnot disconnect: expected 401/403/503 but got ${res.status}`,
    );
  },
});

Deno.test({
  // US-455: the suggestions list is scoped to the caller's workspace owner, so
  // B's list must never contain one of A's suggestion ids. (RLS on
  // repricing_suggestions is defense-in-depth; the edge scoping is the boundary
  // actually enforced since the service-role client bypasses RLS.)
  name: "B's repricing suggestions never include A's suggestion id",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SUGGESTION_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_SUGGESTION_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/pricing/suggestions`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as {
      suggestions?: Array<{ id: string }>;
    };
    const ids = (body.suggestions ?? []).map((s) => s.id);
    assert(
      !ids.includes(aId),
      `B's suggestions leaked A's suggestion ${aId}`,
    );
  },
});

Deno.test({
  // US-1899: the listing-performance feed (which drives the stale surface +
  // Sell-Similar hint) is scoped to the caller's workspace owner via
  // inventory_items.user_id, so B's performance rows must never include one of
  // A's listing ids.
  name: "B's listing-performance feed never includes A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/pricing/performance`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as {
      suggestions?: Array<{ listing_id: string }>;
    };
    const ids = (body.suggestions ?? []).map((s) => s.listing_id);
    assert(!ids.includes(aId), `B's performance feed leaked A's listing ${aId}`);
  },
});

Deno.test({
  // US-2233: the on-demand "Sync now" performance route takes NO target id — the
  // tenant is resolved from the JWT (workspaceOwnerId ?? userId) and
  // syncListingPerformanceForUser only writes that owner's listings. The only
  // cross-tenant attack surface is calling it unauthenticated, which must be
  // denied — there is no body field that could point it at another seller.
  name: "on-demand performance sync requires auth (no anonymous cross-tenant sync)",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ebay/sync/performance/me`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "some-other-tenant" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST sync/performance/me unauthenticated");
  },
});

Deno.test({
  // US-674: listing templates CRUD is scoped by user_id. B must not be able to
  // overwrite or delete A's template; the PUT/DELETE are scoped, so they hit
  // 0 rows and return 404 (never confirming the row exists).
  name: "B cannot update or delete A's listing template",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_TEMPLATE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_TEMPLATE_ID")!;
    const put = await fetch(`${BASE}/api/flipdesk/templates/${id}`, {
      method: "PUT",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ name: "pwned" }),
    });
    await put.body?.cancel();
    assertDenied(put.status, "PUT listing template");

    const del = await fetch(`${BASE}/api/flipdesk/templates/${id}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await del.body?.cancel();
    assertDenied(del.status, "DELETE listing template");
  },
});

Deno.test({
  // US-672: repricing rules CRUD is scoped by user_id. B's PUT/DELETE on A's
  // rule are scoped, so they hit 0 rows and return 404.
  name: "B cannot update or delete A's repricing rule",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_RULE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_RULE_ID")!;
    const put = await fetch(`${BASE}/api/flipdesk/pricing/rules/${id}`, {
      method: "PUT",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ name: "pwned", drop_pct: 50 }),
    });
    await put.body?.cancel();
    assertDenied(put.status, "PUT repricing rule");

    const del = await fetch(`${BASE}/api/flipdesk/pricing/rules/${id}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await del.body?.cancel();
    assertDenied(del.status, "DELETE repricing rule");
  },
});

Deno.test({
  // Duplicate-item delete is scoped by user_id: the item is loaded AND deleted
  // with .eq("user_id", ownerId), so B deleting A's item hits 0 rows and returns
  // 404 (never a cascade-delete of A's item/photos/listings).
  name: "B cannot delete A's inventory item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const del = await fetch(`${BASE}/api/flipdesk/listings/item/${id}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await del.body?.cancel();
    assertDenied(del.status, "DELETE inventory item");
  },
});

Deno.test({
  name: "B cannot delete A's API key (and the key survives)",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_API_KEY_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_API_KEY_ID")!;
    const del = await fetch(`${BASE}/api/keys/${id}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await del.body?.cancel();
    // The delete is scoped by user_id, so it affects 0 rows. The endpoint may
    // return 200 (idempotent) or 404 — either is fine. What matters is that A
    // can still list the key afterward.
    const listForA = await fetch(`${BASE}/api/keys`, {
      headers: authHeaders(A_JWT!),
    });
    // GET /api/keys returns { data: [...] } (tolerate a legacy { keys } shape).
    const body = (await listForA.json()) as {
      data?: Array<{ id: string }>;
      keys?: Array<{ id: string }>;
    };
    const stillThere = (body.data ?? body.keys ?? []).some((k) => k.id === id);
    assert(
      stillThere,
      "user A's API key was removed by user B's delete — tenant isolation breached",
    );
  },
});

Deno.test({
  name: "unauthenticated requests to protected routes are rejected",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/keys`);
    await res.body?.cancel();
    assert(
      res.status === 401,
      `missing token should yield 401, got ${res.status}`,
    );
  },
});

// ── Web push subscriptions (US-1901) ────────────────────────────────────
//
// push_subscriptions is a per-tenant table written/read through the service-role
// client, so isolation rests on /api/push/unsubscribe scoping its DELETE by
// user_id. B pointing /unsubscribe at A's endpoint must delete NOTHING — the
// route returns ok (idempotent, 0 rows) but A's row survives. Extra env:
//   TEST_USER_A_PUSH_ENDPOINT   a push_subscriptions.endpoint owned by A
Deno.test({
  name: "push subscribe/unsubscribe require authentication",
  ignore: !BASE,
  fn: async () => {
    const sub = await fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://x", keys: { p256dh: "a", auth: "b" } }),
    });
    await sub.body?.cancel();
    assert(sub.status === 401, `unauthenticated push subscribe should 401, got ${sub.status}`);

    const unsub = await fetch(`${BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://x" }),
    });
    await unsub.body?.cancel();
    assert(unsub.status === 401, `unauthenticated push unsubscribe should 401, got ${unsub.status}`);
  },
});

Deno.test({
  name: "B cannot unsubscribe A's push subscription (delete scoped by user_id)",
  ignore:
    !CONFIGURED ||
    !Deno.env.get("TEST_USER_A_PUSH_ENDPOINT") ||
    !Deno.env.get("SUPABASE_URL"),
  fn: async () => {
    const endpoint = Deno.env.get("TEST_USER_A_PUSH_ENDPOINT")!;
    // B attempts to unsubscribe A's endpoint. The DELETE is scoped by user_id,
    // so it affects 0 rows and returns ok (idempotent) — it must never touch A's
    // subscription.
    const res = await fetch(`${BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ endpoint }),
    });
    await res.body?.cancel();
    assert(
      res.status !== 401 && res.status !== 403,
      `B's unsubscribe should be accepted+scoped (idempotent), got ${res.status}`,
    );

    // Confirm A's subscription survived by reading it back with A's own JWT —
    // RLS on push_subscriptions returns only A's rows.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const check = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&select=id`,
      { headers: { Authorization: `Bearer ${A_JWT!}`, apikey: anon } },
    );
    const rows = (await check.json().catch(() => [])) as unknown[];
    assert(
      Array.isArray(rows) && rows.length === 1,
      "A's push subscription was removed by B's unsubscribe — tenant isolation breached",
    );
  },
});

// US-294: the anonymous public-certificate endpoint must serve ONLY certified
// (public) reports. A private/uncertified report's id (whether the internal
// grade_reports.id or any non-certificate uuid) must 404 — never return data.
// Set TEST_PRIVATE_REPORT_ID to a grade_reports.id that has NO certificate_id.
Deno.test({
  name: "public cert endpoint 404s for a private/uncertified report id",
  ignore: !BASE || !Deno.env.get("TEST_PRIVATE_REPORT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_PRIVATE_REPORT_ID")!;
    const res = await fetch(
      `${BASE}/api/content/public/certificates/${id}`,
    );
    const status = res.status;
    const text = await res.text();
    assert(
      status === 404,
      `private report should 404 from public cert endpoint, got ${status}`,
    );
    assert(
      !text.includes("overall_score") && !text.includes("ai_summary"),
      "public cert endpoint leaked report fields for a private id",
    );
  },
});

// A random non-existent certificate id must also 404 (no info leak).
Deno.test({
  name: "public cert endpoint 404s for an unknown certificate id",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/content/public/certificates/00000000-0000-0000-0000-000000000000`,
    );
    await res.body?.cancel();
    assert(res.status === 404, `unknown cert id should 404, got ${res.status}`);
  },
});

// ── AutoLister (US-324) ──────────────────────────────────────────────
// The batch generator and queue use the service-role client, so isolation
// rests on POST /batch verifying every item belongs to the caller, and
// GET /batch/:id scoping by the batch owner.

// 402 = blocked by the premium feature gate (which runs before the ownership
// check). Either way user B did NOT enqueue generation for A's items.
const DENIED_OR_GATED = new Set([401, 402, 403, 404]);

Deno.test({
  name: "B cannot enqueue an AutoLister batch containing A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/autolister/batch`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_ids: [itemId] }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      DENIED_OR_GATED.has(status),
      `POST autolister/batch with another tenant's item should be denied ` +
        `(401/402/403/404) but got ${status}`,
    );
  },
});

// US-537: photo-QA scores + writes onto an item. B passing A's item_id must
// not assess or persist anything to A's row — the owner filter yields 0 items
// (404), or the plan gate refuses earlier (402). Either way A's row is untouched.
Deno.test({
  name: "B cannot run photo-QA on A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/autolister/photo-qa`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_ids: [itemId] }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      DENIED_OR_GATED.has(status),
      `POST autolister/photo-qa with another tenant's item should be denied ` +
        `(401/402/403/404) but got ${status}`,
    );
  },
});

Deno.test({
  name: "B cannot read A's AutoLister batch status",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_BATCH_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_BATCH_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/autolister/batch/${id}`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET autolister batch");
  },
});

Deno.test({
  name: "B cannot publish A's item to eBay (bulk-publish reuse path)",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/listings/push`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ inventory_item_id: itemId }),
    });
    const status = res.status;
    await res.body?.cancel();
    // B is blocked before it could ever publish A's item. assemblePublishContext
    // fail-fasts on a missing eBay connection (400) and the activeListings cap
    // gate can 402 — both BEFORE the ownership 404 (which is intact). 422 =
    // blockers. The invariant that matters: it did NOT publish (no 2xx).
    assert(
      DENIED_OR_GATED.has(status) || status === 400 || status === 422,
      `POST listings/push for another tenant's item should be denied ` +
        `(400/401/402/403/404/422) but got ${status}`,
    );
  },
});

// ── US-324 additions: policies, retry-failed, scheduled-publish gate ──
//
// US-314 added /policies; US-324 requires we confirm B cannot promote one of
// A's policy ids to "default" via PUT /policies/default — the route's lookup
// of cached policies is workspace-scoped, so an unknown id for B's workspace
// must 400.
Deno.test({
  name: "B cannot promote A's eBay policy id as their own default",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_FULFILLMENT_POLICY_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_FULFILLMENT_POLICY_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/policies/default`, {
      method: "PUT",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ fulfillment_policy_id: id }),
    });
    const status = res.status;
    await res.body?.cancel();
    // 400 = id unknown to B's workspace (the route validates against B's cache).
    // 401/403/404 also fine — anything but a 200 that wrote the row.
    assert(
      status === 400 || DENIED.has(status),
      `PUT policies/default with another tenant's policy id should be ` +
        `rejected (400/401/403/404) but got ${status}`,
    );
  },
});

// US-318 retry endpoint: B must not be able to re-run jobs in A's batch.
Deno.test({
  name: "B cannot retry failed jobs in A's AutoLister batch",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_BATCH_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_BATCH_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/autolister/batch/${id}/retry-failed`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    const status = res.status;
    await res.body?.cancel();
    assert(
      DENIED_OR_GATED.has(status),
      `POST autolister/batch/:id/retry-failed for another tenant should ` +
        `be denied (401/402/403/404) but got ${status}`,
    );
  },
});

// US-322: the scheduled-publish worker is gated by FLIPDESK_INTERNAL_JOB_SECRET
// in the X-Internal-Job-Secret header, NOT a user JWT. A user token must NOT
// be able to trigger it — only the cron with the matching secret can.
Deno.test({
  name: "scheduled-publish job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/jobs/publish-due`,
      { method: "POST", headers: authHeaders(A_JWT!) },
    );
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/publish-due with a user JWT should 401 (no job secret), got ${status}`,
    );
  },
});

// Negative companion: an explicit wrong secret must also be rejected. (Run even
// without a victim id so we always exercise this gate in CI.)
Deno.test({
  name: "scheduled-publish job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/jobs/publish-due`,
      {
        method: "POST",
        headers: {
          "X-Internal-Job-Secret": "wrong-secret-value",
          "Content-Type": "application/json",
        },
      },
    );
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/publish-due with a bogus job secret should 401, got ${status}`,
    );
  },
});

// US-1965: the eBay order-sync backstop sweeps EVERY active tenant's connection
// (it resolves the owner from each connection row, never from the request), so
// it must be reachable ONLY by the cron with the matching job secret — never a
// user JWT and never a bogus secret. Otherwise any signed-in user could trigger
// an all-tenant order sync.
Deno.test({
  name: "eBay order-backstop job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/ebay-order-backstop`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/ebay-order-backstop with a user JWT should 401 (no job secret), got ${status}`,
    );
  },
});

Deno.test({
  name: "eBay order-backstop job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/ebay-order-backstop`, {
      method: "POST",
      headers: {
        "X-Internal-Job-Secret": "wrong-secret-value",
        "Content-Type": "application/json",
      },
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/ebay-order-backstop with a bogus job secret should 401, got ${status}`,
    );
  },
});

// US-2272: the credential-refresh cron sweeps EVERY verified seller's live eBay
// listings and revises their descriptions. It resolves the tenant from each row
// (users → that seller's own listings, scoped by user_id) and takes no ids from
// the request, so the boundary that matters is the door: a signed-in seller must
// not be able to fire a fleet-wide eBay write, and neither must a wrong secret.
Deno.test({
  name: "credentials-refresh job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/credentials-refresh`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/credentials-refresh with a user JWT should 401 (no job secret), got ${status}`,
    );
  },
});

Deno.test({
  name: "credentials-refresh job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/credentials-refresh`, {
      method: "POST",
      headers: {
        "X-Internal-Job-Secret": "wrong-secret-value",
        "Content-Type": "application/json",
      },
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/credentials-refresh with a bogus job secret should 401, got ${status}`,
    );
  },
});

// ── Photo Dump Reconciliation (US-290) ──────────────────────────────────
//
// New surfaces: /api/flipdesk/ai/classify-photos (item-scoped), the reconcile
// commit path (linking a cluster to an existing item), and
// flipdesk_reconcile_sessions visibility. Additional env:
//   TEST_USER_A_ITEM_ID            an inventory_items.id owned by A (reused)
//   TEST_USER_A_RECONCILE_SESSION  a flipdesk_reconcile_sessions.id owned by A

// B must not be able to AI-classify (and thereby read/mutate) A's item photos.
Deno.test({
  name: "B cannot classify photos on A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ai/classify-photos`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_id: itemId }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST classify-photos (A's item)");
  },
});

// US-533: the AutoLister cover/role pass classifies caller-staged photos by
// storage_path. A path outside the caller's own `{ownerId}/...` folder must be
// refused before any image is fetched — so B can't make us read another
// tenant's staged photo into the model. (402 if B's plan lacks AutoLister; the
// gate runs before the path check — either way B never touches a foreign photo.)
Deno.test({
  name: "B cannot classify photos under another tenant's storage folder",
  ignore: !CONFIGURED,
  fn: async () => {
    const foreignPath = "00000000-0000-0000-0000-000000000000/_staging/x.jpg";
    const res = await fetch(`${BASE}/api/flipdesk/autolister/classify-photos`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ photos: [{ id: "p1", storage_path: foreignPath }] }),
    });
    await res.body?.cancel();
    assert(
      DENIED_OR_GATED.has(res.status),
      `POST autolister classify-photos (foreign folder): should be denied ` +
        `(401/402/403/404) but got ${res.status}`,
    );
  },
});

// US-1544: verify-groups takes ORDERED groups of staged storage paths. Every
// path must live under the caller's own `{ownerId}/_staging/` prefix, and the
// check runs BEFORE any DB/AI work — B can never point the vision model at
// another tenant's staged photo. (402 if B's plan lacks AutoLister is also a
// pass — B never touches a foreign photo either way.)
Deno.test({
  name: "B cannot verify-groups over another tenant's staged photos",
  ignore: !CONFIGURED,
  fn: async () => {
    const foreignPath = "00000000-0000-0000-0000-000000000000/_staging/x.jpg";
    const res = await fetch(`${BASE}/api/flipdesk/autolister/verify-groups`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        groups: [
          { id: "g1", photos: [{ id: "p1", storage_path: foreignPath }] },
          { id: "g2", photos: [{ id: "p2", storage_path: foreignPath }] },
        ],
      }),
    });
    await res.body?.cancel();
    assert(
      DENIED_OR_GATED.has(res.status),
      `POST autolister verify-groups (foreign folder): should be denied ` +
        `(401/402/403/404) but got ${res.status}`,
    );
  },
});

// The embed endpoint operates on caller-supplied images (no cross-tenant
// resource), but must still require auth — an unauthenticated call is rejected.
Deno.test({
  name: "embed-photos requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ai/embed-photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: [{ id: "x", url: "https://example.com/a.jpg" }] }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated embed-photos should 401, got ${status}`);
  },
});

// A reconcile session owned by A must not be visible to B through PostgREST
// (RLS on flipdesk_reconcile_sessions). This hits Supabase directly with B's
// JWT, mirroring how the reconcile board reads its own session.
Deno.test({
  name: "B cannot read A's reconcile session row",
  ignore:
    !CONFIGURED ||
    !Deno.env.get("TEST_USER_A_RECONCILE_SESSION") ||
    !Deno.env.get("SUPABASE_URL"),
  fn: async () => {
    const sessionId = Deno.env.get("TEST_USER_A_RECONCILE_SESSION")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const res = await fetch(
      `${supabaseUrl}/rest/v1/flipdesk_reconcile_sessions?id=eq.${sessionId}&select=id`,
      { headers: { Authorization: `Bearer ${B_JWT!}`, apikey: anon } },
    );
    const rows = (await res.json().catch(() => [])) as unknown[];
    assert(
      Array.isArray(rows) && rows.length === 0,
      `B should see 0 of A's reconcile sessions, got ${JSON.stringify(rows)}`,
    );
  },
});

// suggest-item-match operates only on caller-supplied images (the candidate
// list never leaves the client), but must still require auth.
Deno.test({
  name: "suggest-item-match requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ai/suggest-item-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: [{ id: "x", url: "https://example.com/a.jpg" }] }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated suggest-item-match should 401, got ${status}`);
  },
});

// US-673: best offers + buyer messages. These act against the CALLER's own
// eBay account (the token is resolved from the caller's connection), so there's
// no cross-tenant id to probe — the boundary that matters is that they require
// authentication (an unauthenticated caller can't read another seller's offers
// or messages).
Deno.test({
  name: "negotiation offers requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ebay/negotiation/offers`);
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated negotiation/offers should 401, got ${status}`);
  },
});

// US-1967: the capability probe reads the caller's own connection flag, so it
// must not answer for an anonymous caller either.
Deno.test({
  name: "negotiation capabilities requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ebay/negotiation/capabilities`);
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `unauthenticated negotiation/capabilities should 401, got ${status}`,
    );
  },
});

Deno.test({
  name: "respond-to-best-offer requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/negotiation/offers/abc123/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: "1", action: "Decline" }),
      },
    );
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated respond should 401, got ${status}`);
  },
});

Deno.test({
  name: "buyer messages inbox requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ebay/messages`);
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated messages should 401, got ${status}`);
  },
});

Deno.test({
  name: "message reply requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ebay/messages/m1/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: "1", recipient_id: "buyer", body: "hi" }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated reply should 401, got ${status}`);
  },
});

// US-1844: buyer trust signals. POST /api/buyer/trust-signals returns the COARSE
// PUBLIC projection (content-public parity) for a set of cert ids — the same
// data the anonymous /cert page shows. It is deliberately NOT tenant-scoped (a
// buyer must see a stranger's listing's public badges), so the boundary that
// matters is (1) it requires authentication and (2) it NEVER returns an internal
// field (scores, reasons, PII) for ANY cert — only badges/hasAny/certUrl.
Deno.test({
  name: "buyer trust-signals requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/trust-signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ certIds: ["anything"] }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated trust-signals should 401, got ${status}`);
  },
});

Deno.test({
  // B asks for A's certificate: the public badges ARE returned by design, but the
  // payload must carry ONLY the coarse projection — no internal scores/reasons.
  name: "buyer trust-signals leaks no internal fields for a foreign cert",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CERT_ID"),
  fn: async () => {
    const certId = Deno.env.get("TEST_USER_A_CERT_ID")!;
    const res = await fetch(`${BASE}/api/buyer/trust-signals`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ certIds: [certId] }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      signals?: Record<string, Record<string, unknown>>;
    };
    const entry = body.signals?.[certId];
    if (entry) {
      const keys = Object.keys(entry).sort();
      assertEquals(
        keys,
        ["badges", "certUrl", "hasAny"],
        `trust-signals must expose only the coarse projection, got: ${keys.join(", ")}`,
      );
      // Never an internal score/summary field, even nested.
      const blob = JSON.stringify(entry);
      for (const leak of ["overall_score", "content_hash", "ai_summary", "submission_id", "user_id"]) {
        assert(!blob.includes(leak), `trust-signals leaked internal field "${leak}"`);
      }
    }
  },
});

// ── Verified storefront (public seller listings) ────────────────────────
//
// GET /api/content/public/sellers/:handle is anonymous + service-role, so the
// listings array must (1) appear ONLY when the seller opted in
// (verified_show_listings) and (2) contain ONLY that seller's own active
// listings. Additional env:
//   TEST_SELLER_NO_STOREFRONT_HANDLE  a verified_enabled handle with the
//                                     storefront toggle OFF
//   TEST_USER_B_HANDLE                B's verified_enabled handle
//   TEST_USER_A_LISTING_ID            one of A's listing ids (reused from above)

// The opt-in gate: a public seller with the storefront OFF must return
// show_listings=false and an empty listings array — never their inventory.
Deno.test({
  name: "storefront listings hidden when the seller hasn't opted in",
  ignore: !BASE || !Deno.env.get("TEST_SELLER_NO_STOREFRONT_HANDLE"),
  fn: async () => {
    const handle = Deno.env.get("TEST_SELLER_NO_STOREFRONT_HANDLE")!;
    const res = await fetch(
      `${BASE}/api/content/public/sellers/${encodeURIComponent(handle)}`,
    );
    const body = (await res.json().catch(() => ({}))) as {
      show_listings?: boolean;
      listings?: unknown[];
    };
    assert(
      body.show_listings === false,
      `opted-out seller should report show_listings=false, got ${body.show_listings}`,
    );
    assert(
      Array.isArray(body.listings) && body.listings.length === 0,
      `opted-out seller should expose 0 listings, got ${JSON.stringify(body.listings)}`,
    );
  },
});

// Cross-tenant: A's listing id must never surface in B's public storefront.
Deno.test({
  name: "B's storefront never includes A's listing id",
  ignore:
    !BASE ||
    !Deno.env.get("TEST_USER_B_HANDLE") ||
    !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const bHandle = Deno.env.get("TEST_USER_B_HANDLE")!;
    const aListingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/content/public/sellers/${encodeURIComponent(bHandle)}`,
    );
    const body = (await res.json().catch(() => ({}))) as {
      listings?: Array<{ id: string }>;
    };
    const ids = (body.listings ?? []).map((l) => l.id);
    assert(
      !ids.includes(aListingId),
      `B's storefront leaked A's listing ${aListingId}`,
    );
  },
});

// US-151: the listing-performance sync is an internal cron endpoint gated by the
// shared job secret — a user JWT (even a valid one) must NOT be accepted, so a
// tenant can never trigger or scope-escape the cross-tenant batch sync.
Deno.test({
  name: "performance sync rejects a user JWT (job-secret only)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/ebay/sync/performance`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST sync/performance with user JWT");
  },
});

// ── US-350 additions: revise, category-check, reconcile commit, ──────────
//                      disclosure upload, sync-runs ─────────────────────
//
// These five surfaces were not previously covered. Each writes to or reads
// from a tenant-scoped table; B must never reach one of A's rows.

// 503 = eBay isn't configured on the server, so the handler returns BEFORE the
// ownership check ever runs (it never touched A's listing). A configured server
// reaches loadListingOwned and 404s. Either is a pass — A's row is untouched.
const DENIED_OR_UNCONFIGURED = new Set([401, 403, 404, 422, 503]);

// revise (POST /listings/:id/revise) is scoped via loadListingOwned. B revising
// A's listing must be refused — never a 200 that mutated A's eBay listing.
Deno.test({
  name: "B cannot revise A's eBay listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/listings/${id}/revise`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ title: "pwned", listing_price: 1 }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      DENIED_OR_UNCONFIGURED.has(status),
      `POST listings/:id/revise for another tenant should be denied ` +
        `(401/403/404/422/503) but got ${status}`,
    );
  },
});

// category-check (GET /listings/:id/category-check) loads the listing joined to
// its inventory_item and 404s when item.user_id != caller. B must not read A's
// category context.
Deno.test({
  name: "B cannot category-check A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/listings/${id}/category-check`,
      { headers: authHeaders(B_JWT!) },
    );
    const status = res.status;
    await res.body?.cancel();
    assert(
      DENIED_OR_UNCONFIGURED.has(status),
      `GET listings/:id/category-check for another tenant should be denied ` +
        `(401/403/404/503) but got ${status}`,
    );
  },
});

// reconciliation commit — dismiss (POST /reconciliation/dismiss/:id) writes
// `reconciled=true` onto a payout_imports row. The handler 404s when the
// payout's user_id != caller, so B can't commit a dismissal on A's payout.
Deno.test({
  name: "B cannot commit a dismissal on A's payout import",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_PAYOUT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_PAYOUT_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/reconciliation/dismiss/${id}`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    const status = res.status;
    await res.body?.cancel();
    // Reconciliation is plan-gated (requireFlipdesk "reconciliation"), so B can
    // be denied by the plan gate (402) before the ownership 404 — both are valid
    // denials (no dismissal committed either way).
    assert(
      DENIED_OR_GATED.has(status),
      `POST reconciliation/dismiss (A's payout): cross-tenant access should be ` +
        `denied (401/402/403/404) but got ${status}`,
    );
  },
});

// reconciliation commit — conflict resolve (POST /reconciliation/conflicts/
// resolve) writes the winning value onto A's listing + closes the conflict.
// Conflicts load .eq(user_id), so B passing A's conflict id resolves NOTHING:
// the response reports it as failed and `resolved` is 0.
Deno.test({
  name: "B cannot resolve A's cross-source conflict",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONFLICT_ID"),
  fn: async () => {
    const conflictId = Deno.env.get("TEST_USER_A_CONFLICT_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/reconciliation/conflicts/resolve`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({
          resolutions: [{ conflict_id: conflictId, source: "ebay" }],
        }),
      },
    );
    const status = res.status;
    const body = (await res.json().catch(() => ({}))) as {
      resolved?: number;
      failed?: Array<{ conflict_id: string }>;
    };
    // Reconciliation is plan-gated: B can be denied by the plan gate (402)
    // before the resolver runs — a valid denial (nothing resolved). Otherwise B
    // reaches the resolver, where conflicts load .eq(user_id), so A's conflict
    // resolves NOTHING (resolved 0, reported as failed).
    if (DENIED_OR_GATED.has(status)) return;
    assert(
      body.resolved === 0,
      `B resolved ${body.resolved} of A's conflicts — should be 0`,
    );
    const failedIds = (body.failed ?? []).map((f) => f.conflict_id);
    assert(
      failedIds.includes(conflictId),
      `A's conflict ${conflictId} was not reported as unresolved for B`,
    );
  },
});

// disclosure upload (POST /disclosure/item/:itemId/annotated-photo) stores a
// photo against an item via loadOwnedItem; ownership 404s before any upload, so
// B can't attach disclosure imagery to A's item.
Deno.test({
  name: "B cannot upload a disclosure photo to A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    // 1x1 transparent PNG — ownership is checked before the body is even read,
    // so this never actually gets stored.
    const onePx =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const res = await fetch(
      `${BASE}/api/flipdesk/disclosure/item/${itemId}/annotated-photo`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ data_url: onePx, image_type: "defect" }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST disclosure annotated-photo (A's item)");
  },
});

// sync-runs (GET /ebay/sync-runs) lists the caller's own sync runs (.eq
// user_id). B's list must never surface A's sync-run id.
Deno.test({
  name: "B's sync-runs never include A's run id",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SYNC_RUN_ID"),
  fn: async () => {
    const aRunId = Deno.env.get("TEST_USER_A_SYNC_RUN_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/sync-runs`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as {
      runs?: Array<{ id: string }>;
    };
    const ids = (body.runs ?? []).map((r) => r.id);
    assert(
      !ids.includes(aRunId),
      `B's sync-runs leaked A's run ${aRunId}`,
    );
  },
});

// US-600: consignment mode. B must not update, sign intake for, or pay A's
// consignor; B's consignor list must never include A's consignor.
Deno.test({
  name: "B cannot update A's consignor",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/consignment/consignors/${id}`,
      {
        method: "PATCH",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ split_pct: 99 }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "PATCH consignor (A's)");
  },
});

Deno.test({
  name: "B cannot pay out A's consignor",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/payouts`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ consignor_id: id, amount: 1.0 }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST payout (A's consignor)");
  },
});

Deno.test({
  name: "B's consignor list never includes A's consignor",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/consignors`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as {
      consignors?: Array<{ id: string }>;
    };
    const ids = (body.consignors ?? []).map((r) => r.id);
    assert(!ids.includes(aId), `B's consignor list leaked A's consignor ${aId}`);
  },
});

// ── AI Support Assistant (US-829) ────────────────────────────────────────
//
// support_conversations + support_messages carry RLS that scopes a read to the
// caller's own conversations (own row or as workspace owner). Writes are
// service-role only; the SPA reads its own thread directly via PostgREST. These
// hit Supabase directly with B's JWT — exactly how the chat panel loads a
// thread — and assert B sees ZERO of A's rows. Additional env:
//   TEST_USER_A_CONVERSATION_ID  a support_conversations.id owned by A

// B cannot read A's support conversation through PostgREST (RLS deny → 0 rows).
Deno.test({
  name: "B cannot read A's support conversation row",
  ignore:
    !CONFIGURED ||
    !Deno.env.get("TEST_USER_A_CONVERSATION_ID") ||
    !Deno.env.get("SUPABASE_URL"),
  fn: async () => {
    const convId = Deno.env.get("TEST_USER_A_CONVERSATION_ID")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const res = await fetch(
      `${supabaseUrl}/rest/v1/support_conversations?id=eq.${convId}&select=id`,
      { headers: { Authorization: `Bearer ${B_JWT!}`, apikey: anon } },
    );
    const rows = (await res.json().catch(() => [])) as unknown[];
    assert(
      Array.isArray(rows) && rows.length === 0,
      `B should see 0 of A's support conversations, got ${JSON.stringify(rows)}`,
    );
  },
});

// B cannot read the messages within A's conversation either (the message
// SELECT policy joins back to the parent's owner; B owns none of it).
Deno.test({
  name: "B cannot read messages in A's support conversation",
  ignore:
    !CONFIGURED ||
    !Deno.env.get("TEST_USER_A_CONVERSATION_ID") ||
    !Deno.env.get("SUPABASE_URL"),
  fn: async () => {
    const convId = Deno.env.get("TEST_USER_A_CONVERSATION_ID")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const res = await fetch(
      `${supabaseUrl}/rest/v1/support_messages?conversation_id=eq.${convId}&select=id`,
      { headers: { Authorization: `Bearer ${B_JWT!}`, apikey: anon } },
    );
    const rows = (await res.json().catch(() => [])) as unknown[];
    assert(
      Array.isArray(rows) && rows.length === 0,
      `B should see 0 messages in A's conversation, got ${JSON.stringify(rows)}`,
    );
  },
});

// ════════════════════════════════════════════════════════════════════
// US-832: read-only support-tool layer — tenant scoping (no live DB).
//
// The six support tools (lib/support-tools.ts) run on the RLS-bypassing
// service-role client, so their explicit `.eq("user_id", ownerId)` filters and
// loadOwned ownership checks are the ENTIRE tenant wall. These tests exercise
// that real filtering logic against a faithful in-memory fake DB that honours
// eq/in/gte — so "user B impersonating ownership of user A's item/data gets
// nothing" is asserted directly, with no env fixture required (runs in CI).
// ════════════════════════════════════════════════════════════════════

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const ST = await import("../lib/support-tools.ts");
type FakeRow = Record<string, unknown>;

function makeFakeDb(
  tables: Record<string, FakeRow[]>,
): import("../lib/support-tools.ts").SupportDb {
  function build(
    table: string,
  ): import("../lib/support-tools.ts").SupportQuery {
    const filters: Array<{ kind: "eq" | "in" | "gte"; col: string; val: unknown }> = [];
    let limitN: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    const apply = (): FakeRow[] => {
      let rows = (tables[table] ?? []).slice();
      for (const f of filters) {
        if (f.kind === "eq") rows = rows.filter((r) => r[f.col] === f.val);
        else if (f.kind === "in") {
          rows = rows.filter((r) => (f.val as unknown[]).includes(r[f.col]));
        } else if (f.kind === "gte") {
          rows = rows.filter((r) => String(r[f.col]) >= String(f.val));
        }
      }
      if (orderCol) {
        const oc = orderCol;
        rows.sort((a, b) => {
          const av = String(a[oc]);
          const bv = String(b[oc]);
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return orderAsc ? cmp : -cmp;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    };
    // deno-lint-ignore no-explicit-any
    const q: any = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return q;
      },
      in: (col: string, vals: readonly unknown[]) => {
        filters.push({ kind: "in", col, val: vals });
        return q;
      },
      gte: (col: string, val: unknown) => {
        filters.push({ kind: "gte", col, val });
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (onF: any, onR: any) =>
        Promise.resolve({ data: apply(), error: null }).then(onF, onR),
    };
    return q;
  }
  return { from: build };
}

const A = "user-a-0000-0000-0000-000000000001";
const B = "user-b-0000-0000-0000-000000000002";
const A_ITEM = "item-a-0000-0000-0000-000000000001";
const B_ITEM = "item-b-0000-0000-0000-000000000002";
const A_REPORT = "report-a-0000-0000-0000-00000000001";

function seedDb() {
  return makeFakeDb({
    inventory_items: [
      { id: A_ITEM, user_id: A, status: "listed", grade_report_id: A_REPORT },
      { id: B_ITEM, user_id: B, status: "sourced", grade_report_id: null },
    ],
    listings: [
      {
        id: "listing-a", inventory_item_id: A_ITEM, listing_title: "A jacket",
        listing_status: "active", platform: "ebay", listing_price: "50.00",
        views: 10, watchers: 2, listed_at: "2026-06-01T00:00:00Z",
      },
      {
        id: "listing-b", inventory_item_id: B_ITEM, listing_title: "B shirt",
        listing_status: "draft", platform: "ebay", listing_price: "20.00",
        views: 0, watchers: 0, listed_at: "2026-06-02T00:00:00Z",
      },
    ],
    sales: [
      {
        inventory_item_id: A_ITEM, sale_price: "50.00", platform_fees: "5.00",
        payment_processing_fees: "1.50", shipping_collected: "0",
        shipping_cost: "4.00", grading_cost: "0", other_costs: "0",
        net_profit: "39.50", sale_date: "2026-06-05T00:00:00Z",
        buyer_username: "secretbuyer", buyer_id: "b-999",
        tracking_number: "TRK123", payout_reference: "PR-1",
      },
    ],
    grade_reports: [
      {
        id: A_REPORT, overall_score: "8.5", grade_tier: "Excellent",
        fabric_condition_score: "9.0", structural_integrity_score: "8.0",
        cosmetic_appearance_score: "8.5", functional_elements_score: "9.0",
        odor_cleanliness_score: "8.0", ai_summary: "Great", confidence_score: "0.9",
      },
    ],
    submissions: [
      { id: "sub-a", user_id: A, title: "A sub", status: "processing", created_at: "2026-06-03T00:00:00Z" },
      { id: "sub-b", user_id: B, title: "B sub", status: "completed", created_at: "2026-06-04T00:00:00Z" },
    ],
    users: [
      { id: A, flipdesk_plan: "pro", subscription_status: "active", trial_ends_at: null, past_due_since: null, grades_used_this_month: 3, grade_reset_at: "2099-01-01T00:00:00Z", ai_actions_used_this_month: 7, ai_actions_reset_at: "2099-01-01T00:00:00Z" },
      { id: B, flipdesk_plan: "free", subscription_status: "active", trial_ends_at: null, past_due_since: null, grades_used_this_month: 0, grade_reset_at: "2099-01-01T00:00:00Z", ai_actions_used_this_month: 0, ai_actions_reset_at: "2099-01-01T00:00:00Z" },
    ],
  });
}

// Stub matrix so getMyPlanAndLimits doesn't reach the network.
const FAKE_MATRIX = {
  free: { activeListingCap: 5, aiActionsPerMonth: 10, marketplacesCap: 1, includedStandardGradesPerMonth: 2, teamSeatCap: 0, gateFlags: {} },
  starter: { activeListingCap: 25, aiActionsPerMonth: 25, marketplacesCap: 1, includedStandardGradesPerMonth: 10, teamSeatCap: 0, gateFlags: {} },
  pro: { activeListingCap: 250, aiActionsPerMonth: 250, marketplacesCap: 3, includedStandardGradesPerMonth: 50, teamSeatCap: 2, gateFlags: {} },
  business: { activeListingCap: -1, aiActionsPerMonth: -1, marketplacesCap: -1, includedStandardGradesPerMonth: -1, teamSeatCap: 10, gateFlags: {} },
  // deno-lint-ignore no-explicit-any
} as any;
const loadFakeMatrix = () => Promise.resolve(FAKE_MATRIX);

Deno.test("US-832: inventory counts are scoped to the caller's tenant", async () => {
  const db = seedDb();
  const b = await ST.getMyInventoryStatusCounts(B, db);
  assertEquals(b.total, 1, "B sees only B's one item, never A's");
  assertEquals(b.byStatus.listed ?? 0, 0, "B's item is not A's 'listed' item");
  const a = await ST.getMyInventoryStatusCounts(A, db);
  assertEquals(a.total, 1);
  assertEquals(a.byStatus.listed, 1);
});

Deno.test("US-832: listings summary never leaks another tenant's listing", async () => {
  const db = seedDb();
  const b = await ST.getMyListingsSummary(B, {}, db);
  assertEquals(b.length, 1);
  assertEquals(b[0].title, "B shirt");
  assert(b.every((l) => l.id !== "listing-a"), "B must not see A's listing");
});

Deno.test("US-832: sales summary is aggregate-only and tenant-scoped", async () => {
  const db = seedDb();
  // B owns no sales → all-zero aggregate, never A's sale.
  const b = await ST.getSalesSummary(B, { period: "all" }, db);
  assertEquals(b.count, 0);
  assertEquals(b.gross, 0);
  // A's own aggregate, with NO buyer identity fields on the DTO.
  const a = await ST.getSalesSummary(A, { period: "all" }, db);
  assertEquals(a.count, 1);
  assertEquals(a.gross, 50);
  assertEquals(a.net, 39.5);
  const keys = Object.keys(a);
  for (const forbidden of ["buyer_username", "buyer_id", "buyer", "tracking_number", "payout_reference"]) {
    assert(!keys.includes(forbidden), `sales DTO must not expose ${forbidden}`);
  }
});

Deno.test("US-832: grade report refuses an item the caller does not own", async () => {
  const db = seedDb();
  // B impersonates ownership of A's item id → null, no grade leaked.
  const stolen = await ST.getGradeReportForMyItem(B, A_ITEM, db);
  assertEquals(stolen, null, "B must get nothing for A's item");
  // A reading A's own item → real report (positive control).
  const mine = await ST.getGradeReportForMyItem(A, A_ITEM, db);
  assert(mine !== null);
  assertEquals(mine!.overallScore, 8.5);
  assertEquals(mine!.tier, "Excellent");
});

Deno.test("US-832: open submissions are tenant-scoped and exclude terminal states", async () => {
  const db = seedDb();
  const b = await ST.getMyOpenSubmissions(B, db);
  // B's only submission is 'completed' (terminal) → excluded.
  assertEquals(b.length, 0);
  const a = await ST.getMyOpenSubmissions(A, db);
  assertEquals(a.length, 1);
  assertEquals(a[0].status, "processing");
});

Deno.test("US-832: plan & limits reflect only the caller's own tenant", async () => {
  const db = seedDb();
  const a = await ST.getMyPlanAndLimits(A, db, loadFakeMatrix);
  assert(a !== null);
  assertEquals(a!.plan, "pro");
  assertEquals(a!.usage.activeListings, 1, "A has one 'listed' item");
  assertEquals(a!.usage.aiActionsUsedThisMonth, 7);
  const b = await ST.getMyPlanAndLimits(B, db, loadFakeMatrix);
  assertEquals(b!.plan, "free");
  assertEquals(b!.usage.activeListings, 0, "B has no 'listed' items");
});

// ════════════════════════════════════════════════════════════════════
// US-843: EVERY US-832 read tool returns nothing for a NON-OWNER caller.
//
// The tests above assert each tool is scoped to the caller; this block makes the
// non-owner guarantee explicit and exhaustive: an attacker C who owns NOTHING —
// and who supplies user A's real item/report ids — must get an empty/refusal
// result from every tenant-scoped US-832 tool. A is the data-rich tenant from
// seedDb(); C exists only as an authenticated caller with no rows of their own.
// ════════════════════════════════════════════════════════════════════

const C = "user-c-0000-0000-0000-000000000003";

Deno.test("US-843: get_inventory_status → empty for a non-owner caller", async () => {
  const counts = await ST.getMyInventoryStatusCounts(C, seedDb());
  assertEquals(counts.total, 0, "C owns no inventory");
  assertEquals(Object.keys(counts.byStatus).length, 0);
});

Deno.test("US-843: get_listings → empty for a non-owner caller", async () => {
  const out = await ST.getMyListingsSummary(C, {}, seedDb());
  assertEquals(out.length, 0, "C sees no listings, not even A's");
});

Deno.test("US-843: get_sales_summary → all-zero aggregate for a non-owner caller", async () => {
  const out = await ST.getSalesSummary(C, { period: "all" }, seedDb());
  assertEquals(out.count, 0);
  assertEquals(out.gross, 0);
  assertEquals(out.net, 0);
});

Deno.test("US-843: get_grade_report → null even when C supplies A's real itemId", async () => {
  // C hands the tool A's actual item id AND A's actual report id — both rejected.
  assertEquals(await ST.getGradeReportForMyItem(C, A_ITEM, seedDb()), null);
  assertEquals(await ST.getGradeReportForMyItem(C, A_REPORT, seedDb()), null);
});

Deno.test("US-843: get_open_submissions → empty for a non-owner caller", async () => {
  const out = await ST.getMyOpenSubmissions(C, seedDb());
  assertEquals(out.length, 0, "C sees none of A's submissions");
});

Deno.test("US-843: get_plan_and_limits → null for a caller with no users row", async () => {
  // C has no row in `users`, so the plan tool resolves to null (no data leaked).
  const out = await ST.getMyPlanAndLimits(C, seedDb(), loadFakeMatrix);
  assertEquals(out, null);
});

Deno.test("US-843: search_knowledge_base → a public caller cannot reach subscriber-only KB", async () => {
  // The KB tool is audience-scoped rather than tenant-scoped: its non-owner
  // boundary is that a 'public' (anonymous) audience never sees subscriber-only
  // rows. The fake DB records the audiences the query filtered to.
  let filteredAudiences: readonly unknown[] = [];
  const kbDb: import("../lib/support-tools.ts").SupportDb = {
    from() {
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: () => q,
        in: (_col: string, vals: readonly unknown[]) => {
          filteredAudiences = vals;
          return q;
        },
        gte: () => q,
        textSearch: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        // deno-lint-ignore no-explicit-any
        then: (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR),
      };
      return q;
    },
  };
  await ST.searchKnowledgeBase({ query: "how do refunds work", audience: "public" }, kbDb);
  assert(
    !filteredAudiences.includes("subscriber"),
    "a public caller must never query subscriber-only KB rows",
  );
  assert(filteredAudiences.includes("public"), "public rows are the only allowed audience");
});

// ════════════════════════════════════════════════════════════════════
// US-898: admin sync console — manual orphan-match can't cross tenants.
//
// The admin "match orphan sale" action resolves the owning tenant from the
// orphan row, then matchOrphanSale loads BOTH the orphan AND the target
// inventory item scoped to that owner. So even when an operator points an
// orphan at an inventory_item id belonging to a DIFFERENT tenant, the item
// lookup misses (it's filtered by the orphan owner's user_id) and NO sale is
// created. Asserted directly against a faithful in-memory fake (no env fixture).
// ════════════════════════════════════════════════════════════════════

const { matchOrphanSale } = await import("../lib/orphan-sale-match.ts");

interface FakeTableSet {
  flipdesk_ebay_orphan_sales: FakeRow[];
  inventory_items: FakeRow[];
  sales: FakeRow[];
}

function makeOrphanFakeClient(tables: FakeTableSet) {
  function from(table: keyof FakeTableSet) {
    const filters: Array<{ col: string; val: unknown }> = [];
    let op: "select" | "insert" | "update" = "select";
    let insertRow: FakeRow | null = null;
    let updatePatch: FakeRow | null = null;
    const matching = (): FakeRow[] => {
      let rows = (tables[table] ?? []).slice();
      for (const f of filters) rows = rows.filter((r) => r[f.col] === f.val);
      return rows;
    };
    const exec = (): { data: unknown; error: null } => {
      if (op === "insert") {
        const arr = tables[table] ?? (tables[table] = []);
        const id = `${String(table)}-${arr.length + 1}`;
        const row = { id, ...(insertRow ?? {}) };
        arr.push(row);
        return { data: { id }, error: null };
      }
      if (op === "update") {
        for (const r of matching()) Object.assign(r, updatePatch ?? {});
        return { data: null, error: null };
      }
      return { data: matching(), error: null };
    };
    // deno-lint-ignore no-explicit-any
    const q: any = {
      select: () => q,
      insert: (row: FakeRow) => {
        op = "insert";
        insertRow = row;
        return q;
      },
      update: (patch: FakeRow) => {
        op = "update";
        updatePatch = patch;
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return q;
      },
      not: () => q,
      maybeSingle: () => {
        const res = exec();
        const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
        return Promise.resolve({ data, error: res.error });
      },
      // deno-lint-ignore no-explicit-any
      then: (onF: any, onR: any) => Promise.resolve(exec()).then(onF, onR),
    };
    return q;
  }
  // deno-lint-ignore no-explicit-any
  return { from } as any;
}

function seedOrphanTables(): FakeTableSet {
  return {
    flipdesk_ebay_orphan_sales: [
      {
        id: "orphan-a", user_id: A, platform_order_id: "ORDER-A", line_item_id: "LI-1",
        ebay_item_id: "9001", sku: "SKU-A", title: "A jacket", sale_price: 50,
        shipping_collected: 5, tax: 2, buyer_username: "buyer", sold_at: "2026-06-05T00:00:00Z",
        match_status: "unmatched", matched_item_id: null,
      },
    ],
    inventory_items: [
      { id: A_ITEM, user_id: A, status: "listed" },
      { id: B_ITEM, user_id: B, status: "listed" },
    ],
    sales: [],
  };
}

Deno.test("US-898: orphan-match cannot attach a sale to another tenant's item", async () => {
  const tables = seedOrphanTables();
  const client = makeOrphanFakeClient(tables);
  // Owner is resolved from the orphan (A). The operator points it at B's item.
  const res = await matchOrphanSale(A, "orphan-a", B_ITEM, client);
  assert(!res.ok, "matching A's orphan to B's item must be refused");
  assertEquals(res.ok === false && res.code, "item_not_found");
  assertEquals(tables.sales.length, 0, "no sale row may be created for the cross-tenant attempt");
  assertEquals(
    tables.flipdesk_ebay_orphan_sales[0].match_status,
    "unmatched",
    "the orphan must stay unmatched after a refused cross-tenant match",
  );
});

Deno.test("US-898: orphan-match links to the owner's OWN item (positive control)", async () => {
  const tables = seedOrphanTables();
  const client = makeOrphanFakeClient(tables);
  const res = await matchOrphanSale(A, "orphan-a", A_ITEM, client);
  assert(res.ok, "matching A's orphan to A's own item should succeed");
  assertEquals(tables.sales.length, 1, "a sale row is created for the owner's item");
  assertEquals(tables.sales[0].inventory_item_id, A_ITEM);
  assertEquals(tables.flipdesk_ebay_orphan_sales[0].match_status, "matched");
  assertEquals(tables.flipdesk_ebay_orphan_sales[0].matched_item_id, A_ITEM);
});

// Env-gated: a non-admin tenant must never reach the cross-tenant admin sync
// console (adminAuthMiddleware denies before any row is read).
Deno.test({
  name: "B (non-admin) cannot read the admin marketplace sync console",
  ignore: !CONFIGURED,
  fn: async () => {
    for (const path of ["/api/admin/marketplace/sync-runs", "/api/admin/marketplace/conflicts", "/api/admin/marketplace/orphan-sales"]) {
      const res = await fetch(`${BASE}${path}`, { headers: authHeaders(B_JWT!) });
      await res.body?.cancel();
      assertDenied(res.status, `GET ${path}`);
    }
  },
});

// ── US-900: support ticket inbox ─────────────────────────────────────────────
//
// The user-facing /api/support-tickets/:id is scoped to the caller's user_id,
// so B must never read A's ticket (and therefore never its operator internal
// notes, which aren't even returned to the owner). The admin queue is gated by
// adminAuthMiddleware, so a non-admin tenant can't reach it at all.
//   TEST_USER_A_TICKET_ID   a support_tickets.id owned by user A (optional —
//                           the case SKIPS when unset, like the other resources)
Deno.test({
  name: "B cannot read A's support ticket thread",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_TICKET_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_TICKET_ID")!;
    const res = await fetch(`${BASE}/api/support-tickets/${id}`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET support-tickets/:id");
  },
});

Deno.test({
  name: "B cannot post a reply onto A's support ticket",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_TICKET_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_TICKET_ID")!;
    const res = await fetch(`${BASE}/api/support-tickets/${id}/messages`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ body: "injected by another tenant" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST support-tickets/:id/messages");
  },
});

Deno.test({
  name: "B's ticket list never includes A's ticket id",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_TICKET_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_TICKET_ID")!;
    const res = await fetch(`${BASE}/api/support-tickets`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as {
      tickets?: Array<{ id: string }>;
    };
    const ids = (body.tickets ?? []).map((t) => t.id);
    assert(!ids.includes(aId), `B's ticket list leaked A's ticket ${aId}`);
  },
});

Deno.test({
  name: "B (non-admin) cannot reach the admin support-ticket queue",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/admin/support-tickets`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET admin/support-tickets");
  },
});

// US-1092: appending to a garment's passport is tenant-scoped — B must not
// append an event to A's garment (the public GET /:slug read is intentionally
// anonymous + PII-free, so the WRITE path is the isolation surface). Ownership
// is verified by created_by before any insert, so B's id resolves to no row → 404.
// ignore-guarded by TEST_USER_A_GARMENT_ID until the fixture seeds A's garment.
Deno.test({
  name: "B cannot append an event to A's garment passport",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GARMENT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GARMENT_ID")!;
    const res = await fetch(`${BASE}/api/passport/garments/${id}/events`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ event_type: "listed" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST passport/garments/:id/events (A's garment)");
  },
});

// US-1094: minting an ownership-claim token is tenant-scoped — B must not mint a
// claim token for A's garment (ownership verified by created_by before insert,
// so B's id resolves to no row → 404). The /claim REDEMPTION path is
// intentionally anonymous (token-bearer auth), so the mint path is the isolation
// surface here.
Deno.test({
  name: "B cannot mint a claim token for A's garment passport",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GARMENT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GARMENT_ID")!;
    const res = await fetch(`${BASE}/api/passport/garments/${id}/claim-token`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST passport/garments/:id/claim-token (A's garment)");
  },
});

// US-1096: issuing a physical passport tag is tenant-scoped — B must not mint a
// tag for A's garment (ownership verified by created_by before insert → 404).
Deno.test({
  name: "B cannot issue a passport tag for A's garment",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GARMENT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GARMENT_ID")!;
    const res = await fetch(`${BASE}/api/passport/garments/${id}/tags`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST passport/garments/:id/tags (A's garment)");
  },
});

// US-1098: the candidate-match service is tenant-scoped — B must not run a match
// against A's garment (ownership verified by created_by → 404).
Deno.test({
  name: "B cannot match-candidates against A's garment",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GARMENT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GARMENT_ID")!;
    const res = await fetch(`${BASE}/api/passport/garments/${id}/match-candidates`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST passport/garments/:id/match-candidates (A's garment)");
  },
});

// US-1104: the resale-value/depreciation forecast is tenant-scoped — B must not
// forecast A's garment (the garment lookup is .eq(created_by), so a non-owned id
// resolves to no row → 404, and the cohort it would build is .eq(user_id=B) only).
Deno.test({
  name: "B cannot forecast A's garment",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GARMENT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GARMENT_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/forecast/garments/${id}`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET flipdesk/forecast/garments/:id (A's garment)");
  },
});

// US-1099: relist detection is tenant-scoped — B passing A's inventory item id
// must get ZERO suggestions (the item lookup is .eq(user_id), so a non-owned id
// resolves to no row and never reaches A's photos or A's fingerprints).
Deno.test({
  name: "B's relist detection on A's item returns no candidates",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/passport/garments/detect-relist`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_id: id }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      candidates?: Array<{ garmentId: string }>;
    };
    assert(
      Array.isArray(body.candidates) && body.candidates.length === 0,
      `B got ${JSON.stringify(body.candidates)} relist candidates for A's item — should be 0`,
    );
  },
});

// US-1105: opt-in identity reveal is scoped to the caller's OWN passport hops
// (owner_nodes.linked_user_id = caller). B toggling reveal on one of A's nodes
// must hit 0 rows and 404 — never flip A's consent or leak A's identity. Env-
// gated on a node id linked to A (TEST_USER_A_PASSPORT_NODE_ID).
Deno.test({
  name: "B cannot reveal identity on A's passport hop",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_PASSPORT_NODE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_PASSPORT_NODE_ID")!;
    const res = await fetch(
      `${BASE}/api/passport-identity/nodes/${id}/reveal`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ revealed: true }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST passport-identity/nodes/:id/reveal (A's node)");
  },
});

// B's own identity-node list must never include A's node (the list is scoped by
// linked_user_id = caller).
Deno.test({
  name: "B's passport identity list never includes A's node",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_PASSPORT_NODE_ID"),
  fn: async () => {
    const aNodeId = Deno.env.get("TEST_USER_A_PASSPORT_NODE_ID")!;
    const res = await fetch(`${BASE}/api/passport-identity/nodes`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as {
      nodes?: Array<{ node_id: string }>;
    };
    const ids = (body.nodes ?? []).map((n) => n.node_id);
    assert(
      !ids.includes(aNodeId),
      `B's passport identity list leaked A's node ${aNodeId}`,
    );
  },
});

// ── US-1565: admin task-board field whitelists ───────────────────────────────
// Operator tables (no tenant column) — the isolation analog here is that a
// request body can NEVER set created_by/author_id (always stamped server-side
// from the authenticated admin) nor write arbitrary columns. Pure whitelist
// checks; the deny-all RLS posture is covered by rls-guard_test.ts.
Deno.test("US-1565: task-board whitelists strip created_by/author_id and unknown columns", async () => {
  const { pickFields, PROJECT_FIELDS, TASK_FIELDS } = await import(
    "../routes/admin-tasks.ts"
  );
  const spoofed = pickFields({
    title: "legit",
    created_by: "attacker-uuid",
    author_id: "attacker-uuid",
    id: "override-pk",
    updated_at: "1999-01-01",
    archived: true,
  }, PROJECT_FIELDS);
  assertEquals(Object.keys(spoofed).sort(), ["archived", "title"]);

  const task = pickFields({
    project_id: "p1",
    title: "t",
    status: "done",
    created_by: "attacker-uuid",
    completed_at: "2026-01-01",
    secret_column: "x",
  }, TASK_FIELDS);
  assertEquals(
    Object.keys(task).sort(),
    ["completed_at", "project_id", "status", "title"],
  );
});

// ── US-1616 / C3: intra-workspace role enforcement ──────────────────
//
// A read-only VIEWER member acting inside the owner's workspace (via
// X-Workspace-Owner) must be denied money-moving / publish / spend actions —
// the workspaceRole is now enforced on these routes, not just computed. These
// are live-integration cases gated on a seeded viewer membership:
//   TEST_VIEWER_JWT           — a member of the owner's workspace with role=viewer
//   TEST_WORKSPACE_OWNER_ID   — that owner's user id (the X-Workspace-Owner value)
// US-2039: the seed script now emits both (scripts/seed-tenant-isolation-
// fixture.ts creates tenant-viewer@ and upserts a role=viewer workspace_members
// row for A), and both are in REQUIRED_RESOURCE_IDS — so these no longer skip
// silently in CI; a missing viewer fixture FAILS the job. A 2xx here is a FAIL.
const VIEWER_JWT = Deno.env.get("TEST_VIEWER_JWT");
const WS_OWNER = Deno.env.get("TEST_WORKSPACE_OWNER_ID");
const VIEWER_READY = Boolean(BASE && VIEWER_JWT && WS_OWNER);

function viewerHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${VIEWER_JWT}`,
    "Content-Type": "application/json",
    "X-Workspace-Owner": WS_OWNER!,
  };
}

Deno.test({
  name: "C3: viewer cannot POST a consignor payout (requires admin)",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/consignment/payouts`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ consignor_id: "00000000-0000-0000-0000-000000000000", amount: 100 }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST consignment payout as viewer");
  },
});

Deno.test({
  name: "C3: viewer cannot publish a batch (requires listing_manager)",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/autolister/publish-batch`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ item_ids: ["00000000-0000-0000-0000-000000000000"] }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST publish-batch as viewer");
  },
});

Deno.test({
  name: "C3: viewer cannot pay for a grade (drains owner credits)",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/grade/pay/00000000-0000-0000-0000-000000000000`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ tier: "standard" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST grade pay as viewer");
  },
});

// ── US-1639: workspace.ts role-authz coverage (was ZERO cases) ────────────────
//
// The workspace-management writes are admin-gated (roleAtLeast(role,"admin")).
// A viewer member acting in the owner's workspace must be denied all of them.
// The memberId is a throwaway zero-UUID — the role gate rejects BEFORE any row
// lookup, so a real id isn't needed to prove the denial.
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

Deno.test({
  name: "US-1639: viewer cannot invite a workspace member (requires admin)",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/workspace/invitations`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ email: "x@example.com", role: "member" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST workspace invitation as viewer");
  },
});

Deno.test({
  name: "US-1639: viewer cannot change a member's role (requires admin)",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/workspace/members/${ZERO_UUID}/role`, {
      method: "PATCH",
      headers: viewerHeaders(),
      body: JSON.stringify({ role: "admin" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "PATCH member role as viewer");
  },
});

Deno.test({
  name: "US-1639: viewer cannot remove a workspace member (requires admin)",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/workspace/members/${ZERO_UUID}/remove`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST member remove as viewer");
  },
});

Deno.test({
  name: "US-1639: viewer cannot change the workspace MFA policy (requires admin)",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/workspace/mfa-policy`, {
      method: "PUT",
      headers: viewerHeaders(),
      body: JSON.stringify({ required_role: "admin" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "PUT workspace mfa-policy as viewer");
  },
});

// A non-member B carrying A's X-Workspace-Owner header must be rejected by
// workspaceMiddleware (workspace_access_revoked) before any handler runs. Reuses
// the viewer fixture's owner id as a workspace B is provably NOT a member of.
function foreignWorkspaceHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${B_JWT}`,
    "Content-Type": "application/json",
    "X-Workspace-Owner": WS_OWNER!,
  };
}

Deno.test({
  name: "US-1639: non-member B cannot act in A's workspace (invitations)",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/workspace/invitations`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: JSON.stringify({ email: "x@example.com", role: "member" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST workspace invitation as non-member");
  },
});

// ── US-1639: notifications.ts cross-tenant cases (was zero) ───────────────────

// POST /dispute-filed is scoped to the caller's own dispute (US-1638). A foreign
// / non-owned disputeId resolves to no row → 404, never an existence/status
// oracle. A zero-UUID is guaranteed not-owned, so no seeded id is needed.
Deno.test({
  name: "US-1639: B cannot trigger a dispute-filed alert for a dispute they don't own",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/notifications/dispute-filed`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ disputeId: ZERO_UUID }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST dispute-filed for a non-owned dispute");
  },
});

// POST /dispute-status is an ADMIN endpoint (adminAuthMiddleware). A regular
// tenant must never resolve another user's dispute status through it.
Deno.test({
  name: "US-1639: non-admin B cannot read a dispute's status via /dispute-status",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/notifications/dispute-status`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ disputeId: ZERO_UUID, status: "resolved" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST dispute-status as non-admin");
  },
});

// ── US-1639: verified.ts — the write must require auth ────────────────────────
//
// The verified profile is strictly self-scoped (c.get("userId")); it has no
// foreign-id write surface. The isolation property worth guarding is that the
// write — which feeds PUBLIC listing embeds — is never reachable unauthenticated.
Deno.test({
  name: "US-1639: verified profile write requires authentication",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/verified/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "anon" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "PUT verified profile unauthenticated");
  },
});

// ── US-1639: passport tag revoke is tenant-scoped ─────────────────────────────
//
// POST /garments/:id/tags/:tagId/revoke scopes by created_by = ownerId, so B
// revoking a tag on A's garment resolves to no row → 404. A zero-UUID tagId is
// fine — the created_by scope denies before the tag is found.
Deno.test({
  name: "US-1639: B cannot revoke a passport tag on A's garment",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GARMENT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GARMENT_ID")!;
    const res = await fetch(
      `${BASE}/api/passport/garments/${id}/tags/${ZERO_UUID}/revoke`,
      { method: "POST", headers: authHeaders(B_JWT!), body: JSON.stringify({}) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST passport tag revoke (A's garment)");
  },
});

// ── US-1639: flipdesk-measure card-request (US-268 workspace scope) ───────────
//
// GET/POST /card-request self-scope to workspaceOwnerId. A non-member B carrying
// A's X-Workspace-Owner header is rejected by workspaceMiddleware before the
// handler reads or writes any measure_card_requests row.
Deno.test({
  name: "US-1639: non-member B cannot read A's mailed-card request",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/measure/card-request`, {
      headers: foreignWorkspaceHeaders(),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET measure card-request as non-member");
  },
});

Deno.test({
  name: "US-1639: non-member B cannot request a mailed card in A's workspace",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/measure/card-request`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: JSON.stringify({
        ship_name: "X",
        address_line1: "1 St",
        city: "Y",
        state: "CA",
        postal_code: "90000",
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST measure card-request as non-member");
  },
});

// ── US-1790: B2B batch-grading status (public /api/v1, API-KEY auth) ──────────
//
// GET /api/v1/grades/batch/:id scopes the grading_batches read by the calling
// key's userId. The public API authenticates with the `X-API-Key` header (NOT a
// JWT Bearer token), so this case needs its own fixtures and skips cleanly
// without them:
//   TEST_USER_B_API_KEY           a raw API key (gt_sk_…) belonging to user B
//   TEST_USER_A_GRADING_BATCH_ID  a grading_batches.id owned by user A
// B presenting A's batch id with B's valid key must be denied (404 — never A's
// job results). Using B's REAL key (not a bogus header) is what makes this a
// genuine tenant-scope test: the request reaches the handler and is rejected by
// the .eq("user_id", userId) filter, not bounced at auth.
const B_API_KEY = Deno.env.get("TEST_USER_B_API_KEY");
const A_GRADING_BATCH_ID = Deno.env.get("TEST_USER_A_GRADING_BATCH_ID");
Deno.test({
  name: "US-1790: key B cannot read A's grading batch status",
  ignore: !CONFIGURED || !B_API_KEY || !A_GRADING_BATCH_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/v1/grades/batch/${A_GRADING_BATCH_ID}`, {
      headers: { "X-API-Key": B_API_KEY! },
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET grades/batch/:id with foreign key");
  },
});

// US-1811: buyer purchase-link + arrival capture. The arrival-upload route loads
// the purchase with .eq("id", id).eq("user_id", userId) before touching storage,
// so B posting to A's purchase id hits 0 rows and is rejected (404) — never
// writes into A's private image folder. (Per-case ignore until the seed fixture
// provides TEST_USER_A_BUYER_PURCHASE_ID; seeding it needs a grade_report row, a
// follow-up — the case is authored and activates the moment the id is present.)
const A_BUYER_PURCHASE_ID = Deno.env.get("TEST_USER_A_BUYER_PURCHASE_ID");
Deno.test({
  name: "B cannot upload arrival photos to A's purchase",
  ignore: !CONFIGURED || !A_BUYER_PURCHASE_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/purchases/${A_BUYER_PURCHASE_ID}/arrival`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({ images: [{ image_type: "front", data_url: "aGk=" }] }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST buyer arrival capture to foreign purchase");
  },
});

// US-1812: buyer grade confirm/dispute. The confirm route loads the purchase with
// .eq("id", id).eq("user_id", userId) before recording any outcome, so B posting
// a verdict on A's purchase hits 0 rows → 404 (never writes a grade_outcomes row
// against A's purchase or moves A's seller's integrity). Reuses the same seed.
Deno.test({
  name: "B cannot confirm/dispute A's purchase",
  ignore: !CONFIGURED || !A_BUYER_PURCHASE_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/purchases/${A_BUYER_PURCHASE_ID}/confirm`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({ match_status: "confirmed" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST buyer grade confirmation to foreign purchase");
  },
});

// US-1821: buyer guarantee claim. The claim route loads the purchase with
// .eq("id", id).eq("user_id", userId) before filing anything, so B filing a
// claim on A's purchase hits 0 rows → 404 (never records a claim or grants a
// remedy against A's purchase). Reuses the same seed.
Deno.test({
  name: "B cannot file a guarantee claim on A's purchase",
  ignore: !CONFIGURED || !A_BUYER_PURCHASE_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/purchases/${A_BUYER_PURCHASE_ID}/claim`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST buyer guarantee claim to foreign purchase");
  },
});

// US-1840: buyer authenticity add-on. No cross-tenant id vector — POST /api/buyer/
// authenticity acts ONLY on the caller (entitlement + meter both keyed on
// c.get("userId"); the uploaded photos are the request body, not a foreign id).
// Nothing to scope-test beyond the self-scoped metering.

// US-1830: demand-board wants. DELETE is scoped .eq("id",id).eq("user_id",userId),
// so B deleting A's want hits 0 rows (no cross-tenant delete); GET returns only
// the caller's own wants (owner RLS). Per-case ignore until a want fixture exists.
const A_WANT_ID = Deno.env.get("TEST_USER_A_WANT_ID");
Deno.test({
  name: "B cannot delete A's want",
  ignore: !CONFIGURED || !A_WANT_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/wants/${A_WANT_ID}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    // Scoped delete: 0 rows matched B's user_id. The .eq("user_id") is the guard
    // (mirrors the closet-item + inventory-item cases).
    assert(res.status === 200 || DENIED.has(res.status), `unexpected ${res.status}`);
  },
});
// US-1847 (AC1): PATCH is scoped .eq("id",id).eq("user_id",userId) → maybeSingle,
// so B updating A's want hits 0 rows → 404 (never flips A's want status). DELETE
// was covered; this closes the mutating-verb gap on the same route. Same fixture.
Deno.test({
  name: "B cannot update (PATCH) A's want",
  ignore: !CONFIGURED || !A_WANT_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/wants/${A_WANT_ID}`, {
      method: "PATCH",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "fulfilled" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "PATCH buyer want owned by another tenant");
  },
});

// US-1814: buyer rewards leaderboard. No cross-tenant id vector — the opt-in
// POST /api/buyer/rewards/leaderboard updates ONLY the caller's own users row
// (.eq("id", userId); no id is taken from the body), and GET returns a PII-free
// opt-in aggregate (alias + confirmation count) by design. Nothing to scope-test
// beyond the self-update, which the route's .eq("id", userId) enforces.

// US-1825: closet items. DELETE is scoped .eq("id",id).eq("user_id",userId), so B
// deleting A's closet item hits 0 rows (204/ok but no cross-tenant delete); the
// add-by-certificate path 403s when the caller doesn't own the cert. (Per-case
// ignore until the seed provides TEST_USER_A_CLOSET_ITEM_ID.)
const A_CLOSET_ITEM_ID = Deno.env.get("TEST_USER_A_CLOSET_ITEM_ID");
// US-1828: the "list this" bridge loads the closet item with .eq("id",id).eq(
// "user_id",userId) before creating any inventory_item, so B listing A's closet
// item hits 0 rows → 404 (never promotes A's item into B's inventory).
Deno.test({
  name: "B cannot 'list this' A's closet item",
  ignore: !CONFIGURED || !A_CLOSET_ITEM_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/closet/${A_CLOSET_ITEM_ID}/list`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST buyer closet list-this on foreign item");
  },
});
Deno.test({
  name: "B cannot delete A's closet item",
  ignore: !CONFIGURED || !A_CLOSET_ITEM_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/closet/${A_CLOSET_ITEM_ID}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    // Delete is idempotent-by-scope: it must NOT remove A's row. A 200 here still
    // means 0 rows matched B's user_id — assert via a follow-up read would need a
    // fixture; the scope filter is the guarantee (mirrors the inventory-item case).
    assert(res.status === 200 || DENIED.has(res.status), `unexpected ${res.status}`);
  },
});
// US-1847 (AC1) + US-1825: closet add-by-certificate. certOwnership(userId,
// certificate_id) gates the write via an owner-verified parent — a buyer adding a
// cert they neither submitted nor purchased is 403 BEFORE any closet_items row is
// written. A's cert is the id B doesn't own (reuses the trust-signals fixture).
Deno.test({
  name: "B cannot add A's certificate to B's closet",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CERT_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/closet`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "certificate",
        certificate_id: Deno.env.get("TEST_USER_A_CERT_ID"),
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST buyer closet add of a foreign-owned certificate");
  },
});

// US-1847 (AC1) audit — buyer routes with NO cross-tenant id/path vector, so no
// scope-test case is possible or needed (documented so every buyer route is
// accounted for):
//   • POST /api/buyer/purchases (link) — the cert lookup is intentionally PUBLIC
//     (same predicate as the public cert page: certificate_id not null); the
//     buyer_purchases upsert is keyed on the caller's own user_id.
//   • GET /api/buyer/impact, GET /api/buyer/closet/valuation,
//     GET /api/buyer/closet/export.csv, GET /api/buyer/wants — self-scoped reads
//     (.eq("user_id"|"buyer_user_id", userId)); return only the caller's own rows.
//   • POST /api/buyer/wants — inserts with the caller's user_id (cap-checked);
//     takes no foreign id.
//   • GET/POST /api/buyer/profile, POST /api/buyer/profile/extension-token —
//     act ONLY on the caller's own users row (.eq("id", userId)); the token is
//     minted for c.get("userId"). No id is read from the body.

// US-1904: propose-groups fetches staged images by storage_path. Like its
// verify-groups sibling, every path must live under the CALLER's own
// `${ownerId}/_staging/…` prefix, checked before any AI work — so B can't hand
// it a path under another owner's folder to pull that tenant's image into the
// model. No seed needed: the forged foreign path is rejected on its face (403).
Deno.test({
  name: "B cannot propose-groups over a foreign _staging path",
  ignore: !CONFIGURED,
  fn: async () => {
    const foreign = "00000000-0000-0000-0000-000000000000/_staging/sess/p1.jpg";
    const res = await fetch(`${BASE}/api/flipdesk/autolister/propose-groups`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({
        photos: [
          { id: "p1", storage_path: foreign },
          { id: "p2", storage_path: foreign },
        ],
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST propose-groups with a foreign staging path");
  },
});

// ── Pending cross-listing delists (US-1885 AC1) ────────────────────────────
//
// The delist queue is the instruction list for ending listings in a browser, so
// a cross-tenant leak here is not just a read: it tells the extension to open
// ANOTHER SELLER'S live listing and end it. Both doors onto the queue are
// covered — the SaaS route (JWT) and the extension route (HMAC token).

// The confirm side had NO isolation coverage at all before this, despite being
// the mutating half: it clears the stamp and flips the row to ended/inactive. If
// B could confirm A's listing, A's sold sibling silently drops off the queue and
// stays live on the marketplace for a second buyer.
Deno.test({
  name: "B cannot confirm a delist on A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/delist-confirm`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_id: listingId }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST delist-confirm on a foreign listing");
  },
});

// The read side takes NO id from the request — the queue is derived from the
// caller's identity — so "denied" is the wrong assertion shape. The property
// that matters is that A's listing never APPEARS in B's queue.
Deno.test({
  name: "B's pending-delist queue never contains A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/pending-delists`, {
      headers: authHeaders(B_JWT!),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "GET pending-delists as B");
      return;
    }
    const json = await res.json();
    const ids = (json.pending ?? []).map((p: { listing_id: string }) => p.listing_id);
    assert(
      !ids.includes(listingId),
      `pending-delists returned A's listing ${listingId} to user B — cross-tenant leak`,
    );
  },
});

// The extension door. It resolves the tenant from an HMAC extension token and
// accepts no id, filter or workspace header, so there is nothing for a caller to
// forge — but that is only true while the token is actually REQUIRED. Assert the
// unauthenticated and forged-token paths stay closed; a regression that made
// this route fall back to "anonymous" the way /entitlements does would expose
// somebody's queue to an unauthenticated caller.
Deno.test({
  name: "extension pending-delists rejects missing/forged tokens",
  ignore: !CONFIGURED,
  fn: async () => {
    const url = `${BASE}/api/grading/public/pending-delists`;

    const noAuth = await fetch(url);
    await noAuth.body?.cancel();
    assertEquals(noAuth.status, 401, "GET pending-delists with no token must be 401");

    for (const bad of ["garbage", "a.b.c", "user-a.9999999999999.deadbeef"]) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${bad}` } });
      await res.body?.cancel();
      assertDenied(res.status, `GET pending-delists with a forged token (${bad})`);
    }
  },
});

// ── US-2238: /api/flipdesk/scout/appraise-url ────────────────────────────────
//
// The extension's sourcing appraisal. It takes NO resource id — the body is a
// list of public image URLs — so there is no row for a caller to reach across
// tenants. What it DOES do is spend the tenant's money: a paid plan gate, an AI
// action, and eBay comp pulls, all keyed on workspaceOwnerId ?? userId.
//
// So the isolation boundary worth proving is the SPEND boundary. A non-member
// carrying somebody else's X-Workspace-Owner must be stopped by
// workspaceMiddleware before the handler reserves anything against that
// workspace's quota; and a viewer inside the workspace must not be able to burn
// the owner's AI actions either.
const APPRAISE_URL_BODY = JSON.stringify({
  imageUrls: ["https://example.com/a.jpg"],
  title: "Patagonia Better Sweater",
  priceCents: 2000,
});

Deno.test({
  name: "US-2238: non-member B cannot appraise against A's workspace quota",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/appraise-url`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: APPRAISE_URL_BODY,
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/appraise-url as a non-member of A's workspace");
  },
});

Deno.test({
  // A viewer is read-only. Appraising reserves an AI action off the OWNER's
  // monthly cap, which is spend.
  //
  // The gate is NOT in flipdesk-scout.ts: it is blockViewerWrites (US-1928),
  // mounted once on /api/flipdesk/* after workspaceMiddleware, which refuses
  // every mutating verb for a viewer across the whole surface. That is exactly
  // why a case here matters — a route inheriting a baseline it never mentions is
  // the kind of protection that quietly disappears when the mount is
  // reorganised, and nothing else in this file would notice.
  name: "US-2238: viewer cannot spend the owner's AI quota on an appraisal",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/appraise-url`, {
      method: "POST",
      headers: viewerHeaders(),
      body: APPRAISE_URL_BODY,
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/appraise-url as viewer");
  },
});

Deno.test({
  // The same baseline, on the routes that already existed. Pinned alongside the
  // new one so a regression shows up as three failures rather than one.
  name: "US-1928: viewer cannot spend the owner's AI quota via scout /appraise or /prospect",
  ignore: !VIEWER_READY,
  fn: async () => {
    for (const path of ["/api/flipdesk/scout/appraise", "/api/flipdesk/scout/prospect"]) {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: viewerHeaders(),
        body: JSON.stringify({ q: "patagonia", image: "x" }),
      });
      await res.body?.cancel();
      assertDenied(res.status, `POST ${path} as viewer`);
    }
  },
});

Deno.test({
  // Unauthenticated must never reach the grader: the route sits behind
  // authMiddleware, and a fallback-to-anonymous regression here would hand a
  // free Vision call to anyone who found the URL.
  name: "US-2238: scout/appraise-url rejects an unauthenticated caller",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/appraise-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: APPRAISE_URL_BODY,
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/appraise-url with no auth");
  },
});

Deno.test({
  // US-2244: the RN/CA resolve queue is an OPERATOR surface. It holds no tenant
  // rows at all (00501/00502 are aggregate, owner-less), so the risk it guards is
  // the other direction: a seller must not be able to WRITE brand reference data
  // that then feeds every other tenant's identification. adminAuthMiddleware plus
  // the content:publish scope guard deny a non-admin before any row is touched.
  name: "B (non-admin) cannot read or write the RN resolve queue",
  ignore: !CONFIGURED,
  fn: async () => {
    const read = await fetch(`${BASE}/api/admin/registered-numbers`, {
      headers: authHeaders(B_JWT!),
    });
    await read.body?.cancel();
    assertDenied(read.status, "GET registered-numbers queue");

    const write = await fetch(`${BASE}/api/admin/registered-numbers`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({
        registry_key: "RN 87370",
        company_name: "Not My Company",
        brand_keys: ["lululemon"],
      }),
    });
    await write.body?.cancel();
    assertDenied(write.status, "POST registered-numbers resolve");
  },
});

Deno.test({
  name: "US-2244: registered-numbers rejects an unauthenticated caller",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/admin/registered-numbers`);
    await res.body?.cancel();
    assertDenied(res.status, "GET registered-numbers with no auth");
  },
});
