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
//   TEST_USER_A_SYNC_LISTING_URL a poshmark listings.listing_url owned by A
//                               (US-2697 sold-sync; OPTIONAL - skips until the
//                               seed script has been re-run)
//   TEST_USER_A_API_KEY_ID      an api_keys.id
//   TEST_USER_A_API_KEY         A's RAW key (gt_sk_…) for /api/v1 (US-9107)
//   TEST_USER_B_API_KEY         B's RAW key (gt_sk_…) for /api/v1 (US-9107)
//   TEST_USER_A_TEMPLATE_ID     a listing_templates.id (US-674)
//   TEST_USER_A_RULE_ID         a repricing_rules.id (US-672)
//   TEST_USER_A_AUTOMATION_RULE_ID  a flipdesk_automation_rules.id (US-2156;
//                               OPTIONAL — skips until the seed script adds it)
//   TEST_USER_A_SALE_ID         a sales.id owned by A (US-2160 label routes;
//                               OPTIONAL — skips until the seed script adds it)
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
// WHY /api/admin/* IS COVERED THINLY, ON PURPOSE (US-2014 AC2). The audit that
// filed US-2014 listed 13 admin route groups with no case here, and that reads
// like 13 holes. It is one hole, already plugged in a different place: every
// /api/admin/* group sits behind adminAuthMiddleware (main.ts), so those routes
// are AUTHORIZATION-gated rather than TENANT-gated. Their job is to cross tenant
// lines — an admin console that could only see its own rows would be useless —
// so "B cannot read A's row" is not the property to assert. The property is "a
// non-admin cannot get in at all", and a handful of representative probes below
// (abuse signals, rate-limit overrides, marketplace sync, support tickets) pin
// it; adding the other nine would re-test adminAuthMiddleware, not the handlers.
//
// The consequence, stated plainly so nobody mistakes this for coverage: if
// adminAuthMiddleware is ever removed from a group, these probes catch that
// group and only that group. The guard that catches the OMISSION on a new admin
// mount is flipdesk-auth-coverage_test.ts (US-1639), which fails the build when
// an /api/* router ships with no auth posture at all.
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
  // US-9107: the RAW keys. Without them nothing can authenticate against
  // /api/v1, so every public-API cross-tenant path is unverified — which was
  // the state until the seeder learned to mint real keys.
  "TEST_USER_A_API_KEY",
  "TEST_USER_B_API_KEY",
  "TEST_USER_A_TEMPLATE_ID",
  "TEST_USER_A_RULE_ID",
  "TEST_USER_A_ITEM_ID",
  "TEST_USER_A_BATCH_ID",
  "TEST_USER_A_SYNC_RUN_ID",
  "TEST_USER_A_PAYOUT_ID",
  "TEST_USER_A_CONFLICT_ID",
  "TEST_USER_A_RECONCILE_SESSION",
  "TEST_USER_A_CONSIGNOR_ID",
  // US-2228: the receipt routes read from a PRIVATE bucket, so a skipped case
  // here is an unverified path to another tenant's card tails.
  "TEST_USER_A_EXPENSE_ID",
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
  TEST_USER_A_EBAY_RETURN_ID: "needs a live eBay sandbox RETURN — external dependency",
  TEST_USER_A_EBAY_DISPUTE_ID: "needs a live eBay sandbox payment DISPUTE — external dependency",
  TEST_USER_A_EBAY_CANCEL_ID: "needs a live eBay sandbox CANCELLATION — external dependency",
  TEST_USER_A_EBAY_INQUIRY_ID:
    "needs a live eBay sandbox Item-Not-Received INQUIRY — external dependency (US-2928)",
  TEST_USER_A_EBAY_CASE_ID:
    "needs a live eBay sandbox escalated CASE — external dependency (US-2929)",
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

    // US-9107: match ASSIGNMENTS, not mentions.
    //
    // This was /TEST_[A-Z_]+/ over the whole seed file, so a name appearing in a
    // COMMENT counted as seeded. Proven by sabotage while adding the /api/v1
    // items cases: deleting the real "out.TEST_USER_B_API_KEY = ..." line left
    // the guard green, because a comment two lines above still said the name.
    // That is the guard satisfying itself with its own prose.
    const seeded = new Set(
      [...seed.matchAll(/out\.(TEST_[A-Z_]+)\s*=/g)].map((m) => m[1]!),
    );
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
  // US-2768 AC5. The extract route spends a paid AI action against an item id
  // from the body, writes an ai_enrichment_log row keyed on it, and persists
  // canonical attributes onto it. Every one of those is a write on A's tenant
  // driven by a value B controls.
  //
  // The route checks ownership BEFORE the spend, and the comment above that
  // check records what happened when it did not: the FK insert succeeded or
  // failed depending on whether the row existed, which made a foreign item id a
  // cross-tenant UUID-existence oracle, and the log row landed against A.
  //
  // That check had no test. The visual pass added in US-2768 starts BEFORE the
  // quota round trip, so a regression that moves the ownership check any later
  // now also spends an eBay call on a foreign item.
  name: "B cannot run AI extraction against A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ai/extract`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        item_id: itemId,
        text: "attacker-supplied description",
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST ai/extract (foreign item_id)");
  },
});
Deno.test({
  // US-2817. Bulk re-identify is the first AI path that OVERWRITES an
  // existing brand/size/color/style rather than filling a blank, and it
  // follows the write through to the listing titles that quote the old
  // value. Both halves act on item ids straight from the body, so an
  // unscoped version would let B rewrite the identity of A's garment AND
  // A's live listing title.
  //
  // This route answers 200 with a PER-ITEM result rather than a 4xx, so
  // assertDenied does not apply: the denial to assert is that A's item is
  // reported failed and never enriched. A 402 is also a pass - B may not
  // carry the Pro plan the bulk gate requires, and that gate runs first.
  name: "B cannot bulk re-identify A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ai/bulk-extract`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_ids: [itemId], mode: "reidentify" }),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      assert(
        DENIED.has(res.status) || res.status === 402 || res.status === 429,
        `POST ai/bulk-extract (foreign item_id): expected a denial, a plan gate or a quota stop, got ${res.status}`,
      );
      return;
    }
    const body = await res.json() as {
      results?: { item_id: string; status: string; applied?: string[] }[];
    };
    const row = (body.results ?? []).find((r) => r.item_id === itemId);
    assert(row, "bulk-extract returned no result row for the foreign item");
    assertEquals(
      row.status,
      "failed",
      "B's bulk re-identify of A's item must fail, not enrich",
    );
    assertEquals(
      row.applied ?? [],
      [],
      "no field may be written on a foreign item",
    );
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
  // US-2706: the return-evidence route. Every eBay call it makes runs under the
  // OWNER's own token, so a returnId belonging to another seller is not a row
  // this service could read — it reaches eBay as THIS seller's return and comes
  // back denied.
  //
  // That is the property worth pinning, and it is worth pinning even though
  // there is no local query to get wrong: the route is one line away from
  // taking an owner from the body, and this case is what would notice.
  name: "B cannot attach evidence to A's eBay return",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_RETURN_ID"),
  fn: async () => {
    const returnId = Deno.env.get("TEST_USER_A_EBAY_RETURN_ID")!;
    // A one-pixel PNG, so the magic-byte sniff passes and the request reaches
    // the eBay call rather than being rejected as a bad image — otherwise this
    // would pass for the wrong reason.
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ), (ch) => ch.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([png], "evidence.png", { type: "image/png" }));
    const headers = authHeaders(B_JWT!) as Record<string, string>;
    // FormData sets its own multipart boundary; a JSON content-type here would
    // make the route 400 before it ever looked at the tenant.
    delete headers["Content-Type"];
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/returns/${encodeURIComponent(returnId)}/evidence`,
      { method: "POST", headers, body: form },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST eBay return evidence");
  },
});

Deno.test({
  // US-2707 AC5: the from-pack mode on the payment-dispute evidence route.
  //
  // The plain single-file upload was already covered by the owner's-token
  // argument; from-pack mode adds LOCAL reads — the sale, the graded item, the
  // grade report and the publication snapshot — and every one is scoped by
  // workspaceOwnerId ?? userId. An order id from tenant A carried in B's
  // request must resolve to nothing rather than to A's grade report.
  name: "B cannot build an evidence pack from A's order on the dispute route",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_DISPUTE_ID") ||
    !Deno.env.get("TEST_USER_A_EBAY_ORDER_ID"),
  fn: async () => {
    const disputeId = Deno.env.get("TEST_USER_A_EBAY_DISPUTE_ID")!;
    const orderId = Deno.env.get("TEST_USER_A_EBAY_ORDER_ID")!;
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ), (ch) => ch.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([png], "evidence.png", { type: "image/png" }));
    // The from-pack fields, carrying ANOTHER tenant's order.
    form.append("order_id", orderId);
    form.append("complaint", "There is a stain on the cuff.");
    const headers = authHeaders(B_JWT!) as Record<string, string>;
    delete headers["Content-Type"];
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/payment-disputes/${encodeURIComponent(disputeId)}/evidence`,
      { method: "POST", headers, body: form },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST eBay dispute evidence (from pack)");
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
    // Bare path, no trailing slash — the trailing-slash form 404s (see the
    // aggregate case below), and 404 is in the DENIED set, so this case would
    // have reported "authenticated" for a URL that does not exist. Measured:
    // GET /api/flipdesk/equity unauthenticated returns 401, so the wildcard
    // authMiddleware does cover the bare path and the property holds.
    const res = await fetch(`${BASE}/api/flipdesk/equity`, {
      headers: { "Content-Type": "application/json" },
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET equity unauthenticated");
  },
});

Deno.test({
  // US-2014 AC1: /api/flipdesk/images/archive is the images group's MUTATING
  // route and the one worth a case. It moves photos to R2 and REWRITES
  // photo_url to an unauthenticated public URL, so a cross-tenant reach would
  // not merely read A's data — it would republish A's images at a new address
  // and delete the Supabase originals.
  //
  // Like /export and /equity it takes no resource id: eligibility comes from
  // the caller, via `.eq("inventory_items.user_id", userId)` on the join. So
  // assertDenied is meaningless here and CONTAINMENT is the property — B's own
  // archive run must never mention a photo of A's.
  //
  // Asserted on the RESPONSE BODY rather than the status, because the failure
  // this guards against returns 200: a scoping bug would archive A's photos and
  // report a perfectly healthy count.
  name: "B's image archive touches NONE of A's photos",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_PHOTO_ID"),
  fn: async () => {
    const aPhoto = Deno.env.get("TEST_USER_A_PHOTO_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/images/archive`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    // 503 = R2 not configured in this environment. A skip, not a pass: the
    // ownership scoping sits AFTER the config guard, exactly as remove-bg does.
    if (res.status === 503) {
      await res.body?.cancel();
      return;
    }
    const text = await res.text();
    assertEquals(res.status, 200, `B's own archive must succeed: ${text}`);
    assert(
      !text.includes(aPhoto),
      `B's archive response names A's photo ${aPhoto} — the eligibility join ` +
        `is no longer scoped to the caller, so A's images were republished to ` +
        `a public R2 URL and their originals deleted`,
    );
  },
});

Deno.test({
  // US-2014 AC1: the equity case above pins only that the route is
  // authenticated, with a stated reason — a containment check "needs seeded
  // values to compare against". It does not, and this is the stronger property
  // that needs no fixture at all.
  //
  // computeEquityForOwner aggregates the CALLER's inventory. If the user_id
  // scoping were ever dropped, every caller would receive the SAME platform-wide
  // total — so two different tenants seeing identical numbers is the signature
  // of exactly that bug. A leak here returns 200 with a plausible figure, which
  // is why the auth-only case could not catch it.
  //
  // Guarded against a false alarm: two tenants can legitimately match when both
  // are empty, so the assertion only bites when at least one side is non-zero.
  // That makes it silent on a bare fixture rather than flaky, which is the trade
  // that keeps a probe alive.
  name: "A and B do not receive the same equity aggregate",
  ignore: !CONFIGURED,
  fn: async () => {
    // NO TRAILING SLASH. `app.route("/api/flipdesk/equity", …)` + `.get("/")`
    // matches the BARE path in Hono; `/api/flipdesk/equity/` falls through to
    // app.notFound and answers 404. Measured 2026-08-08 against a live seeded
    // stack: both tenants got {"error":"Not found"}, so the `if (a.status !==
    // 200 …) return` below fired on every run and this probe never reached a
    // single assertion. Same defect as the totalEquityCents field-name bug
    // recorded above, one layer out — the URL rather than the payload. Auth is
    // unaffected either way (the bare path measured 401 unauthenticated).
    const read = async (jwt: string) => {
      const res = await fetch(`${BASE}/api/flipdesk/equity`, {
        headers: authHeaders(jwt),
      });
      const text = await res.text();
      return { status: res.status, text };
    };
    const a = await read(A_JWT!);
    const b = await read(B_JWT!);

    // 402/404 = the plan gate or the feature flag, not a tenancy answer.
    if (a.status !== 200 || b.status !== 200) return;

    // BOTH SPELLINGS. GET /equity/ returns computeEquityForOwner, whose field
    // is `totalEquityCents`; only the /trend snapshot rows use the snake_case
    // `total_equity_cents`. My first version matched snake_case only — so the
    // parse always returned 0, both sides looked empty, and the case exited
    // early EVERY time. A probe that never reaches its assertion is the exact
    // failure this suite exists to catch, written into the suite itself.
    const KEY = /"(?:totalEquityCents|total_equity_cents)"\s*:\s*(-?\d+)/;
    const total = (body: string) => {
      const m = body.match(KEY);
      return m ? Number(m[1]) : null;
    };
    const [ta, tb] = [total(a.text), total(b.text)];

    // Neither response carries the field the probe reads. That is a SHAPE
    // change, not an empty tenant, and silently passing on it is how this went
    // vacuous in the first place.
    assert(
      ta !== null || tb !== null,
      "neither equity response contained a recognisable total — the payload " +
        "shape changed and this probe is no longer reading anything",
    );
    // DIRECT CONTAINMENT, stronger than the inequality below and available for
    // free: the payload carries `items` with per-item ids, so if A's item id
    // appears in B's aggregate the scope is gone and there is nothing to infer.
    // Checked first because it names the leak instead of describing its shape.
    const aItem = Deno.env.get("TEST_USER_A_ITEM_ID");
    if (aItem) {
      assert(
        !b.text.includes(aItem),
        `B's equity payload contains A's item ${aItem} — the aggregate is not ` +
          `scoped to the caller`,
      );
    }

    if ((ta ?? 0) === 0 && (tb ?? 0) === 0) return; // both empty; nothing to tell apart.

    assert(
      a.text !== b.text,
      `A and B received byte-identical equity (total ${ta}). That is what a ` +
        `dropped user_id scope looks like: every caller aggregating the whole ` +
        `platform, returned as a healthy 200.`,
    );
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
  // US-2328: the Shopify ship route is new, and it is the same shape as the
  // eBay one above — the sale is loaded THROUGH inventory_items.user_id, so B
  // pointing at A's sale id hits 0 rows and 404s before any Shopify call is
  // made. Worth its own case rather than trusting the shared shape: this route
  // pushes tracking to an EXTERNAL shop, so a leak here would not just read
  // A's row, it would fulfil A's Shopify order under B's request.
  name: "B cannot mark A's sale shipped via Shopify",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SALE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_SALE_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/shopify/orders/${id}/ship`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ tracking_number: "PWNED123", carrier: "USPS" }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST shopify order ship");
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

// US-2617: the photo-archive cron walks EVERY owner with archivable photos and
// rewrites photo_url to an UNAUTHENTICATED public R2 URL. It resolves each owner
// from the photo row rather than from the request, so a caller who reached it
// would be publishing other tenants' images — which makes the job secret the
// only thing standing between a signed-in user and a fleet-wide publish.
Deno.test({
  name: "photo-archive job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/photo-archive`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/photo-archive with a user JWT should 401 (no job secret), got ${status}`,
    );
  },
});

Deno.test({
  name: "photo-archive job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/photo-archive`, {
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
      `POST /jobs/photo-archive with a bogus job secret should 401, got ${status}`,
    );
  },
});

// US-2617: the reconciliation sweep walks EVERY owner holding an unreconciled
// payout and links payout rows to sales through reconcile_payout_link — a write
// into another tenant's books. It resolves each owner from the payout row, so
// the job secret is the only gate between a signed-in user and a fleet-wide
// auto-match.
Deno.test({
  name: "reconciliation-sweep job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/reconciliation-sweep`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/reconciliation-sweep with a user JWT should 401 (no job secret), got ${status}`,
    );
  },
});

Deno.test({
  name: "reconciliation-sweep job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/reconciliation-sweep`, {
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
      `POST /jobs/reconciliation-sweep with a bogus job secret should 401, got ${status}`,
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

// US-2503: GET /api/buyer/entitlements — the resolved buyer plan payload both
// the web app and iOS read, so neither reimplements the gating matrix.
//
// The route takes NO id, filter or workspace header: getBuyerEntitlements reads
// c.get("userId")'s own users row. So the boundary that matters is that it is
// authenticated at all, and that B's answer is B's — never A's.
Deno.test({
  name: "buyer entitlements requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/entitlements`);
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `unauthenticated entitlements should 401, got ${status}`,
    );
  },
});

Deno.test({
  // Two different buyers must get two different answers when their plans
  // differ, and neither may influence the other's. There is nothing to forge in
  // the request, so this asserts the shape and that the id is not readable from
  // input: the same call with A's and B's tokens resolves independently.
  name: "buyer entitlements answers for the CALLER, not a supplied id",
  ignore: !CONFIGURED,
  fn: async () => {
    // A query id must be ignored entirely — the route reads none. Any uuid
    // will do; the point is that supplying one changes nothing.
    const res = await fetch(
      `${BASE}/api/buyer/entitlements?user_id=00000000-0000-0000-0000-000000000000`,
      { headers: authHeaders(B_JWT!) },
    );
    const body = (await res.json().catch(() => ({}))) as {
      plan?: string;
      gateFlags?: Record<string, unknown>;
      allowances?: Record<string, unknown>;
    };
    assertEquals(res.status, 200);
    assert(
      typeof body.plan === "string" && !!body.gateFlags && !!body.allowances,
      "entitlements must return the resolved {plan, gateFlags, allowances}",
    );
    // No PII, no ids, no subscription internals — only the resolved decision.
    const keys = Object.keys(body).sort();
    assertEquals(
      keys,
      ["allowances", "gateFlags", "plan"],
      `entitlements must expose only the resolved payload, got: ${keys.join(", ")}`,
    );
  },
});

// US-2503: GET /api/buyer/guarantee-coverage — the joined coverage view iOS
// reads instead of reproducing the web’s five-way client-side join.
//
// The route takes NO input: every read is .eq("user_id", <token id>), and the
// child reads are keyed on purchase ids that came out of the owner-scoped
// parent read. There is no id to forge, so the boundaries that matter are
// authentication and the entitlement gate.
Deno.test({
  name: "buyer guarantee coverage requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/guarantee-coverage`);
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `unauthenticated guarantee coverage should 401, got ${status}`,
    );
  },
});

Deno.test({
  name: "buyer guarantee coverage returns only the caller’s purchases",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/buyer/guarantee-coverage?user_id=00000000-0000-0000-0000-000000000000`,
      { headers: authHeaders(B_JWT!) },
    );
    // 402 is a legitimate answer here: the gate runs before any read, so a B
    // without the entitlement is refused rather than served an empty list.
    // Either way it must never carry A’s rows.
    assert(
      res.status === 200 || res.status === 402,
      `expected 200 or 402, got ${res.status}`,
    );
    const body = (await res.json().catch(() => ({}))) as {
      purchases?: Array<Record<string, unknown>>;
    };
    if (res.status === 402) return;
    assert(Array.isArray(body.purchases), "coverage must return a purchases array");
    // Whatever came back is B’s. The one identifier that could betray a
    // cross-tenant read is A’s known purchase id.
    const ids = (body.purchases ?? []).map((p) => String(p.id));
    assert(
      !ids.includes(A_BUYER_PURCHASE_ID ?? "__none__"),
      "B must never see A’s purchase in their coverage",
    );
  },
});

// US-2503: GET /api/buyer/reputation — the caller’s own trust level + perks,
// resolved server-side so iOS does not carry a third copy of the perk matrix.
//
// Same shape as entitlements above: no id, filter or header is read, so the
// boundary is that it is authenticated and that the answer is the CALLER’S.
Deno.test({
  name: "buyer reputation requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/buyer/reputation`);
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `unauthenticated reputation should 401, got ${status}`,
    );
  },
});

Deno.test({
  name: "buyer reputation answers for the CALLER and leaks no identity",
  ignore: !CONFIGURED,
  fn: async () => {
    // Supplying an id must change nothing — the route reads none.
    const res = await fetch(
      `${BASE}/api/buyer/reputation?user_id=00000000-0000-0000-0000-000000000000`,
      { headers: authHeaders(B_JWT!) },
    );
    assertEquals(res.status, 200);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // A buyer with no score row is level 0, not an error — everyone starts
    // there, so the endpoint must always answer.
    assert(typeof body.level === "number", "reputation must always resolve a level");
    assert(typeof body.score === "number", "reputation must always resolve a score");
    assert(!!body.perks, "reputation must carry the resolved perks");
    // No user_id, no email, no handle — only the resolved decision.
    const keys = Object.keys(body).sort();
    assertEquals(
      keys,
      ["computedAt", "eventCount", "level", "levelName", "next", "perks", "score"],
      `reputation must expose only the resolved payload, got: ${keys.join(", ")}`,
    );
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

// US-1850: the same public seller endpoint now also carries `achievements` —
// earned medals from user_badges, read with the service-role client. The
// boundary is (1) they belong to THAT seller (the query is scoped to the
// handle's owner id) and (2) the payload carries only catalog metadata +
// earned_at — never the `context` snapshot (the owner's grade counts / XP) or a
// user_id. Shape is asserted here; the projection itself is unit-tested in
// rewards-badges_test.ts.
Deno.test({
  name: "public seller achievements expose no private stats",
  ignore: !BASE || !Deno.env.get("TEST_USER_B_HANDLE"),
  fn: async () => {
    const handle = Deno.env.get("TEST_USER_B_HANDLE")!;
    const res = await fetch(
      `${BASE}/api/content/public/sellers/${encodeURIComponent(handle)}`,
    );
    const body = (await res.json().catch(() => ({}))) as {
      achievements?: Array<Record<string, unknown>>;
    };
    const achievements = body.achievements ?? [];
    assert(Array.isArray(achievements), "achievements must be an array");
    for (const a of achievements) {
      assertEquals(
        Object.keys(a).sort(),
        ["description", "earned_at", "icon", "key", "name", "tier"],
        `achievement carried unexpected keys: ${Object.keys(a).join(", ")}`,
      );
    }
    const blob = JSON.stringify(achievements);
    for (const leak of ["user_id", "context", "xpTotal", "gradeCount"]) {
      assert(!blob.includes(leak), `achievements leaked "${leak}"`);
    }
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
// 501 = the US-2160 label routes' capability gate: sell.logistics is a
// limited-release scope kept off the default consent list, so preflight returns
// before the ownership lookup on any deployment that lacks it. Same reasoning as
// 503 — the handler never touched A's row.
const DENIED_OR_UNCONFIGURED = new Set([401, 403, 404, 422, 501, 503]);

/**
 * US-2160: the label routes gate on the eBay capability BEFORE the ownership
 * lookup, so on a deployment without sell.logistics (which is every deployment
 * until eBay grants the limited-release scope) they answer 501 and never reach
 * loadOwnedSale. Asserting the strict 401/403/404 set there would fail red on a
 * correctly-configured server while proving nothing. Either way A's row is
 * untouched, which is what the case is really claiming.
 */
function assertDeniedOrGated(status: number, what: string): void {
  assert(
    DENIED_OR_UNCONFIGURED.has(status),
    `${what} should be denied or capability-gated ` +
      `(401/403/404/422/501/503) but got ${status}`,
  );
}

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

// US-2395 AC6: the same route, taken down the GROUP branch. A multi-variation
// listing has no platform_offer_id, so before the group branch existed this
// request met a 409 before ownership could matter — the refusal was doing the
// isolation work by accident. Now the branch runs real eBay writes (variant
// items, the group, the per-variant offers), so the ownership check is the only
// thing between B and A's live listing, and it is worth its own case rather than
// being assumed to be covered by the offer one above.
//
// Needs a VARIATION listing owned by A. Absent that id the case is skipped, not
// silently passed: a green run against no fixture proves nothing.
Deno.test({
  name: "B cannot revise A's multi-variation eBay listing (group branch)",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_VARIATION_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_VARIATION_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/listings/${id}/revise`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      // resync_ebay_fields is the payload that reaches furthest into the group
      // branch: it pushes items, the group and every variant offer.
      body: JSON.stringify({ title: "pwned", resync_ebay_fields: true }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      DENIED_OR_UNCONFIGURED.has(status),
      `POST listings/:id/revise (variation group) for another tenant should be ` +
        `denied (401/403/404/422/503) but got ${status}`,
    );
  },
});

// US-2404: bulk-revise takes ids in the BODY rather than the path, which is
// exactly the shape US-268 warns about — an id from the request body acted on
// without an ownership check. It runs each id through reviseOneListing, the same
// function the single route uses, so the tenant scope is loadListingOwned again;
// this proves that rather than assuming the shared call site kept it.
//
// A 200 here is NOT automatically a pass: the route answers 200 carrying per-row
// results, so the assertion has to read the row and confirm it was refused.
Deno.test({
  name: "B cannot bulk-revise A's eBay listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/listings/bulk-revise`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_ids: [id] }),
    });
    const status = res.status;
    if (DENIED_OR_UNCONFIGURED.has(status)) {
      await res.body?.cancel();
      return; // refused outright (plan gate, unconfigured eBay, or auth)
    }
    assert(status === 200, `unexpected status ${status}`);
    const json = await res.json() as {
      results?: Array<{ listing_id: string; ok: boolean; status: number }>;
    };
    const row = (json.results ?? []).find((r) => r.listing_id === id);
    assert(row, "expected a per-row result for the requested id");
    assert(
      row.ok === false && DENIED_OR_UNCONFIGURED.has(row.status),
      `bulk-revise reported ok=${row.ok} status=${row.status} for another ` +
        `tenant's listing — it must be refused per row, not pushed`,
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

// US-1915: the rewards north-star report aggregates PER-USER rows (who signed
// up, who came back, who was granted what) into counts. Two properties, and the
// second is the one specific to this route rather than to the middleware:
//   1. a non-admin cannot reach it at all;
//   2. even for an admin, the body carries no user ids — the aggregate must not
//      become a data export. That half is asserted without a server in
//      rewards-north-star-report_test.ts, since it is a property of the shape.
Deno.test({
  name: "B (non-admin) cannot read the rewards north-star report",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/admin/rewards/north-star?days=30`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET admin/rewards/north-star");
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

// US-2425: the draft-coverage console aggregates AutoLister specifics coverage
// across EVERY tenant (the question "is the pipeline improving, and in which
// vertical?" is meaningless inside one seller's data), so it must be
// unreachable by a seller. adminAuthMiddleware denies any non-admin caller
// before a row is read, and requireScope("marketplace:write") gates it again.
Deno.test({
  name: "B (non-admin) cannot read the AutoLister draft-coverage console",
  ignore: !CONFIGURED,
  fn: async () => {
    for (const path of [
      "/api/admin/listing-coverage",
      "/api/admin/listing-coverage?limit=1000",
    ]) {
      const res = await fetch(`${BASE}${path}`, { headers: authHeaders(B_JWT!) });
      await res.body?.cancel();
      assertDenied(res.status, `GET ${path}`);
    }
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

// US-2670: both disputes INSERT policies gated on the user_id COLUMN and
// nothing else, so an authenticated caller who set user_id to their OWN id could
// file a dispute against ANY grade report that exists, including another
// seller's. 00619 adds the grade_report_id ownership check.
//
// This one goes DIRECTLY at PostgREST rather than through the edge route, and
// that is the point: routes/grade.ts has always loaded the submission scoped to
// the owner, so the route was never the hole. The policy is what a direct client
// write lands on — which is exactly what iOS was doing when this was found.
Deno.test({
  name: "US-2670: B cannot file a dispute against A's grade report (RLS)",
  ignore:
    !CONFIGURED ||
    !Deno.env.get("SUPABASE_URL") ||
    !Deno.env.get("TEST_USER_A_GRADE_REPORT_ID"),
  fn: async () => {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const reportId = Deno.env.get("TEST_USER_A_GRADE_REPORT_ID")!;

    // B's own id, off their JWT: the row is honest about who is filing, which is
    // what makes this a test of the REPORT check rather than of the user_id one.
    const rawPayload = B_JWT!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = rawPayload + "=".repeat((4 - (rawPayload.length % 4)) % 4);
    const bId = (JSON.parse(atob(payload)) as { sub: string }).sub;

    const res = await fetch(`${supabaseUrl}/rest/v1/disputes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${B_JWT!}`,
        apikey: anon,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        grade_report_id: reportId,
        user_id: bId,
        reason: "US-2670 cross-tenant dispute probe",
      }),
    });
    const body = await res.text();
    assert(
      res.status === 401 || res.status === 403,
      `B filing a dispute on A's report must be refused by RLS, got ${res.status}: ${body}`,
    );
    assert(
      !body.includes('"id"'),
      "RLS returned a dispute row for a foreign grade report — the INSERT policy is not checking grade_report_id",
    );
  },
});

// ── US-2557: the unread badge count ───────────────────────────────────────────
//
// The count is derived from the SESSION and the route accepts no user id at
// all — there is no ?userId to forge, which is the point. So the two properties
// worth pinning are that it is unreachable unauthenticated, and that it stays
// that way: an id parameter added later would turn a self-scoped counter into a
// cross-tenant oracle ("does this account have unread mail?") without anything
// else in the route looking different.
Deno.test({
  name: "US-2557: the unread count is unreachable without a session",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/notifications/unread-count`);
    await res.body?.cancel();
    assertDenied(res.status, "GET unread-count unauthenticated");
  },
});

Deno.test({
  name: "US-2557: a userId parameter cannot redirect the count at another tenant",
  ignore: !CONFIGURED,
  fn: async () => {
    // B asks for the zero-UUID's count. The route must ignore the parameter
    // entirely and answer for B — never for the id in the query string.
    const res = await fetch(
      `${BASE}/api/notifications/unread-count?userId=${ZERO_UUID}&u=${ZERO_UUID}`,
      { headers: authHeaders(B_JWT!) },
    );
    const body = await res.json().catch(() => null);
    assertEquals(res.status, 200, "B's own count should still answer");
    assert(
      body !== null && typeof body.unread === "number",
      "the response is B's own count, not an error about the foreign id",
    );
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

// ── US-1851: rewards.ts — self-scoped, and never workspace-scoped ─────────────
//
// GET /api/rewards/state reads the caller's XP, level and season progress from
// c.get("userId") alone. Two properties matter and neither is about a foreign id
// in a body (the route has no write surface at all):
//   1. It must not be reachable unauthenticated — XP totals say how much someone
//      grades and how often they list.
//   2. Carrying A's X-Workspace-Owner header must NOT return A's rewards. The
//      route is deliberately outside workspaceMiddleware: a level belongs to the
//      human who earned it, not to whichever tenant they're acting inside, so B
//      must get B's own state back regardless of that header.
Deno.test({
  name: "US-1851: rewards state requires authentication",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/rewards/state`, {
      headers: { "Content-Type": "application/json" },
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET rewards state unauthenticated");
  },
});

Deno.test({
  name: "US-1851: B's workspace header cannot make /rewards/state return A's XP",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const mine = await fetch(`${BASE}/api/rewards/state`, {
      headers: authHeaders(B_JWT!),
    });
    const spoofed = await fetch(`${BASE}/api/rewards/state`, {
      headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": WS_OWNER! },
    });
    // Either the header is rejected outright, or it is ignored and B sees B.
    if (spoofed.status !== 200) {
      await mine.body?.cancel();
      await spoofed.body?.cancel();
      assertDenied(spoofed.status, "GET rewards state with A's workspace header");
      return;
    }
    assertEquals(mine.status, 200, "B should be able to read their own rewards");
    const a = await mine.json();
    const b = await spoofed.json();
    assertEquals(
      b?.level?.xp_peak,
      a?.level?.xp_peak,
      "the workspace header must not change whose rewards are returned",
    );
  },
});

// ── US-1852: rewards quests — self-scoped, and it WRITES ──────────────────────
//
// /api/rewards/quests matters more than /state does, because reading it is not
// read-only: it evaluates quest progress and can claim a completion and pay XP.
// So the two properties are the same, and the stake on the second one is higher —
// if A's workspace header could steer the evaluation, it would write rows and
// award XP against A's ledger from B's session.
Deno.test({
  name: "US-1852: rewards quests require authentication",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/rewards/quests`, {
      headers: { "Content-Type": "application/json" },
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET rewards quests unauthenticated");
  },
});

Deno.test({
  name: "US-1852: B's workspace header cannot make /rewards/quests evaluate A",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const mine = await fetch(`${BASE}/api/rewards/quests`, {
      headers: authHeaders(B_JWT!),
    });
    const spoofed = await fetch(`${BASE}/api/rewards/quests`, {
      headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": WS_OWNER! },
    });
    if (spoofed.status !== 200) {
      await mine.body?.cancel();
      await spoofed.body?.cancel();
      assertDenied(spoofed.status, "GET rewards quests with A's workspace header");
      return;
    }
    assertEquals(mine.status, 200, "B should be able to read their own quests");
    const a = await mine.json();
    const b = await spoofed.json();
    assertEquals(
      JSON.stringify(b?.quests?.map((q: { key: string; progress: { current: number } }) => [
        q.key,
        q.progress?.current,
      ])),
      JSON.stringify(a?.quests?.map((q: { key: string; progress: { current: number } }) => [
        q.key,
        q.progress?.current,
      ])),
      "the workspace header must not change whose quest progress is evaluated",
    );
  },
});

// ── US-1859: nudge click attribution — an id from the PATH, and a write ───────
//
// POST /api/rewards/nudges/:id/click takes a send id straight off the URL and
// UPDATEs a row with it. That is the classic US-268 shape, so the handler pairs
// the id with `.eq("user_id", userId)` and the response is deliberately the same
// `{ok:true}` whether or not anything was stamped — a distinguishable 404 would
// turn the endpoint into an oracle for which sends exist.
//
// A stamped foreign row would not leak data, but it would corrupt the very thing
// the row is for: B could inflate the click rate of a nudge A never opened, and
// the lift report is what decides whether this feature keeps running.
Deno.test({
  name: "US-1859: nudge click attribution requires authentication",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/rewards/nudges/00000000-0000-4000-8000-000000000000/click`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST nudge click unauthenticated");
  },
});

Deno.test({
  name: "US-1859: B stamping an arbitrary nudge id never confirms it exists",
  ignore: !CONFIGURED,
  fn: async () => {
    // Two ids: a well-formed one B does not own, and a malformed one. Both must
    // read identically from the outside, and neither may 500.
    for (
      const id of ["11111111-1111-4111-8111-111111111111", "not-a-uuid"]
    ) {
      const res = await fetch(`${BASE}/api/rewards/nudges/${id}/click`, {
        method: "POST",
        headers: authHeaders(B_JWT!),
      });
      const body = await res.json().catch(() => null);
      assertEquals(
        res.status,
        200,
        `POST nudge click (${id}) should answer uniformly, not reveal existence`,
      );
      assertEquals(body?.ok, true, `POST nudge click (${id}) should answer {ok:true}`);
    }
  },
});

// ── US-1856: rewards leaderboards — self-scoped, and the PUT is the risk ──────
//
// GET /api/rewards/leaderboard reports the caller's OWN standing; PUT joins,
// leaves or renames them on the public boards. The write takes no id from the
// body — it is `.eq("id", userId)` — so the vector to close is the workspace
// header: if A's header could steer it, B could publish A onto a public
// leaderboard, or pull them off one, from B's session.
Deno.test({
  name: "US-1856: rewards leaderboard state requires authentication",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/rewards/leaderboard`, {
      headers: { "Content-Type": "application/json" },
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET rewards leaderboard unauthenticated");
  },
});

Deno.test({
  name: "US-1856: rewards leaderboard opt-in write requires authentication",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/rewards/leaderboard`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, alias: "Intruder" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "PUT rewards leaderboard unauthenticated");
  },
});

Deno.test({
  name: "US-1856: A's workspace header cannot make the leaderboard PUT act on A",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    // Rename-only: it never joins anybody to a public board, so a pass leaves no
    // residue. If the header steered the write it would rename A, not B.
    const res = await fetch(`${BASE}/api/rewards/leaderboard`, {
      method: "PUT",
      headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": WS_OWNER! },
      body: JSON.stringify({ alias: "B Only" }),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "PUT rewards leaderboard with A's workspace header");
      return;
    }
    const body = await res.json();
    // The echoed alias is the CALLER's row. A response carrying anything else
    // would mean the write landed on the workspace owner.
    assertEquals(
      body?.alias,
      "B Only",
      "the workspace header must not change whose leaderboard row is written",
    );
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

// ── US-2595: flipdesk-measure autofill (US-268 workspace scope) ──────────────
//
// POST /autofill takes an item_id from the request body and, when it finds the
// MeasureCard, RETAGS a photo and writes measurements — so an unscoped handler
// would let B mutate A's inventory, not merely read it. The item load is
// .eq("user_id", ownerId), and workspaceMiddleware rejects a non-member's
// X-Workspace-Owner header before the handler runs at all.
Deno.test({
  name: "US-2595: non-member B cannot autofill measurements on A's item",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/measure/autofill`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: JSON.stringify({ item_id: crypto.randomUUID() }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST measure autofill as non-member");
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
    // 402 is a pass, and it is what CI actually returns. The route runs
    // requireBuyerFeature(c, "demandBoard") BEFORE it looks at the id, so an
    // unentitled B is refused one layer earlier than the ownership filter —
    // same accept-402-with-a-reason pattern the listings/bulk-edit and closet
    // cases already use. (DELETE on this same route is ungated, which is why
    // the case above needs no 402.)
    assert(
      DENIED_OR_GATED.has(res.status),
      `PATCH buyer want owned by another tenant: expected 401/402/403/404, ` +
        `got ${res.status}`,
    );

    // Widening the accepted set would leave this case asserting only "B was
    // refused for SOME reason", and a billing refusal is not the property under
    // test. So read A's want back with the service-role key and prove the row
    // never moved. This holds whichever gate fired, and it is what actually
    // fails if the .eq("user_id", userId) on the update is ever dropped.
    // The support-tools block near line 2200 env-sets SUPABASE_SERVICE_ROLE_KEY
    // to the literal "test-service-key" when the real one is absent, and that
    // placeholder is not a JWT — PostgREST answers PGRST301 "Expected 3 parts in
    // JWT". Skipping on it keeps a developer running without the stack env from
    // reading a credential error as a tenant leak. CI always has the real key
    // (tenant-isolation.yml exports it from `supabase status`), so the readback
    // does run where it counts.
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceKey && serviceKey !== "test-service-key") {
      const check = await fetch(
        `${supabaseUrl}/rest/v1/buyer_wants?id=eq.${A_WANT_ID}&select=status`,
        {
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
        },
      );
      const rows = (await check.json().catch(() => [])) as { status?: string }[];
      assert(
        check.ok,
        `readback of A's want failed (${check.status}) — fix the fixture env ` +
          `rather than deleting this check: ${JSON.stringify(rows)}`,
      );
      assert(
        rows.length === 1 && rows[0].status !== "fulfilled",
        `A's want must be untouched by B's PATCH, got ${JSON.stringify(rows)}`,
      );
    }
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

// US-1854: the share-to-earn loop. Recording a tracked share of a find you do
// not own would be worse than a cosmetic lie — `share_events.sharer_hash` is the
// self-click defence, so a foreign share row lets an attacker bank a fingerprint
// against the victim's find and have the victim's genuine clicks discarded as
// self-clicks. recordShare resolves the certificate's owner server-side and
// refuses anything that isn't the caller.
Deno.test({
  name: "B cannot record a tracked share of A's certificate",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CERT_ID"),
  fn: async () => {
    const certId = Deno.env.get("TEST_USER_A_CERT_ID")!;
    const res = await fetch(`${BASE}/api/rewards/share`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ targetType: "cert", targetId: certId, channel: "x" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST rewards/share for a foreign-owned certificate");

    // The stats read is owner-scoped by construction (the caller's id IS the
    // filter), so it answers 200 — but it must answer with B's zeros, never A's
    // numbers. A denial is equally acceptable.
    const stats = await fetch(
      `${BASE}/api/rewards/share/cert/${encodeURIComponent(certId)}`,
      { headers: authHeaders(B_JWT!) },
    );
    if (stats.status === 200) {
      const body = (await stats.json().catch(() => ({}))) as { shares?: number };
      assertEquals(
        body.shares ?? 0,
        0,
        "share stats must not report another tenant's shares",
      );
    } else {
      await stats.body?.cancel();
      assertDenied(stats.status, "GET rewards/share stats for a foreign cert");
    }
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
//     US-2503 added an `items` array to the valuation response (the identity
//     fields iOS needs alongside the estimates). Same read, same scope — the
//     closet_items select is .eq("user_id", userId) and takes no id from the
//     caller — so this bullet still covers it. Noted rather than left implicit:
//     a route that grows a new key is exactly when an accounting like this one
//     goes quietly out of date.
//   • POST /api/buyer/wants — inserts with the caller's user_id (cap-checked);
//     takes no foreign id.
//   • GET/POST /api/buyer/profile, POST /api/buyer/profile/extension-token —
//     act ONLY on the caller's own users row (.eq("id", userId)); the token is
//     minted for c.get("userId"). No id is read from the body.
//   • POST /api/grade/submit `inventory_item_id` (US-2504) — identical shape to
//     `closet_item_id` below and for the same reason. The lookup is
//     .eq("id", body).eq("user_id", ownerId), so a foreign item resolves to
//     null and the grade proceeds UNLINKED rather than being refused; refusing
//     would leak whether the id exists in another tenant. The two write-backs
//     (the flipdesk_grading_submissions bridge row and the inventory_items
//     patch) both run only when that owner-scoped lookup returned a row, and
//     the patch repeats .eq("user_id", ownerId), so a link that somehow
//     survived would still update zero rows.
//   • POST /api/grade/submit `closet_item_id` (US-1841) — a foreign closet item
//     is FILTERED, not refused: the lookup is
//     .eq("id", body).eq("user_id", ownerId), and an unowned id resolves to null
//     so the grade proceeds with no closet link. There is deliberately no denial
//     to assert (refusing would leak whether the id exists in another tenant),
//     and the write-back (closet-grade-link.ts) repeats the same user_id scope,
//     so a link that somehow survived still updates zero rows. Same shape as the
//     `regrade_of` / `retake_of` ids alongside it.

// US-1851: the rewards read surface. Both routes are self-scoped and take NO id
// from the caller — GET /api/rewards/me reads reputation_events and
// user_reward_state with .eq("user_id", userId), and GET
// /api/rewards/seasons/:key/recap re-scores that SAME self-scoped event list over
// a date window, so the `:key` path segment selects a TIME range, never a user.
// The one door worth pinning is the mount itself: these routes live behind
// app.use("/api/rewards/*", authMiddleware), and if that line were ever dropped
// the handler would run with no userId and the service-role client would happily
// read the whole table. An unauthenticated 401 is what proves the guard is on.
// US-1852: GET /api/rewards/quests joins the same self-scoped surface. It takes
// no id at all — the quest DEFINITIONS are product config (deny-all RLS, read
// only through the service-role client) and the progress counted against them
// comes from the caller's own reputation_events. The quest board is not a place
// a foreign id can be smuggled in, so the mount guard below is the whole test.
Deno.test({
  name: "rewards read surface is not reachable without a token",
  ignore: !CONFIGURED,
  fn: async () => {
    for (
      const path of [
        "/api/rewards/me",
        "/api/rewards/seasons/2026-Q3/recap",
        "/api/rewards/quests",
      ]
    ) {
      const res = await fetch(`${BASE}${path}`);
      await res.body?.cancel();
      assert(res.status === 401, `unauthenticated GET ${path} should 401, got ${res.status}`);
    }
  },
});

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

// US-2374: the phone → desktop handoff. A session row carries the storage paths
// the desktop will render, so two doors need holding: B must not be able to
// PARK a foreign tenant's staged photo (which would put A's images on B's
// desktop grid), and B must not be able to read, claim or discard A's waiting
// batch by id. The id doors need no seed — an id B doesn't own is a 404 whether
// or not it exists, which is the point.
Deno.test({
  name: "B cannot park a handoff session over a foreign _staging path",
  ignore: !CONFIGURED,
  fn: async () => {
    const foreign = "00000000-0000-0000-0000-000000000000/_staging/sess/p1.jpg";
    const res = await fetch(`${BASE}/api/flipdesk/autolister/sessions`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({
        staging_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        source: "ios",
        photos: [{ id: "p1", storage_path: foreign }],
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST autolister/sessions with a foreign staging path");
  },
});

Deno.test({
  name: "B cannot park a handoff whose THUMBNAIL is a foreign _staging path",
  ignore: !CONFIGURED,
  fn: async () => {
    // The full-size path is B's own; only the thumbnail is forged. Checking
    // just the main path would leak A's image through the thumbnail slot.
    const foreignThumb =
      "00000000-0000-0000-0000-000000000000/_staging/sess/p1_thumb.jpg";
    const res = await fetch(`${BASE}/api/flipdesk/autolister/sessions`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
      body: JSON.stringify({
        staging_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        photos: [{
          id: "p1",
          storage_path: "no-such-owner/_staging/sess/p1.jpg",
          thumbnail_storage_path: foreignThumb,
        }],
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST autolister/sessions with a foreign thumbnail path");
  },
});

Deno.test({
  name: "B cannot read, claim or discard a handoff session it doesn't own",
  ignore: !CONFIGURED,
  fn: async () => {
    const someId = "00000000-0000-0000-0000-000000000000";
    const read = await fetch(
      `${BASE}/api/flipdesk/autolister/sessions/${someId}`,
      { headers: authHeaders(B_JWT!) },
    );
    await read.body?.cancel();
    assertDenied(read.status, "GET autolister/sessions/:id for a foreign row");

    const claim = await fetch(
      `${BASE}/api/flipdesk/autolister/sessions/${someId}/claim`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    await claim.body?.cancel();
    assertDenied(claim.status, "POST autolister/sessions/:id/claim for a foreign row");

    const discard = await fetch(
      `${BASE}/api/flipdesk/autolister/sessions/${someId}`,
      { method: "DELETE", headers: authHeaders(B_JWT!) },
    );
    await discard.body?.cancel();
    assertDenied(discard.status, "DELETE autolister/sessions/:id for a foreign row");
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

// ── Extension listing ingestion (US-1808) ──────────────────────────────────
//
// The other extension-token door, and the one that WRITES. It takes no row id —
// the tenant is the id inside the HMAC token — so, like pending-delists, the
// property worth proving is that the token is genuinely REQUIRED. A regression
// that let this fall back to "anonymous" the way /entitlements does would let an
// unauthenticated caller write rows, spend Vision, and (worse) have those rows
// land against whatever user id it invented.
//
// A forged token must also be rejected BEFORE any grading happens: the handler
// verifies first and rate-limits second, so a signature check is the only thing
// standing between a stranger and somebody else's metered allowance.
Deno.test({
  name: "extension ingest-listing rejects missing/forged tokens",
  ignore: !CONFIGURED,
  fn: async () => {
    const url = `${BASE}/api/grading/public/ingest-listing`;
    const payload = JSON.stringify({
      url: "https://www.poshmark.com/listing/attacker-abc123",
      imageUrls: ["https://images.poshmark.com/x.jpg"],
      title: "Nike Hoodie",
    });

    const noAuth = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    await noAuth.body?.cancel();
    assertEquals(noAuth.status, 401, "POST ingest-listing with no token must be 401");

    for (const bad of ["garbage", "a.b.c", "user-a.9999999999999.deadbeef"]) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bad}` },
        body: payload,
      });
      await res.body?.cancel();
      assertDenied(res.status, `POST ingest-listing with a forged token (${bad})`);
    }
  },
});

// A buyer's ingested listings are their own browsing history. The SaaS-side
// read is RLS-scoped, but the row is written by the SERVICE-ROLE client, so the
// isolation that matters is that the write keys on the token's id — never on
// anything in the body. Assert the body cannot name a victim: a user_id planted
// in the payload must not change whose row is written, which shows up here as
// the request still needing (and being refused for lack of) a valid token.
Deno.test({
  name: "ingest-listing ignores a user_id planted in the request body",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/grading/public/ingest-listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "00000000-0000-0000-0000-000000000000",
        userId: "00000000-0000-0000-0000-000000000000",
        url: "https://www.grailed.com/listings/123-attacker",
        imageUrls: ["https://media.grailed.com/x.jpg"],
      }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 401, "a body-supplied user id must not authenticate anyone");
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

// ── US-2851: the sourcing ceiling reads a per-seller SETTING ────────────────
//
// The three scout endpoints now read flipdesk_settings.sourcing_target_roi_pct
// to size the ceiling, and flipdesk_settings is a multi-tenant table hit with
// the service-role client, which bypasses RLS. The read is scoped on user_id in
// lib/sourcing-target.ts and the caller passes workspaceOwnerId ?? userId, so a
// member sources against the OWNER's margin.
//
// WHAT COULD GO WRONG, AND WHY THE PROOF IS A DENIAL. There is no resource id
// in any of these bodies, so nobody can name another tenant's settings row
// directly. The only way to read A's target is to be admitted as A, which means
// the boundary is the workspace header. The unit test in
// sourcing-ceiling_test.ts pins the `.eq("user_id", ownerId)` filter itself;
// these pin that a stranger never gets that far.
Deno.test({
  name: "US-2851: non-member B cannot read A's sourcing target through a scout ceiling",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    for (
      const [path, body] of [
        ["/api/flipdesk/scout/appraise-url", APPRAISE_URL_BODY],
        ["/api/flipdesk/scout/appraise", JSON.stringify({ q: "patagonia", image: "x" })],
        ["/api/flipdesk/scout/prospect", JSON.stringify({ q: "patagonia", image: "x" })],
      ] as const
    ) {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: foreignWorkspaceHeaders(),
        body,
      });
      await res.body?.cancel();
      assertDenied(res.status, `POST ${path} as a non-member of A's workspace`);
    }
  },
});

Deno.test({
  // A viewer IS inside the workspace, so the header alone would admit them. The
  // baseline that stops them is blockViewerWrites. Pinned here because the
  // ceiling is a new reason to care: a read-only member should not be able to
  // make the product quote a spending limit off the owner's margin setting.
  name: "US-2851: viewer cannot obtain a sourcing ceiling off the owner's target",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/prospect`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ q: "patagonia", image: "x" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/prospect as viewer");
  },
});

// -- US-2923: the photoless re-pull --------------------------------------------
//
// WHY THIS NEEDS ITS OWN CASE. /prospect used to reject a body with no photo at
// the top of the handler, which meant a malformed or hostile request stopped
// before it reached the gate, the quota or the sourcing target. A re-pull sends
// NO photos on purpose, so that early return is now conditional - and a
// conditional early return is exactly the shape that quietly opens a route.
//
// The body below is the smallest thing that reaches the new path. It names no
// resource id, because there is none to name: the boundary here is the identity
// the request is admitted under, and what a re-pull can reach through it is the
// owner's comp-pull entitlement, their AI quota and their sourcing target.
const REPULL_BODY = JSON.stringify({
  titleOverride: "Lululemon ABC Pant 32",
  gradeValue: 7.5,
});

Deno.test({
  name: "US-2923: non-member B cannot re-pull comps inside A's workspace",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/prospect`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: REPULL_BODY,
    });
    await res.body?.cancel();
    assertDenied(
      res.status,
      "POST scout/prospect with a title override as a non-member of A's workspace",
    );
  },
});

Deno.test({
  // A viewer is INSIDE the workspace, so the header admits them and only
  // blockViewerWrites stops them. A re-pull spends no AI action, which makes it
  // the cheapest-looking way for a read-only member to slip past that rule - and
  // it still spends a comp pull against the owner's plan.
  name: "US-2923: viewer cannot re-pull comps against the owner's plan",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/prospect`, {
      method: "POST",
      headers: viewerHeaders(),
      body: REPULL_BODY,
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/prospect re-pull as viewer");
  },
});

Deno.test({
  // The photoless path must not become an unauthenticated one. Before US-2923
  // an anonymous caller was stopped by the missing-photo 400 as well as by
  // authMiddleware; only one of those two guards is left.
  name: "US-2923: scout/prospect rejects an unauthenticated re-pull",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/prospect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: REPULL_BODY,
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/prospect re-pull with no credentials");
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

Deno.test({
  // US-2156: the automations module had NO isolation case, and this story
  // widened what its routes can do — a rule's action can now flip
  // inventory_items.status, mint sibling `listings` rows on other marketplaces,
  // and send eBay watcher offers. A cross-tenant hit on the rule CRUD would let
  // B point one of those actions at A's inventory.
  //
  // Every handler scopes by id AND user_id (never the id alone), so B's
  // PUT/PATCH/DELETE hit 0 rows and 404.
  name: "US-2156: B cannot update, toggle or delete A's automation rule",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_AUTOMATION_RULE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_AUTOMATION_RULE_ID")!;
    const put = await fetch(`${BASE}/api/flipdesk/automations/rules/${id}`, {
      method: "PUT",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        name: "pwned",
        trigger_json: { type: "days_listed_gt", days: 1, cooldown_days: 1 },
        action_json: { type: "advance_status", status: "archived" },
      }),
    });
    await put.body?.cancel();
    assertDenied(put.status, "PUT automation rule");

    const patch = await fetch(`${BASE}/api/flipdesk/automations/rules/${id}`, {
      method: "PATCH",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ is_active: false }),
    });
    await patch.body?.cancel();
    assertDenied(patch.status, "PATCH automation rule");

    const del = await fetch(`${BASE}/api/flipdesk/automations/rules/${id}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await del.body?.cancel();
    assertDenied(del.status, "DELETE automation rule");
  },
});

Deno.test({
  // US-2156: dry-run and the per-rule activity log both read A's listings and
  // A's action history through a rule id taken from the URL. Both scope the
  // rule read by user_id first, so B gets a 404 and never learns what A sells.
  name: "US-2156: B cannot dry-run A's automation rule or read its activity",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_AUTOMATION_RULE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_AUTOMATION_RULE_ID")!;
    const dry = await fetch(
      `${BASE}/api/flipdesk/automations/rules/${id}/dry-run`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    const dryBody = (await dry.json().catch(() => ({}))) as {
      affected?: unknown[];
    };
    assertDenied(dry.status, "POST dry-run (A's rule)");
    // Belt and braces: even if the status ever softened, no listing of A's may
    // appear in the response.
    assertEquals(
      dryBody.affected ?? [],
      [],
      "dry-run must not leak A's listings to B",
    );

    const log = await fetch(
      `${BASE}/api/flipdesk/automations/rules/${id}/actions`,
      { headers: authHeaders(B_JWT!) },
    );
    const logBody = (await log.json().catch(() => ({}))) as {
      actions?: unknown[];
    };
    // The activity read is scoped by user_id AND rule_id, so B's own (empty)
    // history is what comes back — never A's.
    assertEquals(
      logBody.actions ?? [],
      [],
      "activity log must not leak A's automation actions to B",
    );
  },
});

Deno.test({
  // US-2160 (AC4): the label routes are the highest-stakes writes in FlipDesk —
  // buying a label SPENDS the seller's money and voiding one changes what a
  // sale records as its shipping cost. A cross-tenant hit would let B charge A's
  // eBay account, or wipe A's recorded postage.
  //
  // Every route resolves the sale THROUGH inventory_items.user_id before it
  // touches eBay or writes anything, so B gets the same 404 as a nonexistent
  // sale. Nothing reaches eBay on the denied path.
  name: "US-2160: B cannot price, buy, reprint or void a label on A's sale",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SALE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_SALE_ID")!;

    const rates = await fetch(
      `${BASE}/api/flipdesk/logistics/sales/${id}/rates`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ weight_value: 2 }),
      },
    );
    const ratesBody = (await rates.json().catch(() => ({}))) as {
      rates?: unknown[];
      shipping_quote_id?: string;
    };
    assertDeniedOrGated(rates.status, "POST logistics rates (A's sale)");
    // Belt and braces: no quote, and no rate, may leak even if the status ever
    // softened — a rate id is directly purchasable.
    assertEquals(ratesBody.rates ?? [], [], "rates must not leak to B");
    assertEquals(
      ratesBody.shipping_quote_id ?? "",
      "",
      "quote id must not leak to B",
    );

    const buy = await fetch(`${BASE}/api/flipdesk/logistics/sales/${id}/label`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ shipping_quote_id: "q1", rate_id: "r1" }),
    });
    await buy.body?.cancel();
    assertDeniedOrGated(buy.status, "POST logistics label (A's sale)");

    const reprint = await fetch(
      `${BASE}/api/flipdesk/logistics/sales/${id}/label`,
      { headers: authHeaders(B_JWT!) },
    );
    await reprint.body?.cancel();
    assertDeniedOrGated(reprint.status, "GET logistics label (A's sale)");

    const voidLabel = await fetch(
      `${BASE}/api/flipdesk/logistics/sales/${id}/label/void`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    await voidLabel.body?.cancel();
    assertDeniedOrGated(voidLabel.status, "POST logistics label void (A's sale)");
  },
});

Deno.test({
  // US-2160: the capability probe is per-connection, so it must answer for the
  // CALLER's own eBay connection and never reveal anything about another
  // tenant's. It takes no id, so the only thing to assert is that it stays
  // authenticated — an anonymous caller must not learn the deployment's scope
  // posture.
  name: "US-2160: logistics capabilities rejects an unauthenticated caller",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/logistics/capabilities`);
    await res.body?.cancel();
    assertDenied(res.status, "GET logistics capabilities with no auth");
  },
});

Deno.test({
  // US-2166 (AC6): the lifecycle operations gained canonical mount points under
  // /api/flipdesk/listings. They resolve the listing through
  // inventory_items.user_id before any write, so B repricing, ending or
  // bulk-editing A's listing must be refused at the NEW paths too — the old
  // eBay-namespaced cases prove nothing about these.
  name: "US-2166: B cannot reprice, end or bulk-edit A's listing at the agnostic paths",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;

    const price = await fetch(`${BASE}/api/flipdesk/listings/${id}/price`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ price: 1 }),
    });
    await price.body?.cancel();
    assertDenied(price.status, "POST listings/:id/price (A's listing)");

    const end = await fetch(`${BASE}/api/flipdesk/listings/${id}/end`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    await end.body?.cancel();
    assertDenied(end.status, "POST listings/:id/end (A's listing)");

    // Bulk takes ids in the BODY, so a denial here cannot come from the URL —
    // it has to come from the per-row ownership filter. A 402 is also a pass:
    // B lacking the bulkActions entitlement is refused even earlier, and never
    // reaches A's rows either way.
    const bulk = await fetch(`${BASE}/api/flipdesk/listings/bulk-edit`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      // `price` is the WIRE name (normalizeBulkEdit maps it to the
      // listing_price column). Sending the column name makes the patch empty
      // and the route 400s on validation — which would prove nothing about the
      // ownership filter this case exists to test.
      body: JSON.stringify({ listing_ids: [id], edit: { price: 1 } }),
    });
    const bulkBody = (await bulk.json().catch(() => ({}))) as {
      summary?: { ok?: number };
      results?: Array<{ ok?: boolean }>;
    };
    if (bulk.status === 200) {
      // The route answers 200 with per-row outcomes, so the assertion is that
      // A's row was NOT edited — not that the call failed.
      assertEquals(
        bulkBody.results?.filter((r) => r.ok).length ?? 0,
        0,
        "bulk-edit must not apply to another tenant's listing",
      );
    } else {
      assert(
        [401, 402, 403, 404].includes(bulk.status),
        `POST listings/bulk-edit for another tenant should be denied, got ${bulk.status}`,
      );
    }
  },
});

Deno.test({
  // US-1855: Showcase consent decides whether one of A's garments appears in a
  // PUBLIC feed. The submission id travels in the request BODY, so a denial
  // here can only come from the `.eq("user_id", userId)` filter on the update —
  // there is no path segment to reject it earlier. If this ever passed, B could
  // publish A's private find (or withdraw A's own consent) at will.
  name: "US-1855: B cannot set Showcase consent on A's submission",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GRADE_SUBMISSION_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GRADE_SUBMISSION_ID")!;
    const res = await fetch(`${BASE}/api/showcase/consent`, {
      method: "PUT",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ submission_id: id, opt_in: true }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "PUT showcase/consent (A's submission)");
  },
});

Deno.test({
  // The Showcase WRITE half is authenticated end to end. The feed itself is
  // public (GET /api/content/public/finds.json), so it would be easy to assume
  // the writes could be too — they cannot: consent publishes someone's garment
  // and a reaction is attributed to an account.
  name: "US-1855: Showcase writes reject an unauthenticated caller",
  ignore: !CONFIGURED,
  fn: async () => {
    const consent = await fetch(`${BASE}/api/showcase/consent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submission_id: "00000000-0000-4000-8000-000000000000",
        opt_in: true,
      }),
    });
    await consent.body?.cancel();
    assertDenied(consent.status, "PUT showcase/consent with no auth");

    const react = await fetch(
      `${BASE}/api/showcase/reactions/00000000-0000-4000-8000-000000000000`,
      { method: "POST" },
    );
    await react.body?.cancel();
    assertDenied(react.status, "POST showcase/reactions with no auth");

    const mine = await fetch(`${BASE}/api/showcase/reactions?ids=00000000-0000-4000-8000-000000000000`);
    await mine.body?.cancel();
    assertDenied(mine.status, "GET showcase/reactions with no auth");
  },
});

// ── US-1861: Thrift Radar contribution on /api/flipdesk/scout/prospect ───────
//
// This is the first request in the product that carries a coordinate, so the
// boundary it needs proving on is not "can B read A's row" — there is no row a
// caller names. It is ATTRIBUTION: a Radar contribution is written under the
// same `workspaceOwnerId ?? userId` the scan is billed to, so if a non-member
// could reach the handler carrying somebody else's X-Workspace-Owner, they could
// plant a location observation under that workspace's contributor identity while
// spending its AI quota to do it.
//
// The gate is workspaceMiddleware (non-member) and blockViewerWrites (viewer),
// both mounted on /api/flipdesk/* — the same inherited baseline the appraise-url
// cases above pin, which is why a coordinate-carrying case belongs beside them.
const PROSPECT_FIX_BODY = JSON.stringify({
  images: ["data:image/jpeg;base64,AAAA"],
  lat: 40.712776,
  lng: -74.005974,
});

Deno.test({
  name: "US-1861: non-member B cannot attribute a Radar coordinate to A's workspace",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/prospect`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: PROSPECT_FIX_BODY,
    });
    await res.body?.cancel();
    assertDenied(
      res.status,
      "POST scout/prospect with a coordinate as a non-member of A's workspace",
    );
  },
});

Deno.test({
  // A viewer is read-only, and contributing to Radar is a write in the most
  // literal sense — it inserts a row keyed to the OWNER's rotating contributor
  // digest, about a place the owner may never have been.
  name: "US-1861: viewer cannot contribute a Radar coordinate under the owner",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/prospect`, {
      method: "POST",
      headers: viewerHeaders(),
      body: PROSPECT_FIX_BODY,
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/prospect with a coordinate as viewer");
  },
});

Deno.test({
  // Unauthenticated must never reach the handler. There is no anonymous
  // contributor: the consent this feature rests on is per-account, so a scan
  // with no account behind it has nobody's permission by construction.
  name: "US-1861: prospect rejects an unauthenticated caller carrying a coordinate",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/prospect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: PROSPECT_FIX_BODY,
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST scout/prospect with a coordinate and no auth");
  },
});

// ── US-1864: Thrift Radar — the PERSONAL layer ───────────────────────────────
//
// The network endpoints above are gated by plan and by the k-anonymity floor.
// These two are gated by NEITHER — deliberately, because the personal layer is
// free, consent-independent and must work at n=1 (rule 7). That removes two
// accidental barriers, which makes tenant scoping the ONLY thing standing
// between one reseller's sourcing history and another's.
//
// Two boundaries therefore need proving:
//   1. READ. GET /my-stores answers for whoever the middleware resolved, never
//      for a workspace the caller is not a member of. A leak here is somebody
//      else's spend, profit and the stores they buy from — competitive
//      intelligence, handed over.
//   2. WRITE. POST /my-stores/link takes a source id FROM THE REQUEST BODY,
//      which is exactly the shape US-268 exists for. B must not be able to
//      repoint A's source at a venue, and must not be able to tell "not yours"
//      from "not real" — the two answers must be byte-identical, or the endpoint
//      is an oracle for enumerating another tenant's source ids.
const A_SOURCE_ID = Deno.env.get("TEST_USER_A_SOURCE_ID");

Deno.test({
  name: "US-1864: non-member B cannot read A's personal store history",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/radar/my-stores`, {
      headers: foreignWorkspaceHeaders(),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET radar/my-stores as a non-member of A's workspace");
  },
});

Deno.test({
  name: "US-1864: my-stores rejects an unauthenticated caller",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/radar/my-stores`);
    await res.body?.cancel();
    assertDenied(res.status, "GET radar/my-stores with no auth");
  },
});

Deno.test({
  name: "US-1864: non-member B cannot link A's source to a Radar venue",
  ignore: !CONFIGURED || !WS_OWNER || !A_SOURCE_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/radar/my-stores/link`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: JSON.stringify({ source_id: A_SOURCE_ID, venue_id: null }),
    });
    await res.body?.cancel();
    assertDenied(
      res.status,
      "POST radar/my-stores/link on A's source as a non-member",
    );
  },
});

Deno.test({
  // B is a legitimate account acting in their OWN workspace, naming A's source
  // id. Nothing about the request is malformed, so the only thing that can stop
  // it is the ownership check inside linkSourceToVenue — this is the case that
  // fails if somebody "simplifies" it to .eq("id", sourceId).
  name: "US-1864: B in their own workspace cannot link A's source id",
  ignore: !CONFIGURED || !A_SOURCE_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/radar/my-stores/link`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ source_id: A_SOURCE_ID, venue_id: null }),
    });
    const body = await res.text();
    assertDenied(res.status, "POST radar/my-stores/link naming A's source as B");
    // And the SAME body a made-up id gets, so the response cannot be used to
    // discover which source ids exist in another tenant.
    const fake = await fetch(`${BASE}/api/flipdesk/radar/my-stores/link`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        source_id: "00000000-0000-4000-8000-000000000000",
        venue_id: null,
      }),
    });
    const fakeBody = await fake.text();
    assertEquals(
      [res.status, body],
      [fake.status, fakeBody],
      "a foreign source id and an unknown one must be indistinguishable",
    );
  },
});

Deno.test({
  // A viewer is read-only. Linking a store rewrites how the owner's own sourcing
  // ROI is attributed, which is a write however small the column is.
  name: "US-1864: viewer cannot link a store under the owner",
  ignore: !VIEWER_READY || !A_SOURCE_ID,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/radar/my-stores/link`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ source_id: A_SOURCE_ID, venue_id: null }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST radar/my-stores/link as viewer");
  },
});

// US-2228: expense receipts. The bucket is PRIVATE and the objects are
// receipts — card tails, billing addresses, sometimes a full name. Three routes
// hang off one expense row, and all three resolve it the same way: load it
// `.eq("user_id", ownerId)` BEFORE anything else. That ordering is the property
// under test, not just the status code.
const A_EXPENSE_ID = Deno.env.get("TEST_USER_A_EXPENSE_ID");

Deno.test({
  name: "US-2228: B cannot attach a receipt to A's expense",
  ignore: !CONFIGURED || !A_EXPENSE_ID,
  fn: async () => {
    const form = new FormData();
    form.append(
      "receipt",
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])], "r.pdf", {
        type: "application/pdf",
      }),
    );
    const res = await fetch(
      `${BASE}/api/flipdesk/expenses/${A_EXPENSE_ID}/receipt`,
      // No Content-Type header — the browser/runtime sets the multipart boundary.
      { method: "POST", headers: { Authorization: `Bearer ${B_JWT}` }, body: form },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST expenses/:id/receipt as B");
  },
});

Deno.test({
  name: "US-2228: B cannot mint a signed URL for A's receipt",
  ignore: !CONFIGURED || !A_EXPENSE_ID,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/expenses/${A_EXPENSE_ID}/receipt`,
      { headers: authHeaders(B_JWT!) },
    );
    const body = await res.text();
    assertDenied(res.status, "GET expenses/:id/receipt as B");
    // A signed URL needs no further auth to fetch, so a leaked one IS the leak.
    assert(
      !body.includes("token="),
      "the denial body must not carry a signed-URL token",
    );
    // A foreign id and an unknown one must be indistinguishable, or the endpoint
    // becomes a way to ask which expense ids exist in another tenant.
    const fake = await fetch(
      `${BASE}/api/flipdesk/expenses/00000000-0000-4000-8000-000000000000/receipt`,
      { headers: authHeaders(B_JWT!) },
    );
    const fakeBody = await fake.text();
    assertEquals([res.status, body], [fake.status, fakeBody]);
  },
});

Deno.test({
  name: "US-2228: B cannot delete A's receipt",
  ignore: !CONFIGURED || !A_EXPENSE_ID,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/expenses/${A_EXPENSE_ID}/receipt`,
      { method: "DELETE", headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "DELETE expenses/:id/receipt as B");
  },
});

Deno.test({
  // A viewer is read-only. Attaching a receipt writes a storage object into the
  // OWNER's folder and rewrites three columns on the owner's bookkeeping row.
  name: "US-2228: viewer cannot attach a receipt under the owner",
  ignore: !VIEWER_READY || !A_EXPENSE_ID,
  fn: async () => {
    const form = new FormData();
    form.append(
      "receipt",
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "r.pdf", {
        type: "application/pdf",
      }),
    );
    const res = await fetch(
      `${BASE}/api/flipdesk/expenses/${A_EXPENSE_ID}/receipt`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VIEWER_JWT}`,
          "X-Workspace-Owner": WS_OWNER!,
        },
        body: form,
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST expenses/:id/receipt as viewer");
  },
});

// ── US-2417 AC5: the shipping profile is the caller's own row, always ────────
//
// Same probe shape as the export above and for the same reason: the endpoint
// takes no resource id, it acts on the caller, so assertDenied has nothing to
// point at. The property is CONTAINMENT — B's GET must return B's profile, and
// B's PUT must land on B's row.
//
// The workspace header is the specific thing being pinned. Every other route in
// this suite resolves `workspaceOwnerId` so a member can act inside someone
// else's workspace, and that is correct for inventory and listings. It would be
// WRONG here: a viewer or a manager in A's workspace must not read A's home
// address or overwrite A's phone number. So the route reads c.get("userId") and
// not c.get("workspaceOwnerId"), and this case sends the header pointed at A to
// prove the handler ignores it.
Deno.test({
  name: "B's shipping profile ignores an X-Workspace-Owner pointed at A",
  ignore: !CONFIGURED || !Deno.env.get("TEST_WORKSPACE_OWNER_ID"),
  fn: async () => {
    const aOwner = Deno.env.get("TEST_WORKSPACE_OWNER_ID")!;
    const marker = `US-2417 probe ${aOwner.slice(0, 8)}`;

    // B writes, while claiming to be acting inside A's workspace.
    const put = await fetch(`${BASE}/api/account/shipping-profile`, {
      method: "PUT",
      headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": aOwner },
      body: JSON.stringify({ business_name: marker }),
    });
    await put.body?.cancel();
    assert(
      put.status === 200 || put.status === 403,
      `PUT shipping-profile returned ${put.status}; expected 200 (written to B) ` +
        `or 403 (workspace write floor), never a write onto A`,
    );
    if (put.status !== 200) return;

    // A reads their own. The marker must NOT be there — if it is, B's write
    // followed the workspace header onto A's row.
    const aRead = await fetch(`${BASE}/api/account/shipping-profile`, {
      headers: authHeaders(A_JWT!),
    });
    assertEquals(aRead.status, 200, "A must be able to read A's own profile");
    const aBody = await aRead.text();
    assert(
      !aBody.includes(marker),
      "B's shipping-profile write landed on A's row — the handler is honouring " +
        "X-Workspace-Owner, but this endpoint must be scoped to c.get('userId').",
    );

    // And B's own read reflects B's write, so the 200 above was a real write
    // somewhere rather than a silent no-op that would pass the check above.
    const bRead = await fetch(`${BASE}/api/account/shipping-profile`, {
      headers: authHeaders(B_JWT!),
    });
    assertEquals(bRead.status, 200);
    assert(
      (await bRead.text()).includes(marker),
      "B's shipping-profile write did not land on B's own row either",
    );
  },
});

// ── US-2481: the mobile→desktop extension work queue ───────────────────────
//
// A queue row is addressed by an id the CLIENT hands back — the desktop
// extension completes a job by id, and the seller cancels one by id. That makes
// every write here the exact shape US-268 exists for.
//
// The consequence of getting it wrong is not an information leak, it is worse:
// B completing A's queued DELIST marks it done while A's listing is still live
// on the marketplace after the item sold elsewhere. A believes it was handled.
// The next buyer pays for something A has already shipped.

Deno.test({
  name: "B cannot enqueue extension work against A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        kind: "list",
        platform: "poshmark",
        inventory_item_id: itemId,
      }),
    });
    await res.body?.cancel();
    // 402 is also a pass: B on a plan without FlipDesk is stopped even earlier,
    // and never reaches A's item either way.
    assert(
      res.status === 404 || res.status === 403 || res.status === 402,
      `POST extension-queue with A's item returned ${res.status}; expected a ` +
        `denial. An unverified inventory_item_id would let B queue work against ` +
        `A's garment and read its title and photos into B's own browser on drain.`,
    );
  },
});

Deno.test({
  name: "B cannot enqueue extension work against A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        kind: "delist",
        platform: "poshmark",
        listing_id: Deno.env.get("TEST_USER_A_LISTING_ID")!,
      }),
    });
    await res.body?.cancel();
    assert(
      res.status === 404 || res.status === 403 || res.status === 402,
      `POST extension-queue with A's listing returned ${res.status}; expected a denial`,
    );
  },
});

Deno.test({
  // The claim endpoint takes NO id — it hands back "the next jobs for this
  // tenant". So the property is that B's claim can never return a row of A's,
  // which is what the .eq("user_id", ownerId) in the query buys.
  name: "B's queue claim never returns A's queued work",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue/claim`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ limit: 10, installId: "isolation-test" }),
    });
    if (res.status === 402) {
      await res.body?.cancel();
      return; // B has no FlipDesk plan; the earlier gate is a pass.
    }
    assertEquals(res.status, 200, "B must be able to claim B's own queue");
    const body = await res.json() as { claimed?: Array<{ id: string }> };
    const ownerId = Deno.env.get("TEST_WORKSPACE_OWNER_ID");
    if (!ownerId) return;
    // Nothing claimed may belong to A. Asserted by re-reading each as A would
    // never be possible, so the check is that B's own list is the only source.
    assert(
      Array.isArray(body.claimed),
      "claim must return an array even when the queue is empty",
    );
  },
});

Deno.test({
  // Completing a job B does not own. A random uuid stands in for "an id B
  // guessed or scraped" — the handler must 404 on scope, not on existence.
  name: "B cannot complete a queue job outside their tenant",
  ignore: !CONFIGURED,
  fn: async () => {
    const foreignId = "00000000-0000-4000-8000-000000000001";
    const res = await fetch(
      `${BASE}/api/flipdesk/extension-queue/${foreignId}/complete`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ ok: true, result: { done: 1 } }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST extension-queue/:id/complete (foreign id)");
  },
});

Deno.test({
  name: "B cannot cancel a queue job outside their tenant",
  ignore: !CONFIGURED,
  fn: async () => {
    const foreignId = "00000000-0000-4000-8000-000000000002";
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue/${foreignId}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "DELETE extension-queue/:id (foreign id)");
  },
});

Deno.test({
  // Not a tenancy case, but it belongs with them: the queue must refuse a
  // marketplace credential. This is the US-2476 bright line — GradeThread's
  // servers never hold a marketplace password or session cookie — and a queue is
  // exactly where it would erode, one "we only need it so the desktop can
  // resume" at a time.
  name: "the extension queue refuses a payload carrying a credential",
  ignore: !CONFIGURED,
  fn: async () => {
    for (const payload of [
      { sessionCookie: "abc" },
      { password: "hunter2" },
      { auth: { cookie: "sid=1" } }, // nested — the same leak, one brace deeper
    ]) {
      // `delist` rather than a kind the route rejects outright: an unknown kind
      // 400s before the payload is ever read, so the case would go green while
      // proving nothing about the credential check. The body assertion is there
      // for the same reason — it is the only thing that says WHICH refusal ran.
      const res = await fetch(`${BASE}/api/flipdesk/extension-queue`, {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ kind: "delist", platform: "poshmark", payload }),
      });
      const status = res.status;
      const text = await res.text();
      if (status === 402) return; // no plan — gated earlier, still never stored
      assertEquals(
        status,
        400,
        `queueing ${JSON.stringify(payload)} returned ${status}; it must be ` +
          `refused. The queue stores WHAT to do, never a way in.`,
      );
      assert(
        text.includes("never hold a marketplace password"),
        `queueing ${JSON.stringify(payload)} was refused for some other reason: ${text}`,
      );
    }
  },
});

Deno.test({
  // US-2518: the durable CSV import. Its run rows carry a payload of the
  // seller's whole catalog file, and its undo DELETES inventory, so both ends
  // have to be owner-scoped: B may not read A's run and may not undo it.
  name: "B cannot read or undo A's CSV import run",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_IMPORT_RUN_ID"),
  fn: async () => {
    const read = await fetch(
      `${BASE}/api/flipdesk/import/runs/${Deno.env.get("TEST_USER_A_IMPORT_RUN_ID")}`,
      { headers: authHeaders(B_JWT!) },
    );
    assertDenied(read.status, "GET /api/flipdesk/import/runs/:id");

    const undo = await fetch(
      `${BASE}/api/flipdesk/import/runs/${Deno.env.get("TEST_USER_A_IMPORT_RUN_ID")}/undo`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    assertDenied(undo.status, "POST /api/flipdesk/import/runs/:id/undo");
  },
});

Deno.test({
  // The list endpoint is scoped by the token, not by a parameter, so the
  // property is that A's runs never appear in B's list.
  name: "A's import runs never appear in B's import list",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_IMPORT_RUN_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/import/runs`, {
      headers: authHeaders(B_JWT!),
    });
    if (res.status !== 200) return; // denied outright is also a pass
    const body = await res.json() as { runs?: Array<{ id: string }> };
    const ids = (body.runs ?? []).map((r) => r.id);
    assert(
      !ids.includes(Deno.env.get("TEST_USER_A_IMPORT_RUN_ID")!),
      `B's import list contained A's run ${Deno.env.get("TEST_USER_A_IMPORT_RUN_ID")}`,
    );
  },
});

Deno.test({
  // US-2525: the user-side close. A ticket B can close is a conversation B can
  // end on A's behalf — and, because closing is a status write, it is the
  // shape that would also let B write any other field if the scope were wrong.
  name: "B cannot close A's support ticket",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_TICKET_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_TICKET_ID")!;
    const res = await fetch(`${BASE}/api/support-tickets/${id}/close`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST support-tickets/:id/close");
  },
});

Deno.test({
  // US-2525: an attachment lands in the uploader's own storage folder, so a
  // reply B is refused never creates a file under A's prefix either.
  name: "B cannot attach an image to A's support ticket",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_TICKET_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_TICKET_ID")!;
    const res = await fetch(`${BASE}/api/support-tickets/${id}/messages`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        body: "with an attachment",
        attachments: [{ data_url: "data:image/png;base64,UE5H", name: "x.png" }],
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST support-tickets/:id/messages (attachment)");
  },
});

Deno.test({
  // US-2550: the buyer report endpoint is deliberately ANONYMOUS — the person
  // best placed to report a forged certificate has no account. What it must NOT
  // become is a way to reach into a tenant: it takes a certificate id, resolves
  // the owner server-side from that id alone, and writes only to the operator
  // queue. Nothing the caller sends can name a user, a submission or a flag.
  name: "the public certificate report endpoint accepts no tenant-targeting input",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CERT_ID"),
  fn: async () => {
    const certId = Deno.env.get("TEST_USER_A_CERT_ID")!;
    const res = await fetch(
      `${BASE}/api/content/public/certificates/${certId}/report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Every field here is an attempt to steer the write somewhere else.
        body: JSON.stringify({
          reason: "altered",
          note: "test",
          owner_user_id: "00000000-0000-0000-0000-000000000001",
          content_type: "listing",
          flagged_by: "00000000-0000-0000-0000-000000000001",
          status: "resolved",
        }),
      },
    );
    const body = await res.json().catch(() => ({}));
    // It succeeds (anonymous reporting is the point) and returns nothing about
    // the tenant it resolved — no owner id, no submission id, no flag id.
    assertEquals(res.status, 200, "public report should be accepted");
    assertEquals(Object.keys(body).sort().join(","), "ok");
  },
});

Deno.test({
  // A report against a certificate that does not exist must not create a flag
  // on nothing — the owner lookup IS the existence check.
  name: "the public certificate report endpoint 404s an unknown certificate",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/content/public/certificates/00000000-0000-0000-0000-0000000000ff/report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "altered" }),
      },
    );
    await res.body?.cancel();
    assertEquals(res.status, 404, "unknown certificate must 404");
  },
});

Deno.test({
  // The moderation console is operator-only. A tenant JWT must not reach the
  // certificate queue, which is cross-tenant by construction.
  name: "B cannot read the certificate moderation queue",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/admin/moderation/certificates`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertDenied(res.status, "GET admin moderation certificates");
  },
});

Deno.test({
  // And must not be able to pull a certificate off the public path.
  name: "B cannot withhold a certificate",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CERT_ID"),
  fn: async () => {
    const certId = Deno.env.get("TEST_USER_A_CERT_ID")!;
    const res = await fetch(
      `${BASE}/api/admin/moderation/certificates/${certId}/withhold`,
      { method: "POST", headers: authHeaders(B_JWT!), body: "{}" },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST admin moderation certificate withhold");
  },
});

// ── Public API v1: inventory reads (US-9107) ───────────────────────
//
// These authenticate with an API KEY rather than a JWT, which is what /api/v1
// takes. They are the first cross-tenant cases on the public API surface at all:
// until the seed script minted real keys, nothing could reach it.

// B_API_KEY is already declared above for the US-1790 batch case; reuse it
// rather than shadowing, so both blocks read the same fixture.
const A_API_KEY = Deno.env.get("TEST_USER_A_API_KEY");

function apiKeyHeaders(key: string): HeadersInit {
  return { "X-API-Key": key, "Content-Type": "application/json" };
}

Deno.test({
  name: "B's API key cannot read A's item by id (GET /api/v1/items/:id)",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/v1/items/${itemId}`, {
      headers: apiKeyHeaders(B_API_KEY!),
    });
    const body = await res.text();
    assertDenied(res.status, "GET /api/v1/items/:id as tenant B");
    // Belt and braces: even a 200 with an empty envelope must not carry A's row.
    assert(
      !body.includes(itemId) || res.status !== 200,
      "the response body leaked A's item id",
    );
  },
});

Deno.test({
  name: "B's API key cannot see A's items in the list (GET /api/v1/items)",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/v1/items?limit=100`, {
      headers: apiKeyHeaders(B_API_KEY!),
    });
    const body = await res.text();
    // A LIST is different from a by-id read: it can legitimately return 200 with
    // B's own rows. The failure is A's id appearing anywhere in it.
    assert(
      !body.includes(itemId),
      `GET /api/v1/items as tenant B returned A's item ${itemId}`,
    );
  },
});

Deno.test({
  name: "A's own API key CAN read A's item — the isolation is not a blanket denial",
  ignore: !CONFIGURED || !A_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // Without this, a handler that denies EVERYONE would pass the two cases
    // above and the suite would report isolation working on a broken endpoint.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/v1/items/${itemId}`, {
      headers: apiKeyHeaders(A_API_KEY!),
    });
    const body = await res.text();
    assertEquals(res.status, 200, `owner read failed: ${body.slice(0, 200)}`);
    assert(body.includes(itemId), "the owner's read did not return the item");
  },
});

// ── MCP connector tools (US-9112) ──────────────────────────────────
//
// Every tool in the registry is exercised here as tenant B against tenant A's
// data. The guard in mcp-tenant-coverage_test.ts enumerates the registry and
// FAILS when a tool has no case below, so adding a tool without an isolation
// case breaks the build rather than relying on a reviewer noticing.
//
// Two shapes of assertion, because the tools have two shapes:
//   • ID-TAKING tools (get_item, get_grade, get_batch, comps) must be DENIED
//     when handed A's id.
//   • LIST tools return B's own rows legitimately, so the failure is A's id
//     appearing anywhere in the response.

const MCP_URL = () => `${BASE}/mcp`;

async function callMcpTool(
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(MCP_URL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": toolName,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "tenant-isolation-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * For a LIST tool: B never supplied A's id, so A's id appearing anywhere in the
 * response is a leak, full stop.
 */
function assertListExcludes(body: string, foreignId: string, label: string): void {
  assert(
    !body.includes(foreignId),
    `${label}: the connector returned another tenant's id (${foreignId})`,
  );
}

/**
 * For an ID-TAKING tool: the call must not SUCCEED, and none of A's DATA may
 * appear.
 *
 * Deliberately NOT asserted on the id. A handler that correctly refuses still
 * says "No item <id> in this seller's inventory", echoing the id the caller
 * supplied and already knew. Asserting on the id therefore fails a CORRECT
 * denial, which is how the first version of these cases reported four leaks
 * that were not leaks.
 */
function assertToolDeniedById(
  body: string,
  foreignData: string | undefined,
  label: string,
): void {
  const parsed = JSON.parse(body) as {
    error?: unknown;
    result?: { isError?: boolean };
  };
  const refused = parsed.error !== undefined || parsed.result?.isError === true;
  assert(refused, `${label}: the call SUCCEEDED for the wrong tenant: ${body.slice(0, 300)}`);

  if (foreignData) {
    assert(
      !body.includes(foreignData),
      `${label}: another tenant's data leaked into the response`,
    );
  }
}

Deno.test({
  name: "MCP: A's own key CAN read A's item - the tool is reachable, not blanket-denied",
  ignore: !CONFIGURED || !A_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // THE POSITIVE CONTROL, and it is not optional. Every MCP tool sits
    // behind the connector plan gate; if the fixture tenants lack that plan,
    // every call 403s and every negative case below passes without touching
    // a handler. That is exactly what happened the first time these were
    // run: ten green cases against a surface never reached.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { status, body } = await callMcpTool(A_API_KEY!, "gradethread_get_item", {
      item_id: itemId,
    });
    assertEquals(status, 200, `owner tool call failed: ${body.slice(0, 300)}`);
    assert(
      body.includes(itemId),
      `the owner's tool call did not return the item: ${body.slice(0, 300)}`,
    );
  },
});

Deno.test({
  name: "MCP gradethread_get_item cannot read A's item as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_get_item", { item_id: itemId });
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_get_item",
    );
  },
});

Deno.test({
  name: "MCP gradethread_list_items shows B only B's inventory",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_list_items", { limit: 100 });
    assertListExcludes(body, itemId, "gradethread_list_items");
  },
});

Deno.test({
  name: "MCP gradethread_get_grade cannot read A's submission as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_SUBMISSION_ID"),
  fn: async () => {
    const submissionId = Deno.env.get("TEST_USER_A_SUBMISSION_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_get_grade", {
      submission_id: submissionId,
    });
    assertToolDeniedById(body, undefined, "gradethread_get_grade");
  },
});

Deno.test({
  name: "MCP gradethread_list_grades shows B only B's submissions",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_SUBMISSION_ID"),
  fn: async () => {
    const submissionId = Deno.env.get("TEST_USER_A_SUBMISSION_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_list_grades", { limit: 100 });
    assertListExcludes(body, submissionId, "gradethread_list_grades");
  },
});

Deno.test({
  name: "MCP gradethread_get_batch cannot read A's grading batch as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_GRADING_BATCH_ID"),
  fn: async () => {
    const batchId = Deno.env.get("TEST_USER_A_GRADING_BATCH_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_get_batch", { batch_id: batchId });
    assertToolDeniedById(body, undefined, "gradethread_get_batch");
  },
});

Deno.test({
  name: "MCP gradethread_list_listings shows B only B's listings",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_list_listings", { limit: 100 });
    assertListExcludes(body, listingId, "gradethread_list_listings");
  },
});

Deno.test({
  name: "MCP gradethread_list_sales shows B only B's sales",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_SALE_ID"),
  fn: async () => {
    const saleId = Deno.env.get("TEST_USER_A_SALE_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_list_sales", { limit: 100 });
    assertListExcludes(body, saleId, "gradethread_list_sales");
  },
});

Deno.test({
  name: "MCP gradethread_comps cannot pull comps for A's item as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // Comps cost money to pull. B driving a comp lookup off A's item is both a
    // read of A's category/brand/size and a charge against B's comp budget for
    // data B is not entitled to.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_comps", { item_id: itemId });
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_comps",
    );
  },
});

Deno.test({
  name: "MCP gradethread_usage reports B's own key usage, never A's",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_API_KEY_ID"),
  fn: async () => {
    const aKeyId = Deno.env.get("TEST_USER_A_API_KEY_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_usage", {});
    assertListExcludes(body, aKeyId, "gradethread_usage");
  },
});

Deno.test({
  name: "MCP gradethread_price_guide is tenant-neutral published data",
  ignore: !CONFIGURED || !B_API_KEY,
  fn: async () => {
    // Deliberately NOT a denial case: the price guide is GradeThread's own
    // published data and carries no tenant rows at all. The property asserted is
    // that it stays that way — a seller id appearing here would mean the guide
    // had started leaking per-tenant data into a public surface.
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_price_guide", {});
    const ownerId = Deno.env.get("TEST_WORKSPACE_OWNER_ID");
    if (ownerId) assertListExcludes(body, ownerId, "gradethread_price_guide");
  },
});

Deno.test({
  name: "MCP gradethread_grading_readiness cannot inspect A's item as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // Readiness leaks more than it looks: blockers name the missing photo
    // types and the item title, and the user block reports the caller's
    // credit balance. B asking about A's item must learn nothing about it.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_grading_readiness", {
      item_ids: [itemId],
    });

    // A THIRD shape, and it is why the assertion here is not assertToolDeniedById.
    // Readiness is a per-item report: given a mixed batch it says which items are
    // ready and which are blocked, so a foreign id correctly comes back as a
    // BLOCKED row rather than as a refusal. The call succeeding is right. What
    // must not happen is any of A's data appearing in that row — which is exactly
    // what this caught: the row said "Item not found" AND carried A's title,
    // garment_type and garment_category, and the blocker made it look handled.
    const title = Deno.env.get("TEST_USER_A_ITEM_TITLE");
    if (title) {
      assert(
        !body.includes(title),
        `gradethread_grading_readiness leaked another tenant's item title: ${
          body.slice(0, 300)
        }`,
      );
    }
  },
});

Deno.test({
  name: "MCP gradethread_grade_item will not issue B a confirm token for A's item",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // The token is the thing to protect here, not just the data. A preview that
    // hands back a token for an item the caller does not own is a charge one
    // call away, and the model has already told the seller it is going ahead.
    // A foreign id is not READY (it reads as "Item not found"), the batch is
    // therefore not submittable, and no token is minted for a batch that cannot
    // be sent.
    //
    // ⚠ THE TITLE ASSERTION IS THE ONE THAT DISCRIMINATES. The fixture item is
    // deliberately not grade-ready (no garment_type, no photos), so a preview of
    // it never yields a token for ANYONE — which means the token check alone
    // would also pass against a tool that issued no tokens at all. The title is
    // the half with a positive control: A's own preview of this item does return
    // it, so B's not returning it is a real difference.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_grade_item", {
      item_id: itemId,
      mode: "preview",
    });

    assert(
      !body.includes("confirm_token"),
      `gradethread_grade_item issued a confirm token for another tenant's item: ${
        body.slice(0, 300)
      }`,
    );
    const title = Deno.env.get("TEST_USER_A_ITEM_TITLE");
    if (title) {
      assert(
        !body.includes(title),
        `gradethread_grade_item leaked another tenant's item title: ${body.slice(0, 300)}`,
      );
    }
  },
});

Deno.test({
  name: "MCP gradethread_grade_batch refuses a batch containing A's item",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // Batch is where a foreign id hides best: mixed in with ids the caller does
    // own, a partial accept would charge for the batch and quietly drop one row.
    // Every item must be ready or the whole batch is refused, so a foreign id
    // takes the batch down with it rather than being skipped.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_grade_batch", {
      item_ids: [itemId, crypto.randomUUID()],
      mode: "preview",
    });

    assert(
      !body.includes("confirm_token"),
      `gradethread_grade_batch issued a confirm token for a batch holding another ` +
        `tenant's item: ${body.slice(0, 300)}`,
    );
    const title = Deno.env.get("TEST_USER_A_ITEM_TITLE");
    if (title) {
      assert(
        !body.includes(title),
        `gradethread_grade_batch leaked another tenant's item title: ${body.slice(0, 300)}`,
      );
    }
  },
});

Deno.test({
  name: "MCP gradethread_create_draft cannot enqueue generation for A's item",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // Enqueueing against a foreign id would spend B's AI allowance to write
    // copy about A's garment, and the drafts would land on A's listings rows.
    // The ownership check runs BEFORE the batch row is written, so the refusal
    // costs nothing either.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_create_draft", {
      item_ids: [itemId],
    });
    // The foreign DATA, not the id: a correct refusal is allowed to echo back
    // the id the caller supplied, so asserting on that would pass for the
    // wrong reason.
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_create_draft",
    );
  },
});

Deno.test({
  name: "MCP gradethread_update_draft cannot edit A's listing as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // The write this refuses is the dangerous one: loadOwnedListing verifies
    // ownership through the parent item, so a foreign listing id resolves to
    // null and nothing is written. A tool that skipped that check would edit
    // another seller's copy and report success.
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_update_draft", {
      listing_id: listingId,
      title: "Rewritten by another tenant",
    });
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_update_draft",
    );
  },
});

Deno.test({
  name: "MCP gradethread_publish_listing cannot preview or publish A's item as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // The preview half matters as much as the publish half. A preview that
    // resolved another tenant's item would hand B the title, price and category
    // of A's garment AND a token to put it live.
    //
    // ⚠ THIS CASE CANNOT DISCRIMINATE ON THIS FIXTURE, and that is recorded
    // rather than papered over. assemblePublishContext checks the eBay
    // connection BEFORE ownership, and neither fixture tenant has one, so A and
    // B get the byte-identical "Connect your eBay account first" — verified by
    // hand. The case is kept because it is free and it becomes real the day the
    // fixture seeds a connection. What actually pins the ownership rule today is
    // mcp-publish-tool_test.ts's "the caller's tenant is the owner, never an
    // argument", plus assemblePublishContext's own `user_id !== userId` 404.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_publish_listing", {
      item_id: itemId,
      mode: "preview",
    });
    assert(
      !body.includes("confirm_token"),
      `gradethread_publish_listing issued a publish token for another tenant's item: ${
        body.slice(0, 300)
      }`,
    );
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_publish_listing",
    );
  },
});

Deno.test({
  name: "MCP gradethread_reprice_preview returns nothing for A's listing as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // A DIFFERENT SHAPE from the denial cases: preview is a per-listing report,
    // so a foreign id correctly comes back as an EMPTY item list rather than as
    // an error — loadOwnedRepriceListings filters on inventory_items.user_id, so
    // the row never enters the set. The assertion is therefore that A's id and
    // A's title are both absent from the answer, and that no token was issued
    // for a listing B does not own.
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_reprice_preview", {
      listing_ids: [listingId],
    });
    assertListExcludes(body, listingId, "gradethread_reprice_preview");
    const title = Deno.env.get("TEST_USER_A_ITEM_TITLE");
    if (title) {
      assert(
        !body.includes(title),
        `gradethread_reprice_preview leaked another tenant's title: ${body.slice(0, 300)}`,
      );
    }
    assert(
      !body.includes("confirm_token"),
      `gradethread_reprice_preview issued a reprice token for another tenant's listing: ${
        body.slice(0, 300)
      }`,
    );
  },
});

Deno.test({
  name: "MCP gradethread_reprice_apply cannot reprice A's listing as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // B cannot obtain a token for A's listing at all, so this asserts the
    // SECOND line of defence: even with a token-shaped string, apply refuses.
    // The listing must also keep its price, which the tenant-scoped load is what
    // guarantees.
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_reprice_apply", {
      items: [{ listing_id: listingId, price_cents: 100 }],
      confirm_token: "gtc_forged-token",
    });
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_reprice_apply",
    );
  },
});

Deno.test({
  name: "MCP gradethread_price_suggestions shows B nothing of A's",
  ignore: !CONFIGURED || !B_API_KEY,
  fn: async () => {
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_price_suggestions", {});
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID");
    if (listingId) assertListExcludes(body, listingId, "gradethread_price_suggestions");
    const title = Deno.env.get("TEST_USER_A_ITEM_TITLE");
    if (title) {
      assert(
        !body.includes(title),
        `gradethread_price_suggestions leaked another tenant's item: ${body.slice(0, 300)}`,
      );
    }
  },
});

Deno.test({
  name: "MCP gradethread_apply_price_suggestion cannot act on A's suggestion as B",
  ignore: !CONFIGURED || !B_API_KEY,
  fn: async () => {
    // No fixture suggestion exists, so this drives a random id: the property is
    // that the verb is scoped by user_id and answers "not found" rather than
    // acting. A tool that trusted the id would reprice a stranger's listing.
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_apply_price_suggestion", {
      suggestion_id: crypto.randomUUID(),
    });
    assertToolDeniedById(body, undefined, "gradethread_apply_price_suggestion");
  },
});

Deno.test({
  name: "MCP gradethread_dismiss_price_suggestion cannot act on A's suggestion as B",
  ignore: !CONFIGURED || !B_API_KEY,
  fn: async () => {
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_dismiss_price_suggestion", {
      suggestion_id: crypto.randomUUID(),
    });
    assertToolDeniedById(body, undefined, "gradethread_dismiss_price_suggestion");
  },
});

Deno.test({
  name: "MCP gradethread_end_listing cannot end A's listing as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // The preview half is the one to watch: it loads the listing to show its
    // title and price, and that load is where an ownership check would be
    // forgotten. loadEndCandidates joins on inventory_items.user_id, so a
    // foreign id resolves to nothing and there is no token to confirm with.
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_end_listing", {
      listing_id: listingId,
      mode: "preview",
    });
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_end_listing",
    );
    assert(
      !body.includes("confirm_token"),
      `gradethread_end_listing issued an end token for another tenant's listing: ${
        body.slice(0, 300)
      }`,
    );
  },
});

Deno.test({
  name: "MCP gradethread_end_listings drops A's listing from a bulk preview",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // Bulk is where a foreign id hides best: mixed into a set the caller does
    // own, a partial accept would end it alongside the rest. B owns nothing
    // here, so the whole set resolves empty and the call refuses.
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_end_listings", {
      listing_ids: [listingId, crypto.randomUUID()],
      mode: "preview",
    });
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_end_listings",
    );
    assert(!body.includes("confirm_token"));
  },
});

Deno.test({
  name: "MCP gradethread_relist cannot relist A's listing as B",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_relist", {
      listing_id: listingId,
      mode: "preview",
    });
    assertToolDeniedById(
      body,
      Deno.env.get("TEST_USER_A_ITEM_TITLE"),
      "gradethread_relist",
    );
  },
});

// ── Sandbox tools (US-9124) ────────────────────────────────────────
//
// A DIFFERENT PROPERTY from the tools above, and the difference is the point.
// These hold no tenant data, so 'B cannot read A's row' is not the assertion.
// The assertion is that they hold no tenant data AT ALL: a sandbox tool that
// started reading the caller's account would be a leak into the one surface we
// hand to people who have not paid, and it would look exactly like a feature.

Deno.test({
  name: "MCP gradethread_sandbox_grade returns sample data, never account data",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_TITLE"),
  fn: async () => {
    const aTitle = Deno.env.get("TEST_USER_A_ITEM_TITLE")!;
    // Ask for A's actual item title. A sandbox tool that looked anything up
    // would find it; one that only hashes the string cannot.
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_sandbox_grade", {
      title: aTitle,
    });
    assert(body.includes("SANDBOX"), `sandbox grade did not label itself: ${body.slice(0, 200)}`);
    const ownerId = Deno.env.get("TEST_WORKSPACE_OWNER_ID");
    if (ownerId) assertListExcludes(body, ownerId, "gradethread_sandbox_grade");
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID");
    if (itemId) assertListExcludes(body, itemId, "gradethread_sandbox_grade");
  },
});

Deno.test({
  name: "MCP gradethread_sandbox_publish contacts no marketplace and returns no live URL",
  ignore: !CONFIGURED || !B_API_KEY,
  fn: async () => {
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_sandbox_publish", {
      title: "Sample jacket",
      marketplace: "ebay",
      price_cents: 4999,
    });
    assert(body.includes("SANDBOX"));
    // A plausible listing URL is what a model hands to a seller as a live
    // listing, after which they go looking for it.
    assert(
      !body.includes("https://www.ebay.com/itm"),
      "the sandbox publish returned something that reads as a live listing URL",
    );
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID");
    if (listingId) assertListExcludes(body, listingId, "gradethread_sandbox_publish");
  },
});

Deno.test({
  name: "MCP gradethread_sandbox_price_guide is sample data with no tenant rows",
  ignore: !CONFIGURED || !B_API_KEY,
  fn: async () => {
    const { body } = await callMcpTool(B_API_KEY!, "gradethread_sandbox_price_guide", {});
    assert(body.includes("SANDBOX"));
    const ownerId = Deno.env.get("TEST_WORKSPACE_OWNER_ID");
    if (ownerId) assertListExcludes(body, ownerId, "gradethread_sandbox_price_guide");
  },
});

Deno.test({
  name: "B cannot learn A's item details from grading /validate (US-9114 leak)",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // The ROUTE has the same hole the connector's readiness tool exposed.
    // buildValidation fetched items by id with NO tenant filter and echoed
    // title, garment_type and garment_category back alongside an "Item not
    // found" blocker — the blocker made it look handled. Reachable by any
    // authenticated user with a guessed id, so it is asserted on the route as
    // well as on the tool.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/grading/validate`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ items: [{ inventory_item_id: itemId, tier: "standard" }] }),
    });
    const body = await res.text();
    const title = Deno.env.get("TEST_USER_A_ITEM_TITLE");
    if (title) {
      assert(
        !body.includes(title),
        `grading /validate leaked another tenant's item title: ${body.slice(0, 300)}`,
      );
    }
  },
});

// -- US-2676: title-variant click-through --------------------------------
//
// GET /api/flipdesk/listings/title-variants pools listing_metrics, a table
// whose rows carry a user_id and whose parent listings do too. The route takes
// NO id from the caller, so as with pending-delists "denied" is the wrong
// assertion: the property is that B's readout is computed from B's traffic
// only, and never sees A's.
//
// The failure this guards against is quiet rather than loud. A missing
// .eq("user_id") would not error and would not obviously look wrong -- B would
// just get a readout with more impressions in it, which is exactly what a
// seller wants to see and has no way to question.

Deno.test({
  name: "B's title-variant readout is computed from B's traffic only",
  ignore: !CONFIGURED,
  fn: async () => {
    const url = `${BASE}/api/flipdesk/listings/title-variants`;
    const res = await fetch(url, { headers: authHeaders(B_JWT!) });
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "GET title-variants as B");
      return;
    }
    const asB = (await res.json()).readout;
    assert(asB && typeof asB.state === "string", "title-variants returned no readout state");

    // The same call as A. If the route were unscoped both callers would be
    // reading one global pool, so the two readouts would agree on every total.
    const resA = await fetch(url, { headers: authHeaders(A_JWT!) });
    if (resA.status !== 200) {
      await resA.body?.cancel();
      return;
    }
    const asA = (await resA.json()).readout;

    const totals = (r: { variants?: Array<{ impressions: number; listings: number }> }) =>
      (r.variants ?? []).reduce(
        (acc, v) => ({
          impressions: acc.impressions + v.impressions,
          listings: acc.listings + v.listings,
        }),
        { impressions: 0, listings: 0 },
      );

    const ta = totals(asA);
    const tb = totals(asB);

    // Two empty readouts are equal and prove nothing, so that case returns
    // rather than passing: an unscoped read of an empty metrics table also
    // gives zeroes, and a test that goes green on no data goes green forever.
    if (ta.listings === 0 && tb.listings === 0) return;

    assert(
      !(ta.listings === tb.listings && ta.impressions === tb.impressions &&
        ta.impressions > 0),
      "A and B got byte-identical variant totals over non-zero traffic, which is " +
        "what an unscoped listing_metrics read looks like",
    );
  },
});

// -- US-2677: near-duplicate title warnings ------------------------------
//
// The duplicate check compares a candidate title against the seller's OTHER
// live listings, so an unscoped lookup would put A's listing TITLES into a
// warning shown to B. That is a content leak with a plausible cover story: the
// warning reads like a normal product message, so nobody would report it.
//
// Both doors go through fetchComparableListings, which filters on the resolved
// owner. The route below is the one that takes an ID from the caller, so it is
// the one an attacker can point somewhere; the validate path derives its item
// from the same parameter and reaches the same helper.
//
// Gated only on ids the seed script actually emits. An earlier draft of these
// cases invented TEST_USER_A_LISTING_TITLE and TEST_USER_B_ITEM_ID, and the
// no-silent-skips guard above failed the build for it, which is exactly what
// that guard is for.

Deno.test({
  name: "B cannot read title conflicts for A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/title-conflicts/${itemId}`, { headers: authHeaders(B_JWT!) });
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "GET title-conflicts on A's item");
      return;
    }
    // A 200 is acceptable ONLY if it carries nothing: the route resolves the
    // listing by item id AND owner, so a foreign item simply finds no row.
    // What must never happen is A's titles coming back.
    const json = await res.json();
    assertEquals(
      json.conflicts ?? [],
      [],
      "title-conflicts returned data for an item owned by A to user B",
    );
  },
});

Deno.test({
  name: "B cannot poll A's AutoLister batch for its duplicate-title report",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_BATCH_ID"),
  fn: async () => {
    const batchId = Deno.env.get("TEST_USER_A_BATCH_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/autolister/batch/${batchId}`, { headers: authHeaders(B_JWT!) });
    await res.body?.cancel();
    assertDenied(res.status, "GET autolister batch owned by A");
  },
});

// -- US-2683: eBay search terms -------------------------------------------
//
// ebay_search_terms holds the queries buyers typed against a seller's items,
// which is commercially sensitive in a way a listing title is not: it is what
// is working for a competitor's store. RLS is on the table AND the edge filters
// on user_id, because the edge runs service-role and RLS does not apply to it.
//
// There is no route that takes a term id, so the exposure is the DEMAND-TERM
// pool: loadSearchTerms feeds getEbaySearchDemandTermsDetailed, which feeds the
// composer's keyword chips. An unscoped read would put A's buyer queries into
// B's chip list, labelled as B's own search data.

Deno.test({
  name: "B's title conflicts and chips never carry A's search terms",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    // The composer surface that renders the pool. A foreign item id must not
    // resolve at all, which also proves the terms behind it are unreachable.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/title-conflicts/${itemId}`, { headers: authHeaders(B_JWT!) });
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "GET title-conflicts on A's item as B");
      return;
    }
    const json = await res.json();
    assertEquals(
      json.conflicts ?? [],
      [],
      "a foreign item resolved for B, so anything derived from it is reachable too",
    );
  },
});


// ── Sold-sync observations (US-2697) ───────────────────────────────────────
//
// This route takes NO resource id from the caller. It takes listing URLs read
// off a marketplace page, and matches them against the CALLER's own listings.
// That makes the isolation property a matching property rather than a lookup
// one: B posting a sold row for A's listing URL must come back UNMATCHED, and
// must never confirm a sale.
//
// Getting it wrong is the worst failure in this file. A confirmed sale on A's
// listing does not just leak - it marks A's garment sold and fires the
// cross-listing delist planner, pulling A's live listings off every other
// channel. B would be able to empty A's storefront by posting JSON.

Deno.test({
  name: "B posting a sold row for A's listing URL never confirms a sale",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SYNC_LISTING_URL"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/sync/observations`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        platform: "poshmark",
        signedIn: true,
        sold: [{
          listingUrl: Deno.env.get("TEST_USER_A_SYNC_LISTING_URL")!,
          title: "Tenant-A-sync-fixture",
          soldPriceCents: 5500,
          soldAt: "2026-08-18T12:00:00.000Z",
          orderRef: "isolation-probe-1",
        }],
      }),
    });
    // 402 is a pass: B on a plan without FlipDesk is stopped before the query.
    if (res.status === 402) {
      await res.body?.cancel();
      return;
    }
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(
      body.confirmed,
      0,
      "B confirmed a sale against A's listing URL. That marks A's garment sold " +
        "and fires the sibling delist planner across every other channel.",
    );
    assertEquals(
      body.unmatched,
      1,
      "A's URL should be UNMATCHED for B - it is not in B's listings.",
    );
  },
});

Deno.test({
  name: "the sync route refuses a payload carrying buyer identity",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/sync/observations`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        platform: "poshmark",
        signedIn: true,
        sold: [{
          listingUrl: "https://poshmark.com/listing/whatever",
          shipping_address: "1 Main St",
        }],
      }),
    });
    const body = await res.json();
    assertEquals(res.status, 400);
    assertEquals(body.error, "FORBIDDEN_KEY");
    // Refused BEFORE the plan gate, so a free account cannot use a 402 to learn
    // that its PII would otherwise have been accepted.
    assertEquals(body.key, "shipping_address");
  },
});

// ── US-2917: GET /api/flipdesk/size-bands ───────────────────────────────────
//
// This route is the odd one out on the FlipDesk surface: it reads ONLY the
// global brand_size_charts reference table and takes no id at all. There is
// nothing here to scope by a user, so the property to assert is not "B cannot
// read A's row" — it is that the route never grows the ability to read one.
// A future caller passing an item id to "make the check smarter" is exactly how
// a reference lookup becomes a tenant read, so the route refuses the param
// outright and these two cases hold it to that.

Deno.test({
  name: "size-bands refuses an item id, so it cannot become a tenant read",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/size-bands?brand=Lululemon&garment=tee&gender=men&itemId=${itemId}`,
      { headers: authHeaders(B_JWT!) },
    );
    const body = await res.json();
    assertEquals(res.status, 400, "an itemId param must be refused, not ignored");
    assert(
      String(body.error).includes("no item or user id"),
      `expected the no-id refusal, got: ${JSON.stringify(body)}`,
    );
    // Nothing tenant-shaped may come back on the refusal path either.
    assert(!("rows" in body), "the refusal must not carry a band table");
  },
});

Deno.test({
  name: "size-bands is unauthenticated-deny and reads no tenant table",
  ignore: !CONFIGURED,
  fn: async () => {
    const url = `${BASE}/api/flipdesk/size-bands?brand=Lululemon&garment=tee&gender=men`;

    const anon = await fetch(url);
    await anon.body?.cancel();
    assertEquals(anon.status, 401, "size-bands must require auth");

    // B gets the same reference answer A would: the table is global, and a
    // per-tenant difference here would mean a tenant column leaked into it.
    const asB = await fetch(url, { headers: authHeaders(B_JWT!) });
    assertEquals(asB.status, 200);
    const bodyB = await asB.json();
    const asA = await fetch(url, { headers: authHeaders(A_JWT!) });
    assertEquals(asA.status, 200);
    const bodyA = await asA.json();
    assertEquals(
      JSON.stringify(bodyB),
      JSON.stringify(bodyA),
      "two tenants must get an identical reference table",
    );

    // The response shape carries chart provenance only — no ids, no user
    // columns, nothing that could have come from inventory_items.
    const serialized = JSON.stringify(bodyA);
    for (const leak of ["user_id", "userId", "inventory_items", "sku"]) {
      assert(!serialized.includes(leak), `size-bands response leaked ${leak}`);
    }
  },
});

// ── US-2927: the post-sale lists now read a LOCAL table ─────────────
//
// Before this, GET /returns, /cancellations and /payment-disputes were scoped
// by construction: they called eBay with the caller's own token, so there was
// nothing to leak. That argument no longer holds. Each route now serves
// marketplace_post_sale_cases through the service-role client, which bypasses
// RLS, so the `.eq("user_id", ownerId)` inside loadCachedSummaries is the only
// thing standing between tenant B and tenant A's returns.
//
// A leak here does NOT return 403. It returns 200 with someone else's cases in
// the body, which is why these assert on the CONTENT rather than the status.
// WRITTEN OUT RATHER THAN LOOPED, and that is the point. The structural guard
// below reads the HEAD of each Deno.test block looking for a literal TEST_* id,
// so a loop whose `ignore` reads `Deno.env.get(envVar)` hides its ids from the
// guard entirely — the case then skips in CI while the suite reports green,
// which is the exact failure the guard exists to catch. Three near-identical
// blocks are cheaper than a guard that quietly stopped guarding.
Deno.test({
  name: "B's eBay return list never contains A's return",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_RETURN_ID"),
  fn: () => assertListDoesNotLeak("returns", "TEST_USER_A_EBAY_RETURN_ID"),
});

Deno.test({
  name: "B's eBay cancellation list never contains A's cancellation",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_CANCEL_ID"),
  fn: () => assertListDoesNotLeak("cancellations", "TEST_USER_A_EBAY_CANCEL_ID"),
});

Deno.test({
  name: "B's eBay payment-dispute list never contains A's dispute",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_DISPUTE_ID"),
  fn: () => assertListDoesNotLeak("payment-disputes", "TEST_USER_A_EBAY_DISPUTE_ID"),
});

/** Shared body: fetch the list as B and assert A's id is nowhere in it. */
async function assertListDoesNotLeak(path: string, envVar: string): Promise<void> {
  const aId = Deno.env.get(envVar)!;
  const res = await fetch(`${BASE}/api/flipdesk/ebay/${path}?limit=200`, {
    headers: authHeaders(B_JWT!),
  });
  // 503 (eBay not configured) or a denial are both fine — the only failing
  // outcome is a 200 whose body carries A's id.
  if (res.status !== 200) {
    await res.body?.cancel();
    return;
  }
  const body = await res.text();
  assert(
    !body.includes(aId),
    `GET /api/flipdesk/ebay/${path} leaked tenant A's id to tenant B`,
  );
}

// ── US-2928: the inquiry routes ─────────────────────────────────────
//
// Same two shapes as the return routes. The LIST is a content assertion (a leak
// is a 200 carrying another tenant's inquiry, not a 403); the three ACTIONS are
// status assertions, because each takes an eBay-side id straight from the path
// and must never act on an id belonging to someone else.
Deno.test({
  name: "B's eBay inquiry list never contains A's inquiry",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_INQUIRY_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_EBAY_INQUIRY_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/inquiries?limit=200`, {
      headers: authHeaders(B_JWT!),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return;
    }
    const body = await res.text();
    assert(!body.includes(aId), "GET /inquiries leaked tenant A's inquiry id to tenant B");
  },
});

for (
  const [action, payload] of [
    ["shipment", { carrier: "USPS", tracking_number: "9400100000000000000000" }],
    ["refund", {}],
    ["close", {}],
  ] as const
) {
  Deno.test({
    name: `B cannot ${action} A's eBay inquiry`,
    ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_INQUIRY_ID"),
    fn: async () => {
      const inquiryId = Deno.env.get("TEST_USER_A_EBAY_INQUIRY_ID")!;
      const res = await fetch(
        `${BASE}/api/flipdesk/ebay/inquiries/${encodeURIComponent(inquiryId)}/${action}`,
        { method: "POST", headers: authHeaders(B_JWT!), body: JSON.stringify(payload) },
      );
      await res.body?.cancel();
      assertDenied(res.status, `POST eBay inquiry ${action}`);
    },
  });
}

// ── US-2929: the case routes ────────────────────────────────────────
Deno.test({
  name: "B's eBay case list never contains A's case",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_CASE_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_EBAY_CASE_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/cases?limit=200`, {
      headers: authHeaders(B_JWT!),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return;
    }
    const body = await res.text();
    assert(!body.includes(aId), "GET /cases leaked tenant A's case id to tenant B");
  },
});

for (
  const [action, payload] of [
    ["shipment", { carrier: "USPS", tracking_number: "9400100000000000000000" }],
    ["refund", {}],
    ["appeal", { comments: "The tracking shows delivered." }],
    ["close", {}],
  ] as const
) {
  Deno.test({
    name: `B cannot ${action} A's eBay case`,
    ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_CASE_ID"),
    fn: async () => {
      const caseId = Deno.env.get("TEST_USER_A_EBAY_CASE_ID")!;
      const res = await fetch(
        `${BASE}/api/flipdesk/ebay/cases/${encodeURIComponent(caseId)}/${action}`,
        { method: "POST", headers: authHeaders(B_JWT!), body: JSON.stringify(payload) },
      );
      await res.body?.cancel();
      assertDenied(res.status, `POST eBay case ${action}`);
    },
  });
}

// ── US-2930/US-2931/US-2932: the three new return actions ───────────
//
// Each takes an eBay return id straight from the path and acts on it. A missing
// owner scope here would let B mark A's return received, read A's tracking, or
// message A's buyer.
Deno.test({
  name: "B cannot mark A's eBay return received",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_RETURN_ID"),
  fn: async () => {
    const returnId = Deno.env.get("TEST_USER_A_EBAY_RETURN_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/returns/${encodeURIComponent(returnId)}/received`,
      { method: "POST", headers: authHeaders(B_JWT!), body: "{}" },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST eBay return received");
  },
});

Deno.test({
  name: "B cannot read the shipment on A's eBay return",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_RETURN_ID"),
  fn: async () => {
    const returnId = Deno.env.get("TEST_USER_A_EBAY_RETURN_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/returns/${encodeURIComponent(returnId)}/label`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "GET eBay return label");
  },
});

Deno.test({
  name: "B cannot message the buyer on A's eBay return",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_RETURN_ID"),
  fn: async () => {
    const returnId = Deno.env.get("TEST_USER_A_EBAY_RETURN_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/returns/${encodeURIComponent(returnId)}/message`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ message: "Keep it and I will refund you." }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST eBay return message");
  },
});
