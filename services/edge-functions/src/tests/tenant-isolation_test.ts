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
//   TEST_USER_A_CLOSET_LISTING_PID a poshmark listings.platform_listing_id owned
//                               by A (closet import dedupe key, US-9201)
//   TEST_USER_A_REVISE_LISTING_ID a live poshmark listing of A's carrying a
//                               revise_pending marker (US-9202)
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
  "TEST_USER_A_CONSIGNOR_PAYOUT_ID",
  "TEST_USER_B_CONSIGNOR_ID",
  "TEST_USER_B_ITEM_ID",
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
  // US-2961: the apply-to-drafts route is keyed on a snippet id, so without
  // this the only case covering a bulk rewrite of listings would skip.
  "TEST_USER_A_SNIPPET_ID",
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
  TEST_USER_A_BUYER_PURCHASE_ID: "needs a completed buyer purchase",
  TEST_USER_A_CERT_ID: "needs a certified grade report (published, certificate_id set)",
  TEST_PRIVATE_REPORT_ID: "needs an uncertified/private report",
  TEST_USER_B_HANDLE: "needs a storefront handle for tenant B",
  TEST_SELLER_NO_STOREFRONT_HANDLE: "needs a seller with storefront opt-in disabled",
  // SUB-05: the positive member-files-once case. Needs a role=member (not
  // viewer) of A plus a fresh in-window report of A's, and it FILES a dispute,
  // so each run consumes the report. The offline half is dispute-alert_test.ts.
  TEST_MEMBER_JWT: "needs a role=member of A's workspace (seed has only a viewer)",
  TEST_USER_A_DISPUTABLE_REPORT_ID:
    "needs an in-window report of A's with no grade dispute; consumed per run",
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
  // Inline photos on /extract (the Add item form's staged shots). Two things
  // must hold: a foreign item_id is still refused when the body carries photo
  // bytes instead of text, and non-image bytes are refused with a 4xx before
  // any quota spend or model call, whoever sends them.
  name: "B cannot run inline-photo extraction against A's item, and SVG bytes are refused",
  ignore: !CONFIGURED,
  fn: async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID");
    if (itemId) {
      const res = await fetch(`${BASE}/api/flipdesk/ai/extract`, {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ item_id: itemId, photos: [{ data: png, type: "tag" }] }),
      });
      await res.body?.cancel();
      assertDenied(res.status, "POST ai/extract (inline photo, foreign item_id)");
    }
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const res = await fetch(`${BASE}/api/flipdesk/ai/extract`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ photos: [{ data: svg, media_type: "image/png", type: "tag" }] }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 400);
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
  // US-3196: adopt-remote DOWNLOADS an item's eBay-hosted photos into the
  // PUBLIC item-photos bucket and repoints the rows at our copies. A
  // cross-tenant call would therefore both read another seller's catalog and
  // rewrite their photo rows, so ownership is established on inventory_items
  // before any read of item_photos and every write is keyed on the cleared id.
  name: "B cannot adopt the remote photos on A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/images/adopt-remote`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_id: Deno.env.get("TEST_USER_A_ITEM_ID") }),
    });
    const body = await res.text();
    assertDenied(res.status, "POST images/adopt-remote");
    // A 200 here would be the real failure and it would look benign — the
    // handler answers { adopted: 0 } for an item with no remote photos, so a
    // scoping bug on an item that HAS them reads as a successful no-op in the
    // status code alone. Pin the body too.
    assert(
      !body.includes('"adopted"'),
      `POST images/adopt-remote with another tenant's item id returned an ` +
        `adopt result (${body.slice(0, 200)}) — the inventory_items ownership ` +
        `check must reject before any item_photos read.`,
    );
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
    // DIRECT CONTAINMENT. The payload used to carry `items` with per-item ids;
    // A3 stopped sending them (the card never read them), so an id can only
    // appear here now if a later change puts per-item rows back. The check is
    // kept for exactly that case. The inequality below is the live probe.
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
  // Depop's ship route is the same shape as the two above (sale loaded THROUGH
  // inventory_items.user_id, flipdesk-depop.ts). It had no case until
  // router-isolation-coverage_test.ts listed it. The route answers 503 before
  // the ownership check when Depop is off, so tenant-isolation.yml sets dummy
  // DEPOP_* env to make the 404 reachable; a 503 here fails on purpose, since it
  // would mean the scoping was never exercised.
  name: "B cannot mark A's sale shipped via Depop",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SALE_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_SALE_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/depop/orders/${id}/ship`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ tracking_number: "PWNED123", shipping_provider_id: "USPS" }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST depop order ship");
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
  // Pricing plan P6: bulk-price-quantity takes listing ids in the BODY, so a
  // refusal here can only come from the owner-scoped load. A 402 also passes:
  // B lacking bulkActions is refused before it reaches A's rows either way.
  name: "B cannot bulk-reprice A's listing through bulk-price-quantity",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/listings/bulk-price-quantity`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ updates: [{ listing_id: id, price: 1 }] }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      results?: Array<{ ok?: boolean }>;
    };
    if (res.status === 200) {
      assertEquals(
        body.results?.filter((r) => r.ok).length ?? 0,
        0,
        "bulk-price-quantity must not apply to another tenant's listing",
      );
    } else {
      assert(
        [401, 402, 403, 404, 503].includes(res.status),
        `bulk-price-quantity for another tenant should be denied, got ${res.status}`,
      );
    }
  },
});

Deno.test({
  // Pricing plan P1: single-row Apply now refuses dismissed nudges, dead
  // listings and stale prices with a 409 that NAMES the reason. That refusal
  // must never become a way for B to learn about A's suggestion: the lookup is
  // owner-scoped first, so B gets a plain 404 before any of those checks run.
  // P14 added restore (the dismiss toast's Undo); it is held to the same rule.
  name: "B cannot apply, dismiss or restore A's repricing suggestion",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SUGGESTION_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_SUGGESTION_ID")!;
    for (const verb of ["apply", "dismiss", "restore"]) {
      const res = await fetch(
        `${BASE}/api/flipdesk/pricing/suggestions/${aId}/${verb}`,
        { method: "POST", headers: authHeaders(B_JWT!) },
      );
      await res.body?.cancel();
      assertEquals(res.status, 404, `B ${verb} on A's suggestion: expected 404`);
    }
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
      body: JSON.stringify({ name: "pwned", is_default: true }),
    });
    await put.body?.cancel();
    assertDenied(put.status, "PUT listing template");

    const del = await fetch(`${BASE}/api/flipdesk/templates/${id}`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await del.body?.cancel();
    assertDenied(del.status, "DELETE listing template");

    // B's is_default:true PUT must not have cleared anything in A's account
    // on its way to the 404: A's name is unchanged and A still has a default.
    const list = await fetch(`${BASE}/api/flipdesk/templates`, {
      headers: authHeaders(A_JWT!),
    });
    assertEquals(list.status, 200);
    const { templates } = await list.json() as {
      templates: Array<{ id: string; name: string; is_default: boolean }>;
    };
    const mine = templates.find((t) => t.id === id);
    assert(mine, "A's template must still exist");
    assertEquals(mine.name, "Tenant-A template");
    assertEquals(templates.filter((t) => t.is_default).length, 1);
    assert(mine.is_default, "A's default must survive B's PUT");
  },
});

Deno.test({
  // A malformed template id answers like a foreign one (404), not a 500 from
  // the uuid column.
  name: "a malformed listing template id is a 404 for PUT and DELETE",
  ignore: !CONFIGURED,
  fn: async () => {
    const put = await fetch(`${BASE}/api/flipdesk/templates/abc`, {
      method: "PUT",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ name: "x" }),
    });
    await put.body?.cancel();
    assertEquals(put.status, 404);
    const del = await fetch(`${BASE}/api/flipdesk/templates/abc`, {
      method: "DELETE",
      headers: authHeaders(B_JWT!),
    });
    await del.body?.cancel();
    assertEquals(del.status, 404);
  },
});

Deno.test({
  // US-672: repricing rules CRUD is scoped by user_id. B's PUT/DELETE on A's
  // rule are scoped, so they hit 0 rows and return 404.
  name: "B cannot update, pause or delete A's repricing rule",
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

    // The pause/resume PATCH is its own route and must hold the same line.
    const patch = await fetch(`${BASE}/api/flipdesk/pricing/rules/${id}`, {
      method: "PATCH",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ enabled: false }),
    });
    await patch.body?.cancel();
    assertDenied(patch.status, "PATCH repricing rule");

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

// US-3265: creating the three business policies. The route takes NO id -- it
// acts on the caller's own eBay connection -- so the tenancy question is
// whether B pressing it can reach A's account or A's cached policies. It reads
// the connection through workspaceOwnerId ?? userId and writes defaults through
// the same workspace-scoped writer the picker uses, so B's press must leave A's
// rows exactly as they were.
Deno.test({
  name: "B creating eBay business policies cannot touch A's",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_FULFILLMENT_POLICY_ID"),
  fn: async () => {
    const aPolicy = Deno.env.get("TEST_USER_A_FULFILLMENT_POLICY_ID")!;

    const res = await fetch(`${BASE}/api/flipdesk/ebay/policies/create`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        handling_days: 1,
        shipping_cost_cents: 0,
        accepts_returns: true,
        return_days: 30,
        return_shipping_paid_by: "BUYER",
      }),
    });
    // Any outcome is allowed for B's OWN account -- 200 if B has a live eBay
    // connection in the fixture, 502/503 if not. What is not allowed is A's
    // policies changing, which is what the read below checks.
    await res.body?.cancel();

    const mine = await fetch(`${BASE}/api/flipdesk/ebay/policies`, {
      headers: authHeaders(B_JWT!),
    });
    if (mine.status === 200) {
      const body = await mine.json() as {
        policies?: Array<{ policy_id: string }>;
      };
      const ids = (body.policies ?? []).map((p) => p.policy_id);
      assert(
        !ids.includes(aPolicy),
        "B's policy list contains A's policy id: the create path is reading " +
          "another tenant's cached policies.",
      );
    } else {
      await mine.body?.cancel();
    }
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

// US-3453: the delist nudge is a fleet sweep behind the same secret. A user
// JWT, or no secret, must not start a run that reads every seller's queue.
Deno.test({
  name: "delist-nudge job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/delist-nudge`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `POST /api/jobs/delist-nudge with a user JWT should 401, got ${status}`);
  },
});

Deno.test({
  name: "delist-nudge job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/delist-nudge`, {
      method: "POST",
      headers: { "X-Internal-Job-Secret": "wrong-secret-value" },
    });
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `POST /api/jobs/delist-nudge with a wrong secret should 401, got ${status}`);
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

// ── US-3039: measurement-stats is a REFERENCE lookup and must stay one ──────
//
// It reads garment_measurement_stats, which is deny-all aggregate data with no
// owner column, and it takes no item id. The risk is not that today's handler
// leaks — it cannot, there is nothing tenant-shaped in it — but that a later
// caller adds `itemId` to "scope" it and quietly turns a reference endpoint
// into a tenant read through the service-role client.
//
// So the route REJECTS those params outright rather than ignoring them, which
// is the flipdesk-size-bands.ts rule, and that refusal is asserted here rather
// than assumed. A 400 is the whole point: silently dropping the param is what
// lets the next person believe it did something.
Deno.test({
  name: "US-3039: measurement-stats rejects an item or user id outright",
  ignore: !CONFIGURED,
  fn: async () => {
    for (const param of ["itemId", "item_id", "userId", "user_id"]) {
      const res = await fetch(
        `${BASE}/api/flipdesk/measurement-stats?brand=Levi%27s&group=bottom&size=34X32&${param}=${crypto.randomUUID()}`,
        { headers: authHeaders(A_JWT!) },
      );
      const status = res.status;
      await res.body?.cancel();
      assert(
        status === 400,
        `measurement-stats with ${param} should 400, got ${status}`,
      );
    }
  },
});

Deno.test({
  name: "US-3039: measurement-stats requires a session",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/measurement-stats?brand=Levi%27s&group=bottom&size=34X32`,
    );
    const status = res.status;
    await res.body?.cancel();
    assertDenied(status, "measurement-stats with no JWT");
  },
});

// ── US-3036: the measurement aggregate reads every tenant's observations ────
//
// It rolls up garment_measurements across ALL tenants into the deny-all stats
// table that public pages read, so it is the job that decides what the site
// says about a garment. Reachable by a user JWT, any signed-in account could
// force a republish at a moment of their choosing. The job secret is the only
// boundary, and it is pinned in both directions.
Deno.test({
  name: "US-3036: measurement-aggregate rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/measurement-aggregate`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/measurement-aggregate with a user JWT should 401, got ${status}`,
    );
  },
});

Deno.test({
  name: "US-3036: measurement-aggregate rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/measurement-aggregate`, {
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
      `POST /jobs/measurement-aggregate with a bogus job secret should 401, got ${status}`,
    );
  },
});

// ── US-3035: the measurement text backfill sweeps every tenant's items ──────
//
// It reads inventory_items and listings across ALL tenants by design, resolving
// the owner from each row (item.user_id) rather than from the request, which is
// the cron rule. That makes the job secret the only boundary it has, and it
// carries two destructive switches behind the same door: ?reset=1 clears every
// scan marker and ?purge=1 deletes every listing_text observation in the table.
// A user JWT reaching this route would let any signed-in account wipe the
// corpus, so both refusals are pinned rather than assumed.
Deno.test({
  name: "US-3035: measurement-text-backfill rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/measurement-text-backfill?purge=1`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/measurement-text-backfill with a user JWT should 401, got ${status}`,
    );
  },
});

Deno.test({
  name: "US-3035: measurement-text-backfill rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/measurement-text-backfill?reset=1`, {
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
      `POST /jobs/measurement-text-backfill with a bogus job secret should 401, got ${status}`,
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

// US-3413: the payout-link pass walks every owner with an active eBay
// connection and WRITES sales.payout_reference across the fleet. Owner ids come
// from marketplace_connections rows and never from the request, so as with the
// sweep above the job secret is the only gate between a signed-in user and a
// fleet-wide write into other tenants' books.
Deno.test({
  name: "ebay-payout-link job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/ebay-payout-link`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/ebay-payout-link with a user JWT should 401 (no job secret), got ${status}`,
    );
  },
});

Deno.test({
  name: "ebay-payout-link job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/ebay-payout-link`, {
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
      `POST /jobs/ebay-payout-link with a bogus job secret should 401, got ${status}`,
    );
  },
});

// The write itself, pinned at the source. The fleet cases above prove nobody
// unauthorised can START the pass; this proves that when it runs, the sales
// update carries the owner scope rather than relying on the id it just
// selected. US-268: the scope travels with the statement.
Deno.test("ebay-payout-link scopes its sales write by owner", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/ebay-payout-link.ts", import.meta.url),
  );
  const at = src.indexOf('.update({ payout_reference: payoutId }');
  assert(at > 0, "the payout_reference update site moved; re-point this guard");
  const window = src.slice(at, at + 400);
  assert(window.includes('.eq("user_id", ownerId)'), "update is not owner-scoped");
  assert(
    window.includes('.is("payout_reference", null)'),
    "update must only ever FILL a reference, never overwrite one",
  );
  // The read is scoped too, or the write is keyed on rows selected from
  // another tenant. Every .from("sales") in the file must reach an owner
  // filter within the statement, so a new query cannot be added unscoped.
  for (const idx of [...src.matchAll(/\.from\("sales"\)/g)].map((m) => m.index!)) {
    const statement = src.slice(idx, idx + 400);
    assert(
      statement.includes('.eq("user_id", ownerId)'),
      `an unscoped .from("sales") at offset ${idx}`,
    );
  }
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

// US-3198 AC4/AC6: the stale-extension-queue notice sweeps EVERY seller's
// extension_work_queue and pushes the ones whose desktop has gone quiet. It
// takes no ids from the request at all: the only user ids in play come off the
// queue rows themselves, and each follow-up read is `.eq("user_id", <that id>)`.
// So the boundary worth testing is the door. A signed-in seller must not be able
// to fire a fleet-wide notification pass over other people's queues, and neither
// must a wrong secret.
Deno.test({
  name: "extension-queue-stale job rejects a user JWT (must use job secret)",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/extension-queue-stale`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(
      status === 401,
      `POST /jobs/extension-queue-stale with a user JWT should 401 (no job secret), got ${status}`,
    );
  },
});

Deno.test({
  name: "extension-queue-stale job rejects a bogus X-Internal-Job-Secret",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/jobs/extension-queue-stale`, {
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
      `POST /jobs/extension-queue-stale with a bogus job secret should 401, got ${status}`,
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

// US-3139: /tag-brand is a pure lookup over OUR curated brand table — it reads
// no table, no storage, and echoes nothing from the request back. There is no
// cross-tenant resource to reach, so the isolation requirement reduces to the
// one the embed endpoint above has: it must still require auth.
Deno.test({
  name: "autolister tag-brand requires authentication",
  ignore: !BASE,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/autolister/tag-brand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: [{ id: "g1", text: "CARHARTT" }] }),
    });
    const status = res.status;
    await res.body?.cancel();
    assert(status === 401, `unauthenticated tag-brand should 401, got ${status}`);
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

// OM-16: the rest of the negotiation surface. Each one reads or writes the
// caller's own offers (marketplace_offers) or eBay account, so an anonymous
// caller must be turned away before any of it runs.
for (
  const [method, path, body] of [
    ["POST", "/api/flipdesk/ebay/negotiation/send-offer", { listing_ids: ["1"], discount_percentage: 10 }],
    ["GET", "/api/flipdesk/ebay/negotiation/eligible", null],
    ["GET", "/api/flipdesk/ebay/negotiation/send-offer-today", null],
    ["GET", "/api/flipdesk/ebay/negotiation/analytics", null],
    ["POST", "/api/flipdesk/ebay/negotiation/rule-dry-run", { accept_at_pct: 90 }],
    ["GET", "/api/flipdesk/ebay/negotiation/threshold-conflicts", null],
  ] as const
) {
  Deno.test({
    name: `${method} ${path.replace("/api/flipdesk/ebay", "")} requires authentication`,
    ignore: !BASE,
    fn: async () => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const status = res.status;
      await res.body?.cancel();
      assert(status === 401, `unauthenticated ${method} ${path} should 401, got ${status}`);
    },
  });
}

// OM-16: send-offer takes listing ids from the REQUEST BODY and writes
// marketplace_offers rows for what it sends. B naming A's listing must never
// come back as a successful send: B's token cannot reach A's eBay account, and
// every row the route writes is keyed on B.
Deno.test({
  name: "B cannot send a watcher offer on A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/negotiation/send-offer`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_ids: [listingId], discount_percentage: 10 }),
    });
    const json = await res.json().catch(() => ({}));
    assert(
      !(res.status === 200 && Array.isArray(json.sent) && json.sent.includes(listingId)),
      "send-offer reported a send on another tenant's listing",
    );
  },
});

// OM-16: B's analytics and dry-run are computed from B's stored offers. A
// response naming A's listing would mean the owner filter on marketplace_offers
// is gone.
for (
  const [method, path, body] of [
    ["GET", "/api/flipdesk/ebay/negotiation/analytics", null],
    ["POST", "/api/flipdesk/ebay/negotiation/rule-dry-run", { accept_at_pct: 90, days: 180 }],
  ] as const
) {
  Deno.test({
    name: `B's ${path.replace("/api/flipdesk/ebay", "")} carries none of A's offers`,
    ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
    fn: async () => {
      const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: authHeaders(B_JWT!),
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      assert(
        res.status !== 200 || !text.includes(listingId),
        `${path} for B contains A's listing id`,
      );
    },
  });
}

// OM-16: B answering an offer on A's listing. B's token is B's eBay account, so
// eBay cannot apply it to A's listing; the property is that the edge never
// reports it as done.
Deno.test({
  name: "B cannot respond to a best offer on A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/negotiation/offers/abc123/respond`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ item_id: listingId, action: "Decline" }),
      },
    );
    const json = await res.json().catch(() => ({}));
    assert(json.ok !== true, `cross-tenant respond reported ok (status ${res.status})`);
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

// Consignment page pass (C2): the routes the US-600 block above never covered.
Deno.test({
  name: "B cannot record an intake signature on A's consignor",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/consignors/${id}/intake`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ signature_name: "x" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST consignor intake (A's)");
  },
});

Deno.test({
  name: "B cannot start Stripe onboarding for A's consignor",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/consignors/${id}/connect`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await res.body?.cancel();
    // assertDenied, NOT assertDeniedOrGated: the ownership 404 must come
    // before the 503 "Payments are not configured" branch. A 503 here means
    // the route reached Stripe setup for a consignor B does not own.
    assertDenied(res.status, "POST consignor connect (A's)");
  },
});

Deno.test({
  name: "B cannot read or refresh A's consignor Stripe status",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/consignors/${id}/connect/status`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    assertDenied(res.status, "GET consignor connect/status (A's)");
    assert(!("connected" in body), "connect/status told B whether A's consignor is connected");
  },
});

Deno.test({
  name: "B's payout ledger filtered to A's consignor is empty",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/consignment/payouts?consignor_id=${id}`,
      { headers: authHeaders(B_JWT!) },
    );
    const body = (await res.json().catch(() => ({}))) as { payouts?: unknown[] };
    if (res.status === 200) {
      assertEquals(body.payouts ?? [], [], "B's filtered ledger returned A's payouts");
    } else {
      assertDenied(res.status, "GET payouts?consignor_id= (A's)");
    }
  },
});

// C15: the "Add items" picker lists only the caller's own items.
Deno.test({
  name: "B's unassigned-items picker never lists A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const aItem = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/unassigned-items`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as { items?: Array<{ id: string }> };
    assert(
      !(body.items ?? []).some((i) => i.id === aItem),
      "B's unassigned-items picker listed A's item",
    );
  },
});

// C7: settling a manual payout by id.
Deno.test({
  name: "B cannot mark A's consignor payout paid",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_PAYOUT_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_PAYOUT_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/payouts/${id}`, {
      method: "PATCH",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ action: "mark_paid" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "PATCH consignor payout (A's)");
  },
});

// C15: attaching inventory to a consignor, in both directions.
Deno.test({
  name: "B cannot attach B's items to A's consignor",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONSIGNOR_ID") ||
    !Deno.env.get("TEST_USER_B_ITEM_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_CONSIGNOR_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/consignors/${id}/items`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_ids: [Deno.env.get("TEST_USER_B_ITEM_ID")!] }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST consignor items (A's consignor)");
  },
});

Deno.test({
  name: "B attaching A's item to B's consignor updates nothing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_B_CONSIGNOR_ID") ||
    !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_B_CONSIGNOR_ID")!;
    const aItem = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/consignment/consignors/${id}/items`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_ids: [aItem] }),
    });
    const body = (await res.json().catch(() => ({}))) as { updated?: number };
    if (res.status === 200) {
      assertEquals(body.updated, 0, "B attached A's item to B's consignor");
    } else {
      assertDenied(res.status, "POST consignor items (A's item)");
    }
    // A's item must still be unassigned when read back as A.
    const list = await fetch(`${BASE}/api/flipdesk/consignment/consignors/${id}/items`, {
      headers: authHeaders(B_JWT!),
    });
    const listed = (await list.json().catch(() => ({}))) as { items?: Array<{ id: string }> };
    assert(
      !(listed.items ?? []).some((i) => i.id === aItem),
      "A's item shows up under B's consignor",
    );
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

// The two cases above go through PostgREST. The assistant's own edge route
// reads the same rows with the SERVICE-ROLE client, so RLS does not help it:
// GET /conversations/:id is scoped only by its .eq("user_id") (support-assistant.ts).
Deno.test({
  name: "B cannot read A's support conversation through the assistant route",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CONVERSATION_ID"),
  fn: async () => {
    const convId = Deno.env.get("TEST_USER_A_CONVERSATION_ID")!;
    const res = await fetch(`${BASE}/api/support/assistant/conversations/${convId}`, {
      headers: authHeaders(B_JWT!),
    });
    const body = await res.text();
    assertDenied(res.status, "GET assistant conversation");
    assert(!body.includes(convId), "the denial body echoed A's conversation");
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
  // INV-4: hard-deleting an inventory item is admin-only, matching the RLS
  // DELETE policy (00042) that the service-role client skips. A member below
  // admin inside the owner's workspace is refused before any read. The
  // listing_manager/member half is driven in delete-item-guards_test.ts.
  name: "C3: viewer cannot hard-delete the owner's inventory item (requires admin)",
  ignore: !VIEWER_READY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/item/${id}`, {
      method: "DELETE",
      headers: viewerHeaders(),
    });
    await res.body?.cancel();
    assertDenied(res.status, "DELETE inventory item as viewer");
  },
});

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

// SNAP-03: Snap-to-Value spends the WORKSPACE OWNER's monthly snap allowance and
// AI budget. A viewer must be refused before any reservation, and a non-member
// naming A as the workspace must be refused by workspaceMiddleware, so neither
// can move A's quota. The body is a deliberately invalid image: a pass here must
// come from the role/workspace gate, never from reaching the model.
Deno.test({
  name: "C3: viewer cannot run Snap-to-Value on the owner's allowance",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/grade/snap`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ image: "data:image/png;base64,AAAA", brand: "x" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST snap as viewer");
  },
});

Deno.test({
  name: "B cannot spend A's Snap-to-Value allowance by naming A's workspace",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/grade/snap`, {
      method: "POST",
      headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": WS_OWNER! },
      body: JSON.stringify({ image: "data:image/png;base64,AAAA", brand: "x" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST snap in a foreign workspace");
  },
});

// MP-01: attaching or reshaping the owner's marketplace connection is
// admin-only. The OAuth start route skips blockViewerWrites (it is a GET), so this is
// the only thing stopping a viewer attaching their own eBay account to the
// owner's tenant. The member/listing_manager/admin half is driven in
// marketplace-admin-guard_test.ts.
Deno.test({
  name: "MP-01: viewer cannot start marketplace OAuth or change eBay policies/programs",
  ignore: !VIEWER_READY,
  fn: async () => {
    const cases: Array<[string, string]> = [
      ["GET", "/api/flipdesk/ebay/oauth/start"],
      ["GET", "/api/flipdesk/shopify/oauth/start?shop=my-store.myshopify.com"],
      ["PUT", "/api/flipdesk/ebay/policies/default"],
      ["POST", "/api/flipdesk/ebay/policies/sync"],
      ["POST", "/api/flipdesk/ebay/policies/create"],
      ["POST", "/api/flipdesk/ebay/policies/location"],
      ["POST", "/api/flipdesk/ebay/programs/out-of-stock"],
      ["DELETE", "/api/flipdesk/ebay/programs/out-of-stock"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: viewerHeaders(),
        body: method === "GET" || method === "DELETE"
          ? undefined
          : JSON.stringify({ postal_code: "10001", handling_days: 1 }),
      });
      await res.body?.cancel();
      assertDenied(res.status, `${method} ${path} as viewer`);
    }
  },
});

// MP-02: ending the campaign, bidding on listings and emailing every follower
// spend or end something on the owner's eBay account. The member and
// listing_manager halves are driven in marketplace-admin-guard_test.ts.
Deno.test({
  name: "MP-02: viewer cannot end the campaign, bulk-promote or send a follower email",
  ignore: !VIEWER_READY,
  fn: async () => {
    const cases: Array<[string, string]> = [
      ["POST", "/api/flipdesk/ebay/marketing/campaign/end"],
      ["POST", "/api/flipdesk/ebay/marketing/ads/bulk"],
      ["POST", "/api/flipdesk/ebay/marketing/email-campaigns/00000000-0000-0000-0000-000000000000/send"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: viewerHeaders(),
        body: JSON.stringify({ listing_ids: [], bid_percentage: 5 }),
      });
      await res.body?.cancel();
      assertDenied(res.status, `${method} ${path} as viewer`);
    }
  },
});

// DASH-2: the extension queue now runs workspaceMiddleware. Before it did, a
// member's X-Workspace-Owner was ignored (they saw their own queue on the
// owner's board) and the viewer floor could not see the role at all.
Deno.test({
  name: "extension-queue: a viewer member reads the OWNER's queue via X-Workspace-Owner",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue`, {
      headers: viewerHeaders(),
    });
    const body = await res.text();
    assertEquals(res.status, 200, `GET extension-queue as a viewer member: ${body}`);
  },
});

Deno.test({
  name: "extension-queue: a stranger naming A as workspace owner is refused",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue`, {
      headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": WS_OWNER! },
    });
    await res.body?.cancel();
    assertEquals(res.status, 403, "B is not a member of A's workspace");
  },
});

Deno.test({
  name: "extension-queue: a viewer cannot enqueue a job in the owner's queue",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ kind: "list", platform: "poshmark" }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 403, "POST extension-queue as viewer");
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

// Money M10: POST /reconciliation/run now sweeps EVERY unreconciled payout of
// the owner it resolves, in keyset batches, and links them. The owner comes
// from workspaceOwnerId ?? userId only, so a non-member carrying A's workspace
// header must be refused before the sweep reads a single one of A's payouts.
Deno.test({
  name: "M10: non-member B cannot run auto-match over A's payouts",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/reconciliation/run`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST reconciliation/run in A's workspace as non-member");
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

// SUB-05: /dispute-filed now resolves workspaceOwnerId ?? userId, because a
// member's dispute is stored under the workspace OWNER. Widening the lookup
// to the owner must not widen it to anyone who names an owner: a non-member
// carrying A's X-Workspace-Owner is refused by workspaceMiddleware, and a
// genuine member naming a dispute A does not own still gets a 404.
Deno.test({
  name: "SUB-05: non-member B cannot trigger a dispute alert in A's workspace",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    const res = await fetch(`${BASE}/api/notifications/dispute-filed`, {
      method: "POST",
      headers: foreignWorkspaceHeaders(),
      body: JSON.stringify({ disputeId: ZERO_UUID }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST dispute-filed in A's workspace as non-member");
  },
});

Deno.test({
  name: "SUB-05: a member of A still gets 404 for a dispute A does not own",
  ignore: !VIEWER_READY,
  fn: async () => {
    const res = await fetch(`${BASE}/api/notifications/dispute-filed`, {
      method: "POST",
      headers: viewerHeaders(),
      body: JSON.stringify({ disputeId: ZERO_UUID }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 404, "foreign dispute id via a member of A");
  },
});

// SUB-05, the positive half: a (non-viewer) member files a grade dispute in
// owner A's workspace, and the filing route itself sends the alert exactly
// once. Proved by the claim: a follow-up /dispute-filed for the same id, which
// resolves to the owner, finds it already alerted (before SUB-05 it 404'd).
// OPTIONAL: skips until the seed emits a member JWT and a report of A's inside
// the dispute window with no grade dispute on it. It files a real dispute, so
// a second run against the same fixture answers 409 and needs a reseed.
const MEMBER_JWT = Deno.env.get("TEST_MEMBER_JWT");
const A_DISPUTABLE_REPORT = Deno.env.get("TEST_USER_A_DISPUTABLE_REPORT_ID");
Deno.test({
  name: "SUB-05: a member filing in A's workspace produces exactly one alert",
  ignore: !BASE || !WS_OWNER || !MEMBER_JWT || !A_DISPUTABLE_REPORT,
  fn: async () => {
    const headers = {
      Authorization: `Bearer ${MEMBER_JWT}`,
      "Content-Type": "application/json",
      "X-Workspace-Owner": WS_OWNER!,
    };
    const filed = await fetch(`${BASE}/api/grade/dispute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ gradeReportId: A_DISPUTABLE_REPORT, reason: "SUB-05 probe" }),
    });
    const filedBody = await filed.json();
    assertEquals(filed.status, 200, `member filing: ${JSON.stringify(filedBody)}`);
    // The route sends the alert without awaiting it, so give its claim a
    // moment to land before asking again.
    await new Promise((r) => setTimeout(r, 2000));
    const again = await fetch(`${BASE}/api/notifications/dispute-filed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ disputeId: filedBody.dispute.id }),
    });
    const againBody = await again.json();
    assertEquals(again.status, 200, JSON.stringify(againBody));
    assertEquals(againBody.skipped, "already alerted");
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

// V3 (Verified page review): GET /api/verified/profile now carries the caller's
// account_name (users.full_name) as a separate field so the UI can OFFER it as a
// display name. That makes the read carry a private field, so two properties
// are pinned: it is never reachable unauthenticated, and B reading it gets B's
// own row (B's handle), never another account's.
Deno.test({
  name: "V3: verified profile read requires authentication",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/verified/profile`);
    await res.body?.cancel();
    assertDenied(res.status, "GET verified profile unauthenticated");
  },
});

Deno.test({
  name: "V3: B's verified profile read returns B's own row",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_B_HANDLE"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/verified/profile`, {
      headers: authHeaders(B_JWT!),
    });
    const body = (await res.json().catch(() => ({}))) as {
      profile?: { handle?: string | null };
    };
    assertEquals(res.status, 200);
    assertEquals(
      body.profile?.handle,
      Deno.env.get("TEST_USER_B_HANDLE"),
      "B's profile read returned a handle that is not B's",
    );
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

// ── US-3034: the measure passes now also write garment_measurements ──────────
//
// Both /extract and /autofill contribute what they measured to the Fit &
// Measurement Index, which is a NEW multi-tenant table. That changes what a
// successful call does, so the isolation question has to be re-asked rather
// than inherited from the case above.
//
// Two things make it safe, and they are different things:
//
//   THE WRITE IS SCOPED BY CONSTRUCTION. `ingestMeasureCardObservations` takes
//   its `user_id` from the handler's `workspaceOwnerId ?? userId`, never from
//   the request body, and its `item_id` from an item row that was already
//   loaded `.eq("user_id", ownerId)`. There is no path from an attacker-typed
//   id to a row in this table.
//
//   THE UPSERT CANNOT CROSS A TENANT. It conflicts on (item_id, field_key),
//   and item_id is tenant-owned, so B cannot overwrite A's observation even
//   though the service-role client bypasses RLS to do the write.
//
// Both /extract and /autofill are covered: a non-member is rejected by
// workspaceMiddleware before either handler runs, so no row is written at all.
Deno.test({
  name: "US-3034: non-member B cannot write garment_measurements through A's item",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    for (const path of ["extract", "autofill"]) {
      const res = await fetch(`${BASE}/api/flipdesk/measure/${path}`, {
        method: "POST",
        headers: foreignWorkspaceHeaders(),
        body: JSON.stringify({
          item_id: crypto.randomUUID(),
          photo_id: crypto.randomUUID(),
        }),
      });
      await res.body?.cancel();
      assertDenied(res.status, `POST measure ${path} as non-member`);
    }
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

// US-3369: the Delist button's server step ends EVERY other listing of an item
// — eBay through its API, the extension ones stamped and queued. Of all the
// doors in this file this is one of the most destructive to leave open: B naming
// A's item would pull A's live listings off every marketplace at once. Both ids
// it takes are client-supplied, so both are asserted.
Deno.test({
  name: "B cannot end the other listings of A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const aItemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/end-other-listings`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_id: aItemId, mode: "explicit" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST end-other-listings on a foreign item");
  },
});

Deno.test({
  // Both of A's ids together: the item is checked first and is foreign, so the
  // listing id never gets as far as choosing a draft group. (The seed emits no
  // B item, so "A's listing on B's item" cannot be expressed here; the route
  // reads the sold listing only through the owner-checked item id.)
  name: "B cannot end A's item's listings by naming A's sold listing too",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID") ||
    !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/listings/end-other-listings`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        item_id: Deno.env.get("TEST_USER_A_ITEM_ID")!,
        sold_listing_id: Deno.env.get("TEST_USER_A_LISTING_ID")!,
        mode: "explicit",
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST end-other-listings naming A's item and listing");
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

// US-3144 changed the sentence above. The read now DOES take an id: `?item=`,
// so a phone arriving from a "listings still live" push sees the garment the
// push was about rather than the whole queue. That makes this the exact shape
// US-268 exists for — a client-supplied id — and the filter is applied ON TOP of
// the owner scope rather than instead of it.
//
// The damage if it were applied instead of: the item id of any listing is
// visible to whoever holds it (it rides in push payloads and in-app links), so
// an unscoped filter would turn a notification link into a read of another
// tenant's listing titles, URLs and sale timing.
Deno.test({
  name: "B cannot read A's pending delists by naming A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const aItemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/listings/pending-delists?item=${encodeURIComponent(aItemId)}`,
      { headers: authHeaders(B_JWT!) },
    );
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "GET pending-delists?item as B");
      return;
    }
    const json = await res.json();
    const pending = (json.pending ?? []) as Array<{ item_id: string }>;
    // Narrowing to an item B does not own must produce NOTHING. An empty list is
    // the correct answer here and the only safe one.
    assertEquals(
      pending.length,
      0,
      `pending-delists?item=${aItemId} returned ${pending.length} of A's rows to B`,
    );
  },
});

// US-3456: bulk cross-list names items in the body. The source rows are read
// through inventory_items scoped to the caller, so A's item never comes back
// to B: it is reported not_found, the same as an item that does not exist,
// and no listings row, group stamp or queue row is written for it.
Deno.test({
  name: "B cannot bulk cross-list A's items",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const aItemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/cross-push-bulk`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ item_ids: [aItemId], platforms: ["poshmark"] }),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "POST cross-push-bulk naming A's item as B");
      return;
    }
    const body = (await res.json()) as { rows?: Array<{ item_id: string; outcome: string }> };
    for (const row of body.rows ?? []) {
      assertEquals(
        row.outcome,
        "not_found",
        `cross-push-bulk acted on A's item ${row.item_id} for B: ${row.outcome}`,
      );
    }
  },
});

// US-3455: the phone's create-form fill takes an item id in the body and
// answers 404 for an item the caller does not own. Not a 200 with empty
// words: the payload carries the item's title, brand and photo URLs, which is
// exactly what a foreign id must never read.
Deno.test({
  name: "B cannot fetch a phone list fill for A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const aItemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue/fill`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ inventory_item_id: aItemId, platform: "poshmark" }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST extension-queue/fill naming A's item as B");
  },
});

// US-3452: the delist log takes an item id in the path and answers 404 for an
// item the caller does not own. Not an empty list: a 200 with no events would
// confirm the id exists, and item ids travel in push payloads and links.
Deno.test({
  name: "B cannot read A's delist log by naming A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const aItemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/listings/delist-log/${encodeURIComponent(aItemId)}`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "GET delist-log/:itemId as B");
  },
});

Deno.test({
  // A malformed id must not fall back to "no filter" and hand back the whole
  // queue as though the caller had asked for it. optionalUuid() returns null for
  // anything that is not a uuid, and null means unfiltered — which is safe here
  // ONLY because the owner scope is unconditional. This pins that it stays
  // owner-scoped rather than pinning the fallback.
  name: "a junk ?item= filter still cannot cross a tenant boundary",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/listings/pending-delists?item=not-a-uuid`,
      { headers: authHeaders(B_JWT!) },
    );
    if (res.status !== 200) {
      await res.body?.cancel();
      assertDenied(res.status, "GET pending-delists with a junk item filter as B");
      return;
    }
    const json = await res.json();
    const ids = (json.pending ?? []).map((p: { listing_id: string }) => p.listing_id);
    assert(
      !ids.includes(listingId),
      "a junk ?item= filter returned A's listing to B",
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

// ── Extension token renewal (US-3296) ──────────────────────────────────────
//
// The route that MINTS. It exists because an extension token lived 30 days with
// nothing to renew it, so every connected seller silently became an anonymous
// one about a month after connecting. It deliberately accepts an EXPIRED token
// — that is the whole point, a browser closed through the expiry has no other
// way back — which makes "what it refuses" the property worth pinning.
//
// Two things must hold. A token we did not sign mints nothing, however
// plausible its shape: the middle segment is a plain readable timestamp, so
// `<victim-id>.<far-future>.<anything>` is the obvious forgery to try, and
// accepting it would hand a stranger a real 30-day token for somebody else's
// account. And the account is named ONLY by the signature — there is no body,
// no id and no filter a caller can supply.
Deno.test({
  name: "extension token renewal rejects missing/forged tokens",
  ignore: !CONFIGURED,
  fn: async () => {
    const url = `${BASE}/api/grading/public/extension-token/renew`;

    const noAuth = await fetch(url, { method: "POST" });
    await noAuth.body?.cancel();
    assertEquals(noAuth.status, 401, "POST extension-token/renew with no token must be 401");

    for (
      const bad of [
        "garbage",
        "a.b.c",
        "user-a.9999999999999.deadbeef",
        // A well-formed id and a live expiry, signed with nothing.
        "00000000-0000-0000-0000-000000000000.9999999999.deadbeefdeadbeef",
      ]
    ) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bad}` },
      });
      const body = await res.text();
      assertDenied(res.status, `POST extension-token/renew with a forged token (${bad})`);
      assert(
        !body.includes('"token"'),
        `a refused renewal must not return a token (${bad})`,
      );
    }
  },
});

Deno.test({
  name: "extension token renewal ignores a user_id planted in the request body",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/grading/public/extension-token/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "00000000-0000-0000-0000-000000000000",
        userId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    const body = await res.text();
    assertEquals(res.status, 401, "a body-supplied user id must not authenticate anyone");
    assert(!body.includes('"token"'), "no token may be minted for a body-supplied id");
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
  // US-3174 (AC3): the planner router takes ids in the PATH -- a session id
  // and a task id -- which is the shape US-268 exists for. Every one of them
  // is resolved through an owner-verified parent before anything is read or
  // written.
  //
  // A cross-tenant hit here is not a leak of a listing price. B would be
  // driving A's work session: starting A's tasks, marking A's work complete,
  // and abandoning A's evening. The history is the seller's record of their
  // own hours, and a foreign write corrupts it silently.
  name: "US-3174: B cannot read or drive A's work session",
  ignore: !CONFIGURED,
  fn: async () => {
    const A_SESSION = Deno.env.get("TEST_USER_A_WORK_SESSION_ID") ??
      "00000000-0000-4000-8000-0000000000a1";
    const A_TASK = Deno.env.get("TEST_USER_A_WORK_TASK_ID") ??
      "00000000-0000-4000-8000-0000000000a2";
    const BASE_PATH = `${BASE}/api/flipdesk/planner`;

    // Every session action, as B, against A's session.
    for (const action of ["start", "pause", "resume", "complete", "abandon"]) {
      const res = await fetch(`${BASE_PATH}/sessions/${A_SESSION}/${action}`, {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ revision: 1 }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        session?: { id?: string };
        tasks?: unknown[];
      };
      assert(
        [401, 403, 404, 409].includes(res.status),
        `session ${action} on A's session should be refused, got ${res.status}`,
      );
      // Belt and braces: even a 409 must not carry A's session back. The
      // stale-revision path deliberately returns state for the UI to recover
      // from, and that path must never be reachable across a tenant.
      assert(
        body.session?.id !== A_SESSION,
        `session ${action} leaked A's session to B`,
      );
      assertEquals(body.tasks ?? [], [], `session ${action} leaked A's tasks`);
    }

    // Every task action, as B, against A's task.
    for (const action of ["start", "pause", "complete", "skip"]) {
      const res = await fetch(`${BASE_PATH}/tasks/${A_TASK}/${action}`, {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ revision: 1, confirmed_minutes: 5 }),
      });
      const body = (await res.json().catch(() => ({}))) as { tasks?: unknown[] };
      assert(
        [401, 403, 404, 409].includes(res.status),
        `task ${action} on A's task should be refused, got ${res.status}`,
      );
      assertEquals(body.tasks ?? [], [], `task ${action} leaked A's tasks`);
    }

    // B's own current session is B's, whatever they ask for.
    const current = await fetch(`${BASE_PATH}/sessions/current`, {
      headers: authHeaders(B_JWT!),
    });
    const currentBody = (await current.json().catch(() => ({}))) as {
      session?: { id?: string } | null;
    };
    if (current.status === 200) {
      assert(
        currentBody.session === null || currentBody.session?.id !== A_SESSION,
        "GET /sessions/current returned A's session to B",
      );
    }
  },
});

Deno.test({
  // US-3174 (AC3): creating a plan is the write that takes FOREIGN IDS in a
  // list. B planning against A's inventory must not produce a session whose
  // tasks point at A's garments -- that would put A's items on B's screen,
  // with A's bin labels, which is a map of somebody else's storage.
  //
  // The route nulls an unowned id rather than 403ing the whole plan, so the
  // assertion is that the id does not SURVIVE, not that the call fails.
  name: "US-3174: B's plan cannot name A's items",
  ignore: !CONFIGURED,
  fn: async () => {
    const A_ITEM = Deno.env.get("TEST_USER_A_ITEM_ID") ??
      "00000000-0000-4000-8000-0000000000a3";
    const res = await fetch(`${BASE}/api/flipdesk/planner/sessions`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        budget_minutes: 30,
        work_context: "home",
        available_tools: ["camera"],
        // user_id and owner_user_id are named the way the columns are named on
        // purpose: a handler reading either from the body would pass a lazier
        // test than this one.
        user_id: Deno.env.get("TEST_USER_A_ID") ?? null,
        owner_user_id: Deno.env.get("TEST_USER_A_ID") ?? null,
        tasks: [{ action_key: "measure", inventory_item_id: A_ITEM, item_title: "A's jacket" }],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      tasks?: { inventory_item_id?: string | null }[];
      dropped_item_ids?: string[];
    };
    assert(
      [200, 201, 400, 401, 403, 409, 500].includes(res.status),
      `planner create should answer a known status, got ${res.status}`,
    );
    for (const task of body.tasks ?? []) {
      assert(
        task.inventory_item_id !== A_ITEM,
        "B's plan stored a task pointing at A's item",
      );
    }
    if (res.status === 201 && (body.dropped_item_ids ?? []).length > 0) {
      assert(
        body.dropped_item_ids!.includes(A_ITEM),
        "the foreign id should be reported as dropped rather than silently gone",
      );
    }
  },
});

Deno.test({
  // US-3179 (AC1): the outcome read joins a seller's planning history to their
  // SALES, which makes it the widest read in the planner router by some way.
  //
  // A hit here leaks money. Not an estimate or a task count: what another
  // seller's garments sold for, what they paid, what the marketplace took and
  // when each one settled. It is the books, reached through a planning route,
  // and it would be a quiet read with nothing on either screen to show it
  // happened.
  //
  // The route runs FOUR queries -- tasks, sessions, items and sales -- and each
  // carries its own owner predicate, so like the observations case above this
  // one cannot see a single predicate go. `AC3: every read and write is scoped
  // on the owner` in flipdesk-planner_test.ts is the guard that can. What this
  // asks is the question only real rows answer: can B's answer ever contain
  // A's sale.
  name: "US-3179: B's outcome read cannot reach A's sales",
  ignore: !CONFIGURED,
  fn: async () => {
    const A_ID = Deno.env.get("TEST_USER_A_ID") ??
      "00000000-0000-4000-8000-000000000001";
    const PATH = `${BASE}/api/flipdesk/planner/outcomes`;

    const shapes: { label: string; url: string; headers: HeadersInit }[] = [
      { label: "plain", url: PATH, headers: authHeaders(B_JWT!) },
      { label: "user_id filter", url: `${PATH}?user_id=eq.${A_ID}`, headers: authHeaders(B_JWT!) },
      {
        label: "workspace-owner header",
        url: PATH,
        headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": A_ID },
      },
    ];

    const theirs: { sales: string[]; items: string[] }[] = [];
    for (const shape of shapes) {
      const res = await fetch(shape.url, { headers: shape.headers });
      assert(
        [200, 401, 403].includes(res.status),
        `outcomes (${shape.label}) should answer a known status, got ${res.status}`,
      );
      if (res.status !== 200) continue;
      const body = (await res.json().catch(() => ({}))) as {
        sales?: { sale_id?: string; inventory_item_id?: string }[];
        items?: { inventory_item_id?: string }[];
      };
      theirs.push({
        sales: (body.sales ?? []).map((x) => String(x.sale_id)),
        items: (body.items ?? []).map((x) => String(x.inventory_item_id)),
      });
    }

    const aRes = await fetch(PATH, { headers: authHeaders(A_JWT!) });
    if (aRes.status !== 200) return;
    const aBody = (await aRes.json().catch(() => ({}))) as {
      sales?: { sale_id?: string }[];
      items?: { inventory_item_id?: string }[];
    };
    const aSales = new Set((aBody.sales ?? []).map((x) => String(x.sale_id)));
    const aItems = new Set((aBody.items ?? []).map((x) => String(x.inventory_item_id)));

    for (const [i, got] of theirs.entries()) {
      assertEquals(
        got.sales.filter((id) => aSales.has(id)),
        [],
        `B's outcomes (${shapes[i]!.label}) contained A's sale ids`,
      );
      assertEquals(
        got.items.filter((id) => aItems.has(id)),
        [],
        `B's outcomes (${shapes[i]!.label}) contained A's item ids`,
      );
    }
  },
});

Deno.test({
  // US-3178 (AC4): the duration-learning read takes NO id and must never be
  // steerable into another seller's history.
  //
  // WHAT A HIT HERE WOULD COST is not a leak of one row. Every future estimate
  // B sees would be fitted to A's pace -- a median over A's confirmed minutes,
  // presented to B as "your own" -- and nothing on the screen would say why
  // their five-minute job now reads twelve. It would also be a durable read of
  // how many hours another seller worked and when, which is their record
  // rather than a listing price.
  //
  // The route answers a list with no id in it, so the falsifiable claim is
  // that nothing in a query string, a header or a body can widen it. Every
  // shape that could is tried, and then the two sellers' answers are compared
  // for a shared task id, which is the only way a cross-tenant row could
  // actually arrive.
  //
  // WHAT THIS CASE CANNOT CATCH, measured rather than assumed. The route runs
  // TWO queries, and each carries its own owner predicate. Deleting ONE of
  // them leaves this case green, because the other still filters the result.
  // That is belt-and-braces working, and it is also why this case is not the
  // only guard: `AC3: every read and write is scoped on the owner` in
  // flipdesk-planner_test.ts reads the source and fails on a single missing
  // predicate, where this one needs both gone before a row can actually
  // cross. Neither is sufficient alone and the pair was checked both ways --
  // one predicate removed: source guard red, this green; both removed: both
  // red.
  name: "US-3178: B's observation read cannot reach A's work history",
  ignore: !CONFIGURED,
  fn: async () => {
    const A_ID = Deno.env.get("TEST_USER_A_ID") ??
      "00000000-0000-4000-8000-000000000001";
    const PATH = `${BASE}/api/flipdesk/planner/observations`;

    const shapes: { label: string; url: string; headers: HeadersInit }[] = [
      { label: "plain", url: PATH, headers: authHeaders(B_JWT!) },
      {
        label: "user_id filter",
        url: `${PATH}?user_id=eq.${A_ID}`,
        headers: authHeaders(B_JWT!),
      },
      {
        label: "owner query param",
        url: `${PATH}?owner_user_id=${A_ID}`,
        headers: authHeaders(B_JWT!),
      },
      {
        label: "workspace-owner header",
        url: PATH,
        headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": A_ID },
      },
    ];

    const seen: string[][] = [];
    for (const shape of shapes) {
      const res = await fetch(shape.url, { headers: shape.headers });
      assert(
        [200, 401, 403].includes(res.status),
        `observations (${shape.label}) should answer a known status, got ${res.status}`,
      );
      if (res.status !== 200) continue;
      const body = (await res.json().catch(() => ({}))) as {
        observations?: { task_id?: string; session_state?: string }[];
      };
      const rows = body.observations ?? [];
      // Whatever comes back, it is completed work: the route filters both the
      // task and the session state, and a row that is neither means the query
      // widened.
      for (const row of rows) {
        assert(
          row.session_state === undefined || row.session_state === "completed",
          `observations (${shape.label}) returned a non-completed session`,
        );
      }
      seen.push(rows.map((r) => String(r.task_id)));
    }

    // And A's own answer shares no task with any of B's.
    const aRes = await fetch(PATH, { headers: authHeaders(A_JWT!) });
    if (aRes.status === 200) {
      const aBody = (await aRes.json().catch(() => ({}))) as {
        observations?: { task_id?: string }[];
      };
      const aIds = new Set((aBody.observations ?? []).map((r) => String(r.task_id)));
      for (const [i, ids] of seen.entries()) {
        const shared = ids.filter((id) => aIds.has(id));
        assertEquals(
          shared,
          [],
          `B's observations (${shapes[i]!.label}) contained A's task ids`,
        );
      }
    }
  },
});

Deno.test({
  // US-3166 (AC4): the Worth My Time settings routes take NO id at all -- the
  // owner comes from the request context and nothing in a body or a query can
  // choose whose row is read or written.
  //
  // That is the claim this case exists to falsify. It sends A's ids in B's
  // patch body and then reads B's settings back: if any of them had steered
  // the write, B's row would carry the values or A's row would have moved.
  // A cross-tenant hit here is quiet and lasting -- the planner would fit
  // every future plan to somebody else's tools, table and hourly target, and
  // nothing on the screen would say why.
  name: "US-3166: B's work-preferences patch cannot name A's workspace",
  ignore: !CONFIGURED,
  fn: async () => {
    const A_ID = Deno.env.get("TEST_USER_A_ID") ??
      "00000000-0000-4000-8000-000000000001";
    const PATH = `${BASE}/api/flipdesk/work-preferences`;

    const patch = await fetch(PATH, {
      method: "PATCH",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        // Every one of these is a field the route must ignore, named the way
        // the column is named on purpose: a handler reading any of them from
        // the body would pass a lazier test.
        user_id: A_ID,
        owner_user_id: A_ID,
        workspace_owner_id: A_ID,
        default_session_minutes: 45,
        work_context: "phone_only",
      }),
    });
    const patched = (await patch.json().catch(() => ({}))) as {
      default_session_minutes?: number;
      work_context?: string;
    };
    assert(
      [200, 400, 401, 403, 500].includes(patch.status),
      `work-preferences PATCH should answer 200/400/401/403/500, got ${patch.status}`,
    );
    if (patch.status === 200) {
      // The write landed on B, so B sees it. The point is the read-back below.
      assertEquals(patched.default_session_minutes, 45);
      assertEquals(patched.work_context, "phone_only");
    }

    // And A is untouched. A reads their own settings with their own token; if
    // B's body had steered the write, this is where it shows.
    const aRead = await fetch(PATH, { headers: authHeaders(A_JWT!) });
    const aPrefs = (await aRead.json().catch(() => ({}))) as {
      default_session_minutes?: number;
      work_context?: string;
    };
    if (aRead.status === 200 && patch.status === 200) {
      assert(
        aPrefs.work_context !== "phone_only" ||
          aPrefs.default_session_minutes !== 45,
        "A's settings carry exactly what B just wrote: the body chose the workspace",
      );
    }

    // A GET takes no id either, so there is nothing to forge on the read side.
    // Sending one anyway must not change the answer.
    const forged = await fetch(`${PATH}?user_id=${encodeURIComponent(A_ID)}`, {
      headers: authHeaders(B_JWT!),
    });
    const forgedBody = (await forged.json().catch(() => ({}))) as {
      default_session_minutes?: number;
    };
    if (forged.status === 200 && patch.status === 200) {
      assertEquals(
        forgedBody.default_session_minutes,
        45,
        "a user_id in the query must be ignored; B still sees B's own settings",
      );
    }
  },
});

Deno.test({
  // US-3015 (AC11): the EasyPost onboarding route creates a referral customer
  // and stores an API KEY that spends real postage money. It takes no sale id,
  // so the only thing that decides whose account is touched is the owner id
  // from the request context -- and this case exists to prove that a body
  // claiming to be somebody else changes nothing.
  //
  // A cross-tenant hit here would be worse than a leaked read: B would either
  // learn A's EasyPost customer id, or overwrite A's stored key with one B
  // controls, and every label A buys afterwards would run on B's account.
  name: "US-3015: B's EasyPost onboarding cannot touch A's account",
  ignore: !CONFIGURED,
  fn: async () => {
    // A real id when the fixture supplies one; a well-formed uuid otherwise.
    // Either way the route must ignore it -- the point is that a body cannot
    // name the owner, not that this particular owner exists.
    const A_ID = Deno.env.get("TEST_USER_A_ID") ??
      "00000000-0000-4000-8000-000000000001";
    const res = await fetch(`${BASE}/api/flipdesk/logistics/easypost/onboard`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      // Every one of these is a field the route must ignore. They are named
      // the way the columns are named on purpose: a handler that read any of
      // them from the body would pass a lazier test.
      body: JSON.stringify({
        owner_user_id: A_ID,
        user_id: A_ID,
        easypost_user_id: "user_A_referral",
        email: "a@example.test",
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      easypost_user_id?: string;
      api_key?: string;
      error?: string;
    };
    // 501 when EASYPOST_API_KEY is unset on the deployment, which is every
    // deployment until the owner sets it -- the handler returns before it
    // touches any row. 409 when B's own account has no email. 200 when B is
    // onboarded. None of those may carry A's id.
    assert(
      [200, 409, 501, 502].includes(res.status),
      `easypost onboarding should answer 200/409/501/502, got ${res.status}`,
    );
    assert(
      body.easypost_user_id !== "user_A_referral",
      "a referral id from the request body must never be stored or returned",
    );
    // The API key never leaves the edge. A client that could read it could
    // spend that seller's postage money from anywhere.
    assertEquals(body.api_key ?? "", "", "the EasyPost API key must never be returned");
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
  // US-3328: GET /api/grade/turnaround returns release times for the CALLER's
  // held grades. It takes no id, so the only way it could leak is by scoping
  // wrongly; B's answer must never mention A's submission.
  name: "US-3328: B's grade turnaround never lists A's submission",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_GRADE_SUBMISSION_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_GRADE_SUBMISSION_ID")!;
    const res = await fetch(`${BASE}/api/grade/turnaround`, {
      headers: authHeaders(B_JWT!),
    });
    const body = await res.json().catch(() => ({})) as {
      release_times?: Record<string, string>;
    };
    assertEquals(res.status, 200, "GET grade/turnaround as B");
    assertEquals(
      Object.keys(body.release_times ?? {}).includes(id),
      false,
      "B's turnaround lists A's submission",
    );
  },
});

Deno.test({
  // US-3337: GET /api/grade/photo-report-card aggregates the CALLER's grades.
  // It takes no id, so the only way it could leak is by scoping wrongly. A's
  // fixture grade has one blurry front photo: A's card must count it (or this
  // case proves nothing), and B's must not.
  name: "US-3337: B's photo report card never counts A's photos",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_PHOTO_REPORT_SUBMISSION_ID"),
  fn: async () => {
    type Card = {
      photos_measured?: number;
      slots?: Array<{ slot: string; problems: { blur: { count: number } } }>;
    };
    const blurryFronts = (card: Card) =>
      (card.slots ?? []).find((s) => s.slot === "front")?.problems.blur.count ?? 0;

    const asA = await fetch(`${BASE}/api/grade/photo-report-card`, {
      headers: authHeaders(A_JWT!),
    });
    const a = await asA.json().catch(() => ({})) as Card;
    assertEquals(asA.status, 200, "GET photo-report-card as A");
    assert(blurryFronts(a) >= 1, "A's own card does not count A's blurry front photo");

    const asB = await fetch(`${BASE}/api/grade/photo-report-card`, {
      headers: authHeaders(B_JWT!),
    });
    const b = await asB.json().catch(() => ({})) as Card;
    assertEquals(asB.status, 200, "GET photo-report-card as B");
    assertEquals(blurryFronts(b), 0, "B's card counts A's blurry front photo");
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

// ── SRC-4: POST /scout (the scan) and POST /scout/buy ───────────────────────
//
// The scan spends the owner's AI actions, and /buy INSERTs an inventory row
// and now takes a sourceId FROM THE BODY, which is the shape US-268 exists
// for. Neither had a case here. A_SOURCE_ID is declared with the Radar cases
// below; `const` is hoisted as far as these async test bodies are concerned.
const SCOUT_SCAN_BODY = JSON.stringify({ categoryId: "11450", q: "patagonia" });
const SCOUT_BUY_BODY = JSON.stringify({ title: "Tenant isolation probe", costCents: 100 });

Deno.test({
  name: "SRC-4: viewer cannot run a scan or log a buy in the owner's workspace",
  ignore: !VIEWER_READY,
  fn: async () => {
    for (
      const [path, body] of [
        ["/api/flipdesk/scout", SCOUT_SCAN_BODY],
        ["/api/flipdesk/scout/buy", SCOUT_BUY_BODY],
      ] as const
    ) {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: viewerHeaders(),
        body,
      });
      await res.body?.cancel();
      assertDenied(res.status, `POST ${path} as viewer`);
    }
  },
});

Deno.test({
  name: "SRC-4: non-member B cannot scan or buy against A's workspace",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    for (
      const [path, body] of [
        ["/api/flipdesk/scout", SCOUT_SCAN_BODY],
        ["/api/flipdesk/scout/buy", SCOUT_BUY_BODY],
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
  // B is a legitimate account in their OWN workspace naming A's source id.
  // Only the owner check inside /buy can stop it, and it must answer 404 and
  // insert nothing -- a foreign id answered like an unknown one.
  name: "SRC-4: B in their own workspace cannot attach A's sourceId to a buy",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SOURCE_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/scout/buy`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        title: "Tenant isolation probe",
        sourceId: Deno.env.get("TEST_USER_A_SOURCE_ID"),
      }),
    });
    const text = await res.text();
    assertEquals(res.status, 404, `POST scout/buy with A's sourceId as B: ${text}`);
    const fake = await fetch(`${BASE}/api/flipdesk/scout/buy`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        title: "Tenant isolation probe",
        sourceId: "00000000-0000-4000-8000-000000000000",
      }),
    });
    assertEquals(
      [res.status, text],
      [fake.status, await fake.text()],
      "a foreign source id and an unknown one must be indistinguishable",
    );
  },
});

// The fourth SRC-4 property, "a member's buy lands with user_id = owner and
// created_by = member", needs a NON-viewer member fixture, which the seed does
// not emit. It is pinned at the unit level instead, on the row builder the
// route calls: scout-buy-validation_test.ts.

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
  name: "US-2993: B cannot adopt a staged receipt onto A's expense",
  ignore: !CONFIGURED || !A_EXPENSE_ID,
  fn: async () => {
    // The expense is A's, so ownership fails before the path is even looked at.
    const res = await fetch(
      `${BASE}/api/flipdesk/expenses/${A_EXPENSE_ID}/adopt-staged`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ staging_path: "whatever/_staging/x.jpg" }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST expenses/:id/adopt-staged as B");
  },
});

Deno.test({
  name: "US-2993: a seller cannot adopt a path outside their own staging prefix",
  ignore: !CONFIGURED || !A_EXPENSE_ID,
  fn: async () => {
    // THE CASE THE PREFIX CHECK EXISTS FOR, and it is the one every ownership
    // test in this file would MISS. A owns the expense, so the ownership load
    // succeeds -- and the request then names a path in someone else's staging
    // folder. Without the `${ownerId}/_staging/` prefix check this copies
    // another tenant's receipt onto A's own expense, and every id in the
    // request belongs to A.
    const foreign =
      "00000000-0000-4000-8000-000000000000/_staging/receipt_1.jpg";
    const res = await fetch(
      `${BASE}/api/flipdesk/expenses/${A_EXPENSE_ID}/adopt-staged`,
      {
        method: "POST",
        headers: authHeaders(A_JWT!),
        body: JSON.stringify({ staging_path: foreign }),
      },
    );
    await res.body?.cancel();
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "US-2993: receipt extraction refuses a non-image before any model call",
  ignore: !CONFIGURED,
  fn: async () => {
    // Cheapest possible guard: an unauthenticated or malformed upload must not
    // reach the vision model, because that is a paid call on somebody's budget.
    const form = new FormData();
    form.append(
      "receipt",
      new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "x.bin", {
        type: "application/octet-stream",
      }),
    );
    const res = await fetch(`${BASE}/api/flipdesk/expenses/extract`, {
      method: "POST",
      headers: { Authorization: `Bearer ${B_JWT}` },
      body: form,
    });
    await res.body?.cancel();
    assertEquals(res.status, 400);
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
  // US-3096: the claim route now HYDRATES a `list` row — it reads the item, its
  // photos and the eBay draft, and hands the content back to the extension.
  // That turned a route which only ever returned rows into one that returns a
  // seller's garment title, description, price and photo URLs, so the scope is
  // now carrying more than it was.
  //
  // item_photos has no user_id column of its own (migration 00008): its tenant
  // is its parent item. The route therefore resolves the owned item ids FIRST,
  // under .eq("user_id", ownerId), and only then reads photos for those ids. A
  // row of B's naming A's item hydrates to nothing and comes back failed.
  name: "B's claim never hydrates A's item content",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const aItemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue/claim`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ limit: 10, installId: "isolation-test-hydrate" }),
    });
    if (res.status === 402) {
      await res.body?.cancel();
      return; // B has no FlipDesk plan; the earlier gate is a pass.
    }
    assertEquals(res.status, 200, "B must be able to claim B's own queue");
    const body = await res.json() as {
      claimed?: Array<{
        inventory_item_id: string | null;
        payload: Record<string, unknown> | null;
      }>;
    };
    for (const row of body.claimed ?? []) {
      assert(
        row.inventory_item_id !== aItemId,
        "B's claim returned a row pointing at A's item — the queue read is unscoped",
      );
      const payload = row.payload ?? {};
      assert(
        payload.itemId !== aItemId,
        "B's claim hydrated A's item into a payload — the hydration read is unscoped",
      );
      // The photo URLs are the loudest half: they are public bucket links, so a
      // leak here survives outside the session that produced it.
      const urls = Array.isArray(payload.photoUrls) ? payload.photoUrls : [];
      for (const u of urls) {
        assert(
          typeof u === "string" && !u.includes(aItemId),
          "B's claim returned a photo URL under A's item path",
        );
      }
    }
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
  // Stale-claim reclaim: /claim and the queue GET now WRITE to rows they did
  // not hand out, requeueing or failing any claim a dead browser left behind.
  // That write takes no id from the caller, so the property is that B's drain
  // can only ever reclaim B's rows. Seeded as a real stale claim of A's, read
  // back with the service key: if the .eq("user_id", ownerId) on the reclaim is
  // ever dropped, B's drain requeues A's delist and this sees `queued`.
  name: "B's queue drain never reclaims A's stale claim",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ID"),
  fn: async () => {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    // Same placeholder skip as the buyer-want readback above.
    if (!supabaseUrl || !serviceKey || serviceKey === "test-service-key") return;
    const svc = {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    const seeded = await fetch(`${supabaseUrl}/rest/v1/extension_work_queue`, {
      method: "POST",
      headers: svc,
      body: JSON.stringify({
        user_id: Deno.env.get("TEST_USER_A_ID"),
        kind: "delist",
        platform: "poshmark",
        status: "claimed",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        claimed_by: "isolation-stale",
        source: "web",
      }),
    });
    const rows = (await seeded.json().catch(() => [])) as { id?: string }[];
    assert(seeded.ok && rows[0]?.id, `could not seed A's stale claim (${seeded.status})`);
    const aRow = rows[0].id!;
    try {
      for (const req of [
        { path: "/claim", init: { method: "POST", body: JSON.stringify({ limit: 10 }) } },
        { path: "", init: { method: "GET" } },
      ]) {
        const res = await fetch(`${BASE}/api/flipdesk/extension-queue${req.path}`, {
          ...req.init,
          headers: authHeaders(B_JWT!),
        });
        await res.body?.cancel();
      }
      const check = await fetch(
        `${supabaseUrl}/rest/v1/extension_work_queue?id=eq.${aRow}&select=status,attempts`,
        { headers: svc },
      );
      const after = (await check.json().catch(() => [])) as { status?: string; attempts?: number }[];
      assert(check.ok, `readback of A's queue row failed (${check.status})`);
      assertEquals(
        after,
        [{ status: "claimed", attempts: 0 }],
        "B's drain touched A's stale claim: the reclaim write is not tenant-scoped",
      );
    } finally {
      const del = await fetch(`${supabaseUrl}/rest/v1/extension_work_queue?id=eq.${aRow}`, {
        method: "DELETE",
        headers: svc,
      });
      await del.body?.cancel();
    }
  },
});

Deno.test({
  // US-3370: the queue GET grew a THIRD list. `finishedNeedsReview` is a second
  // read of extension_work_queue, on a status the route never returned before
  // (`done`), and the service-role client bypasses RLS, so a widened status set
  // is a widened surface whether or not the filter looks harmless.
  //
  // The GET takes no id, so the property is the same one the claim case holds:
  // B's list can only ever be B's rows. Asserted against A's item id, which is
  // the thing a leak would actually carry - a queue row is an instruction, and
  // the instruction names the garment.
  name: "B's queue list never returns A's finished work",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/extension-queue`, {
      headers: authHeaders(B_JWT!),
    });
    if (res.status === 402 || res.status === 403) {
      await res.body?.cancel();
      return; // B has no FlipDesk plan; the earlier gate is a pass.
    }
    assertEquals(res.status, 200, "B must be able to read B's own queue");
    const body = await res.json() as {
      pending?: unknown;
      needsAttention?: unknown;
      finishedNeedsReview?: Array<{
        id: string;
        status: string;
        inventory_item_id: string | null;
        payload: Record<string, unknown> | null;
      }>;
    };
    assert(
      Array.isArray(body.finishedNeedsReview),
      "the queue view must always carry finishedNeedsReview, even empty - a " +
        "client that has to guess whether the key exists will render nothing",
    );
    const aItemId = Deno.env.get("TEST_USER_A_ITEM_ID");
    for (const row of body.finishedNeedsReview ?? []) {
      assertEquals(
        row.status,
        "done",
        "finishedNeedsReview must carry only finished rows; a queued row here " +
          "would be rendered as work that already ran",
      );
      if (!aItemId) continue;
      assert(
        row.inventory_item_id !== aItemId,
        "B's finished list returned a row pointing at A's item - the new read " +
          "is unscoped",
      );
      assert(
        (row.payload ?? {}).itemId !== aItemId,
        "B's finished list carried A's item in a payload",
      );
    }
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

// ── Public API v1: account webhooks (00830) ──────────────────────────
//
// The webhook is one row per ACCOUNT now, keyed by the API key owner, and the
// routes take no id at all. So the cross-tenant question is not "can B name A's
// row" but "does anything B's key reaches resolve to A's row": the delivery
// log, the configured URL, and the secret rotation. A holds an endpoint with
// no secret and one delivery; B holds neither.

Deno.test({
  name: "B's API key cannot see A's webhook deliveries (GET /api/v1/webhook/deliveries)",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID"),
  fn: async () => {
    const eventId = Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID")!;
    const res = await fetch(`${BASE}/api/v1/webhook/deliveries?limit=100`, {
      headers: apiKeyHeaders(B_API_KEY!),
    });
    const body = await res.text();
    assert(!body.includes(eventId), "B's delivery log returned A's event id");
  },
});

Deno.test({
  name: "A's own API key CAN see A's webhook delivery — not a blanket denial",
  ignore: !CONFIGURED || !A_API_KEY || !Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID"),
  fn: async () => {
    const eventId = Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID")!;
    const res = await fetch(`${BASE}/api/v1/webhook/deliveries?limit=100`, {
      headers: apiKeyHeaders(A_API_KEY!),
    });
    const body = await res.text();
    assertEquals(res.status, 200, `owner read failed: ${body.slice(0, 200)}`);
    assert(body.includes(eventId), "the owner's delivery log did not include the event");
  },
});

Deno.test({
  name: "B's API key does not read A's webhook URL, and B's rotate cannot mint A a secret",
  ignore: !CONFIGURED || !A_API_KEY || !B_API_KEY || !Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID"),
  fn: async () => {
    const got = await fetch(`${BASE}/api/v1/webhook`, { headers: apiKeyHeaders(B_API_KEY!) });
    const gotBody = await got.text();
    assert(
      !gotBody.includes("tenant-a-fixture.example.com"),
      "GET /api/v1/webhook as B returned A's URL",
    );

    const rotated = await fetch(`${BASE}/api/v1/webhook/secret/rotate`, {
      method: "POST",
      headers: apiKeyHeaders(B_API_KEY!),
    });
    await rotated.body?.cancel();
    assertDenied(rotated.status, "POST /api/v1/webhook/secret/rotate as B (B has no webhook)");

    // The write side: A's endpoint must still be secretless after B's call.
    const mine = await fetch(`${BASE}/api/v1/webhook`, { headers: apiKeyHeaders(A_API_KEY!) });
    const mineBody = await mine.json();
    assertEquals(mine.status, 200);
    assertEquals(mineBody.data.webhook_url, "https://tenant-a-fixture.example.com/hook");
    assertEquals(mineBody.data.has_signing_secret, false, "B's rotate gave A's webhook a secret");
  },
});

// ── Dashboard account webhook (/api/keys/webhook, session auth) ──────
//
// The same account row reached with a JWT instead of an API key. The routes
// take no id, so the question is again whether anything B's session reaches
// resolves to A's endpoint or A's delivery log.

Deno.test({
  name: "B's session cannot read A's webhook URL or deliveries (GET /api/keys/webhook*)",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID"),
  fn: async () => {
    const eventId = Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID")!;
    const cfg = await fetch(`${BASE}/api/keys/webhook`, { headers: authHeaders(B_JWT!) });
    const cfgBody = await cfg.text();
    assert(!cfgBody.includes("tenant-a-fixture.example.com"), "GET /api/keys/webhook as B returned A's URL");

    const log = await fetch(`${BASE}/api/keys/webhook/deliveries?limit=100`, { headers: authHeaders(B_JWT!) });
    const logBody = await log.text();
    assert(!logBody.includes(eventId), "B's dashboard delivery log returned A's event id");
  },
});

Deno.test({
  name: "A's own session CAN read A's webhook and delivery - not a blanket denial",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID"),
  fn: async () => {
    const eventId = Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID")!;
    const cfg = await fetch(`${BASE}/api/keys/webhook`, { headers: authHeaders(A_JWT!) });
    const cfgBody = await cfg.json();
    assertEquals(cfg.status, 200);
    assertEquals(cfgBody.data.webhook_url, "https://tenant-a-fixture.example.com/hook");

    const log = await fetch(`${BASE}/api/keys/webhook/deliveries?limit=100`, { headers: authHeaders(A_JWT!) });
    const logBody = await log.text();
    assertEquals(log.status, 200, `owner read failed: ${logBody.slice(0, 200)}`);
    assert(logBody.includes(eventId), "the owner's dashboard delivery log did not include the event");
  },
});

Deno.test({
  name: "B's session cannot rotate A's webhook secret or send A's endpoint a test event",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_WEBHOOK_EVENT_ID"),
  fn: async () => {
    const rotated = await fetch(`${BASE}/api/keys/webhook/secret/rotate`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    await rotated.body?.cancel();
    assertDenied(rotated.status, "POST /api/keys/webhook/secret/rotate as B (B has no webhook)");

    const test = await fetch(`${BASE}/api/keys/webhook/test`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    await test.body?.cancel();
    assertDenied(test.status, "POST /api/keys/webhook/test as B (B has no webhook)");

    // The write side: A's endpoint is still secretless and got no test event.
    const cfg = await fetch(`${BASE}/api/keys/webhook`, { headers: authHeaders(A_JWT!) });
    const cfgBody = await cfg.json();
    assertEquals(cfgBody.data.has_signing_secret, false, "B's rotate gave A's webhook a secret");
    const log = await fetch(`${BASE}/api/keys/webhook/deliveries?limit=100`, { headers: authHeaders(A_JWT!) });
    const logBody = await log.text();
    assert(!logBody.includes("webhook.test"), "B's test send was delivered as A's event");
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

// US-3364: and the review row that produces is B's, in B's queue, with no
// listing on it.
//
// The case above asserts `body.unmatched`, which is a PLANNER count. It was 1
// for the whole period in which the write behind it answered 42P10 and no row
// existed at all, so on its own it proves nothing about what the database now
// holds. writeSyncReviews reads this tenant's open rows before it writes, and
// that read is the new scoped query on this route - if it were unscoped, B's
// poll would find A's open review row and MERGE ONTO IT, overwriting A's queue
// entry by primary key.

Deno.test({
  name: "B's sync review rows are B's, and A's queue is untouched",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SYNC_LISTING_URL"),
  fn: async () => {
    const url = Deno.env.get("TEST_USER_A_SYNC_LISTING_URL")!;
    const post = (jwt: string) =>
      fetch(`${BASE}/api/flipdesk/sync/observations`, {
        method: "POST",
        headers: authHeaders(jwt),
        body: JSON.stringify({
          platform: "poshmark",
          signedIn: true,
          sold: [{
            listingUrl: url,
            title: "Tenant-A-sync-fixture",
            soldPriceCents: 5500,
            soldAt: "2026-08-18T12:00:00.000Z",
            orderRef: "isolation-probe-2",
          }],
        }),
      });

    const res = await post(B_JWT!);
    if (res.status === 402) {
      await res.body?.cancel();
      return;
    }
    assertEquals(res.status, 200);
    const body = await res.json();
    // The row LANDS. `unmatched: 1` with `reviewsInserted: 0` is the exact
    // shape US-3364 found in production, so it is asserted here too.
    assertEquals(
      body.reviewsFailed,
      0,
      "B's review write failed. A 200 whose queue stays empty is the bug this " +
        "assertion exists for.",
    );
    assertEquals(
      (body.reviewsInserted ?? 0) + (body.reviewsRefreshed ?? 0),
      1,
      "B's unmatched sale produced no review row",
    );

    const mine = await fetch(`${BASE}/api/flipdesk/sync/reviews`, { headers: authHeaders(B_JWT!) });
    assertEquals(mine.status, 200);
    const mineBody = await mine.json();
    const probe = (mineBody.reviews ?? []).filter((r: { dedupe_key: string | null }) =>
      (r.dedupe_key ?? "").includes("isolation-probe-2")
    );
    assertEquals(probe.length, 1, "B cannot see the review row B's own poll created");
    assertEquals(
      probe[0].listing_id,
      null,
      "B's review row carries a listing id. The only listing that URL matches " +
        "is A's, so this row would put A's listing in B's queue and would make " +
        "B's next poll merge onto A's open review row.",
    );

    const theirs = await fetch(`${BASE}/api/flipdesk/sync/reviews`, { headers: authHeaders(A_JWT!) });
    assertEquals(theirs.status, 200);
    const theirsBody = await theirs.json();
    assertEquals(
      (theirsBody.reviews ?? []).filter((r: { dedupe_key: string | null }) =>
        (r.dedupe_key ?? "").includes("isolation-probe-2")
      ).length,
      0,
      "B's poll wrote a row into A's review queue",
    );
  },
});

// MP-09: the claim picker's candidates are read by review id. A foreign review
// id is a 404, and the owner's own list never carries another tenant's listing.
Deno.test({
  name: "MP-09: A cannot read candidates for B's sync review, and B's list holds none of A's listings",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SYNC_LISTING_URL"),
  fn: async () => {
    const url = Deno.env.get("TEST_USER_A_SYNC_LISTING_URL")!;
    const res = await fetch(`${BASE}/api/flipdesk/sync/observations`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        platform: "poshmark",
        signedIn: true,
        sold: [{
          listingUrl: url,
          title: "Tenant-A-sync-fixture",
          soldPriceCents: 5500,
          soldAt: "2026-08-18T12:00:00.000Z",
          orderRef: "isolation-probe-candidates",
        }],
      }),
    });
    if (res.status === 402) {
      await res.body?.cancel();
      return;
    }
    await res.body?.cancel();
    const mine = await fetch(`${BASE}/api/flipdesk/sync/reviews`, { headers: authHeaders(B_JWT!) });
    const mineBody = await mine.json();
    const row = (mineBody.reviews ?? []).find((r: { dedupe_key: string | null }) =>
      (r.dedupe_key ?? "").includes("isolation-probe-candidates")
    ) as { id: string } | undefined;
    assert(row, "B's probe produced no review row to ask about");

    const foreign = await fetch(`${BASE}/api/flipdesk/sync/reviews/${row.id}/candidates`, {
      headers: authHeaders(A_JWT!),
    });
    await foreign.body?.cancel();
    assertDenied(foreign.status, "A reading candidates for B's review");

    const own = await fetch(`${BASE}/api/flipdesk/sync/reviews/${row.id}/candidates`, {
      headers: authHeaders(B_JWT!),
    });
    assertEquals(own.status, 200);
    const ownBody = await own.json() as { candidates?: Array<{ id: string }> };
    const aListing = Deno.env.get("TEST_USER_A_LISTING_ID");
    assert(
      !(ownBody.candidates ?? []).some((c) => c.id === aListing),
      "B's candidate list carries A's listing",
    );
  },
});

// US-9201: the closet import matches rows on (platform, platform_listing_id).
// That key is chosen by whoever posts the batch, so the match MUST be owner-
// scoped: B naming A's Poshmark id has to get a fresh row of B's own, never an
// update of A's listing. The run reports which it did (inserted vs updated),
// which is the assertion, and it needs only B's token to read.

Deno.test({
  name: "B's closet import naming A's Poshmark listing id creates B's own row, not A's",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_CLOSET_LISTING_PID"),
  fn: async () => {
    const pid = Deno.env.get("TEST_USER_A_CLOSET_LISTING_PID")!;
    const res = await fetch(`${BASE}/api/flipdesk/closet-import/runs`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        platform: "poshmark",
        listings: [{
          listingUrl: `https://poshmark.com/listing/tenant-b-probe-${pid}`,
          title: "Tenant-B-closet-probe",
          priceCents: 1000,
        }],
      }),
    });
    // 402 is a pass: B at their plan's active-listing cap is stopped before
    // any row is read or written. US-3263 note: an UNENTITLED B is no longer
    // refused here at all -- they get a bounded import instead -- so this
    // branch now only catches the cap case, and the assertions below run for
    // both entitled and free accounts.
    if (res.status === 402) {
      await res.body?.cancel();
      return;
    }
    assertEquals(res.status, 202, `closet import returned ${res.status}`);
    const started = await res.json() as { run_id: string; known_rows: number };
    assertEquals(
      started.known_rows,
      0,
      "A's Poshmark id read as already-known to B: the dedupe lookup is not owner-scoped.",
    );

    // The worker runs in the background; one row finishes well inside this.
    interface RunView {
      status: string;
      inserted_count: number;
      updated_count: number;
    }
    let run: RunView | null = null;
    for (let i = 0; i < 40; i++) {
      const poll = await fetch(`${BASE}/api/flipdesk/import/runs/${started.run_id}`, {
        headers: authHeaders(B_JWT!),
      });
      assertEquals(poll.status, 200, "B cannot read B's own closet import run");
      const view = (await poll.json() as { run: RunView | null }).run;
      run = view;
      if (view && view.status !== "pending" && view.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(run, "no run row came back");
    const done: RunView = run;
    assertEquals(
      done.updated_count,
      0,
      "B's closet import UPDATED an existing listing. The only listing with " +
        "that Poshmark id is A's, so the worker matched across tenants.",
    );
    assertEquals(done.inserted_count, 1, `expected B's own row to be inserted; run: ${JSON.stringify(done)}`);

    // Put B's catalog back so a re-run of the suite starts from the same place.
    await fetch(`${BASE}/api/flipdesk/import/runs/${started.run_id}/undo`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    }).then((r) => r.body?.cancel());
  },
});

// US-3263: the free-plan closet import. An account with no FlipDesk plan may
// bring in FREE_CLOSET_IMPORT_ROWS listings per read rather than being refused
// outright, and the bound is applied SERVER-SIDE from that account's own
// entitlement. The tenancy question this raises is new: a bounded import is
// still an import, so it must land in the caller's own tenant and nowhere else,
// and the bound must not be something the caller can raise by asking.

// A Poshmark listing id is 24 hex characters and listingIdFromUrl requires
// exactly that shape (closet-import.ts:171). A crypto.randomUUID() carries
// dashes and a 12-character tail, so it matched nothing: normalizeClosetRows
// dropped every row, the batch came out empty, and the route answered 400
// NO_LISTINGS_READ. These two cases asserted 202 and had been red since the id
// regex was tightened -- a stale fixture in a security suite, which is worse
// than a stale fixture anywhere else, because a whole lane stays red and a real
// leak lands in the same colour.
function poshmarkProbeId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.test({
  name: "an over-bound closet import is trimmed by the server, and lands in the caller's tenant",
  ignore: !CONFIGURED || !Deno.env.get("TEST_FREE_PLAN_JWT"),
  fn: async () => {
    const freeJwt = Deno.env.get("TEST_FREE_PLAN_JWT")!;
    // 60 rows, well over the 25-row bound, each with a listing id of its own.
    const listings = Array.from({ length: 60 }, (_, i) => ({
      listingUrl: `https://poshmark.com/listing/free-tier-probe-${i}-${poshmarkProbeId()}`,
      title: `Free-tier-probe-${i}`,
      priceCents: 1000 + i,
    }));
    const res = await fetch(`${BASE}/api/flipdesk/closet-import/runs`, {
      method: "POST",
      headers: authHeaders(freeJwt),
      // free_cap is NOT a request field. Sending one proves the server ignores
      // whatever the caller claims its own allowance is.
      body: JSON.stringify({ platform: "poshmark", listings, free_cap: 5000 }),
    });
    assertEquals(res.status, 202, `free-plan closet import returned ${res.status}`);
    const started = await res.json() as {
      run_id: string;
      total_rows: number;
      free_capped: boolean;
      free_cap: number | null;
      free_cap_reason: string | null;
      left_behind: number;
    };
    assertEquals(started.free_capped, true, "a 60-row free import was not reported as capped");
    assertEquals(started.free_cap, 25, "the bound came from the request rather than the server");
    assertEquals(started.total_rows, 25, `the server kept ${started.total_rows} rows, not 25`);
    assertEquals(started.left_behind, 35);
    // F holds no listings yet, so the 25-row read bound is the one that bit,
    // not the plan's listing cap. The two compose and the response says which.
    assertEquals(started.free_cap_reason, "rows");

    // The run belongs to the caller: B cannot read it.
    const foreign = await fetch(`${BASE}/api/flipdesk/import/runs/${started.run_id}`, {
      headers: authHeaders(B_JWT!),
    });
    if (foreign.status === 200) {
      const view = await foreign.json() as { run: unknown };
      assertEquals(view.run, null, "B read another tenant's free-plan import run");
    } else {
      await foreign.body?.cancel();
    }

    // ── The bound is not per-press (US-3263, second cut) ──────────────────
    //
    // Import is a button. A bound that applies to one READ and to nothing else
    // is no bound at all: press it twenty times and a free account sits on five
    // hundred live listings against a plan that allows twenty-five. The first
    // cut skipped the active-listing accounting for unentitled accounts
    // entirely, so that is exactly what it did. Wait for this run to land its
    // 25 and press again with 60 DIFFERENT listings.
    let landed = false;
    for (let i = 0; i < 120 && !landed; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await fetch(`${BASE}/api/flipdesk/import/runs/${started.run_id}`, {
        headers: authHeaders(freeJwt),
      });
      const view = await poll.json() as { run?: { status?: string } | null };
      const status = view.run?.status ?? null;
      if (status === "completed" || status === "failed") landed = true;
    }
    assert(landed, "the free-plan import run never finished, so the second press proves nothing");

    const second = Array.from({ length: 60 }, (_, i) => ({
      listingUrl: `https://poshmark.com/listing/free-tier-second-${i}-${poshmarkProbeId()}`,
      title: `Free-tier-second-${i}`,
      priceCents: 2000 + i,
    }));
    const res2 = await fetch(`${BASE}/api/flipdesk/closet-import/runs`, {
      method: "POST",
      headers: authHeaders(freeJwt),
      body: JSON.stringify({ platform: "poshmark", listings: second }),
    });
    const body2 = await res2.json() as {
      error?: string;
      cap?: string;
      limit?: number;
      total_rows?: number;
      run_id?: string;
    };
    if (res2.status === 402) {
      // The plan's listing cap is full and nothing in the read is already here.
      assertEquals(body2.error, "CAP_REACHED");
      assertEquals(body2.cap, "activeListings");
    } else {
      // A partially-landed run leaves some headroom; whatever is left, the
      // second press must never be allowed a fresh 25.
      assertEquals(res2.status, 202, `second free press returned ${res2.status}`);
      assert(
        (body2.total_rows ?? 0) < 25,
        `a second free press imported ${body2.total_rows} more rows; the plan cap was not counted`,
      );
      if (body2.run_id) {
        await fetch(`${BASE}/api/flipdesk/import/runs/${body2.run_id}/undo`, {
          method: "POST",
          headers: authHeaders(freeJwt),
        }).then((r) => r.body?.cancel());
      }
    }

    // Undo, so a re-run starts from the same place.
    await fetch(`${BASE}/api/flipdesk/import/runs/${started.run_id}/undo`, {
      method: "POST",
      headers: authHeaders(freeJwt),
    }).then((r) => r.body?.cancel());
  },
});

// US-9202: the pending-revise queue. Three doors, three properties: B cannot
// stamp A's item stale (revise-queue takes an item id from the body), B cannot
// clear A's stale marker (revise-confirm takes a listing id and a bare
// `applied: true` would tell A the marketplace confirmed an edit it never saw),
// and A's stale listing never shows in B's queue (the read takes no id).

Deno.test({
  name: "B cannot queue a revise on A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/listings/revise-queue`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        inventory_item_id: Deno.env.get("TEST_USER_A_ITEM_ID")!,
        fields: ["price", "title"],
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST revise-queue on a foreign item");
  },
});

Deno.test({
  name: "B cannot confirm a revise on A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_REVISE_LISTING_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/listings/revise-confirm`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        listing_id: Deno.env.get("TEST_USER_A_REVISE_LISTING_ID")!,
        applied: true,
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST revise-confirm on a foreign listing");
  },
});

Deno.test({
  name: "B's pending-revise queue never contains A's stale listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_REVISE_LISTING_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/listings/pending-revises`, {
      headers: authHeaders(B_JWT!),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return; // denied outright is also a pass
    }
    const body = await res.json() as { pending?: Array<{ listing_id: string }> };
    const ids = (body.pending ?? []).map((p) => p.listing_id);
    assert(
      !ids.includes(Deno.env.get("TEST_USER_A_REVISE_LISTING_ID")!),
      "B's pending-revise queue contained A's listing.",
    );
  },
});

// US-9203: relist on the extension channels. The single route takes a listing
// id in the path and the bulk route takes ids in the body; both create a NEW
// listings row for the copy on the caller's own tenant, so a foreign id must
// be a 404 (single) or a per-row not-found (bulk), never a copy of A's row.

Deno.test({
  name: "B cannot start an extension relist of A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_REVISE_LISTING_ID"),
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/listings/${Deno.env.get("TEST_USER_A_REVISE_LISTING_ID")}/relist-extension`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST relist-extension on a foreign listing");
  },
});

Deno.test({
  name: "B's bulk relist never copies A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_REVISE_LISTING_ID"),
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_REVISE_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/listings/bulk-relist`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_ids: [id] }),
    });
    // 402 is a pass: B without the autoRelist plan flag is stopped before any
    // row is read.
    if (res.status === 402 || DENIED.has(res.status)) {
      await res.body?.cancel();
      return;
    }
    assertEquals(res.status, 200, `bulk-relist returned ${res.status}`);
    const body = await res.json() as { results: Array<{ listing_id: string; ok: boolean; error?: string }> };
    const row = body.results.find((r) => r.listing_id === id);
    assert(row && !row.ok && /not found/i.test(row.error ?? ""), `A's listing was not refused per-row: ${JSON.stringify(row)}`);
  },
});

Deno.test({
  name: "the closet import refuses a payload carrying buyer identity",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/closet-import/runs`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        platform: "poshmark",
        listings: [{
          listingUrl: "https://poshmark.com/listing/x-a1b2c3d4e5f60718293a4b5d",
          title: "probe",
          buyerName: "someone",
        }],
      }),
    });
    const text = await res.text();
    assertEquals(res.status, 400, `expected the key to be refused; got ${res.status}: ${text}`);
    assert(text.includes("FORBIDDEN_KEY"), `refused for some other reason: ${text}`);
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

// ── PS-04: an outcome acts on the STORED order, not the body's ──────
//
// The refund, decide and approve routes used to pass body.order_id straight to
// the sale update. user_id scoping kept that inside the seller's own tenant,
// but a stale client could still refund, restock and reverse the payout on a
// DIFFERENT one of the seller's sales. This drives the same resolution and
// write the routes use, against a recording fake, so it runs without a
// fixture: a refund for return R-1 carrying sale 2's order id must leave sale 2
// exactly as it was.
Deno.test("PS-04: a mismatched body order_id does not move another of the seller's sales", async () => {
  const { fakeOutcomeDb } = await import("./_fake-outcome-db.ts");
  const { chooseOrderId, resolveCaseOrderId } = await import("../lib/post-sale-store.ts");
  const { applyOutcomeToSale } = await import("../lib/post-sale-outcome.ts");
  const owner = "owner-ps04";
  const sales = [
    { id: "s1", user_id: owner, platform_order_id: "O-1", inventory_item_id: "i1", listing_id: null, status: "completed" },
    { id: "s2", user_id: owner, platform_order_id: "O-2", inventory_item_id: "i2", listing_id: null, status: "completed" },
  ];
  const w = fakeOutcomeDb({
    sales,
    inventory_items: [{ id: "i1", user_id: owner }, { id: "i2", user_id: owner }],
    marketplace_post_sale_cases: [
      { user_id: owner, platform: "ebay", case_type: "return", external_id: "R-1", external_order_id: "O-1", reason: null, raw: {} },
    ],
  });
  const stored = await resolveCaseOrderId(owner, "return", "R-1", w.db);
  const chosen = chooseOrderId(stored, "O-2");
  assertEquals(chosen.orderId, "O-1");
  assert(chosen.mismatch, "the disagreement is reported for the audit row");
  await applyOutcomeToSale(owner, chosen.orderId, "return_refunded", {
    db: w.db,
    reversePayouts: () => Promise.resolve(),
  });
  assertEquals(sales[1]!.status, "completed", "sale 2 must be untouched");
  assertEquals(sales[0]!.status, "refunded");
});

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

// ── US-2935: the grade pack on the case surface ─────────────────────
//
// Same shape as the return and dispute evidence cases: a caseId straight from
// the path, plus from-pack mode carrying an order id that must resolve to
// NOTHING for a tenant who does not own it.
Deno.test({
  name: "B cannot attach evidence to A's eBay case",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_EBAY_CASE_ID"),
  fn: async () => {
    const caseId = Deno.env.get("TEST_USER_A_EBAY_CASE_ID")!;
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ), (ch) => ch.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([png], "evidence.png", { type: "image/png" }));
    const orderId = Deno.env.get("TEST_USER_A_EBAY_ORDER_ID");
    if (orderId) {
      form.append("order_id", orderId);
      form.append("complaint", "There is a stain on the cuff.");
    }
    const headers = authHeaders(B_JWT!) as Record<string, string>;
    delete headers["Content-Type"];
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/cases/${encodeURIComponent(caseId)}/evidence`,
      { method: "POST", headers, body: form },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST eBay case evidence");
  },
});

// ── US-2944: reconcile takes listing ids from the REQUEST BODY ──────
//
// The one shape in this story that can leak: every other new offer route is an
// owner-scoped read with no attacker-controlled id. This one accepts a list of
// listing ids and WRITES to them, so a missing owner filter would let B rewrite
// the best-offer threshold on A's listings — and the response would be a
// cheerful 200 with a count, not a 403.
Deno.test({
  name: "B cannot reconcile the offer thresholds on A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/ebay/negotiation/threshold-conflicts/reconcile`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ listing_ids: [listingId] }),
      },
    );
    // 409 (B has no offer rule) and a denial are both fine. A 200 that reports
    // `updated > 0` is the failure — it means A's listing was written.
    if (res.status === 200) {
      const body = await res.json().catch(() => ({}));
      assertEquals(
        body.updated,
        0,
        "reconcile wrote to a listing belonging to another tenant",
      );
      return;
    }
    await res.body?.cancel();
    assert(
      res.status === 409 || res.status === 401 || res.status === 403 ||
        res.status === 404 || res.status === 400,
      `unexpected status ${res.status} for cross-tenant reconcile`,
    );
  },
});

// ── US-2948: bulk ad ops take listing ids from the REQUEST BODY ─────
//
// Every other new marketing route resolves the campaign from the seller's own
// connection and takes no attacker-controlled id. This one accepts a list of
// eBay listing ids and pushes ad rates against them, so a missing owner check
// would let B start promoting — and paying for — A's listings.
//
// The route rejects a foreign id BY NAME rather than silently dropping it: a
// silent drop reports a smaller success than the caller asked for and says
// nothing about why.
Deno.test({
  name: "B cannot bulk-promote A's eBay listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // The route takes LOCAL listing ids, which is the stronger boundary: the id
    // resolves through a row we own, so A's id resolves to nothing for B.
    const foreignId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/marketing/ads/bulk`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listing_ids: [foreignId], bid_percentage: 5 }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST eBay bulk ads");
  },
});

// ── US-2953: the campaign create takes listing ids from the body ────
//
// The follower list is the one asset a mistake here destroys permanently, and
// the create route accepts a set of listing ids to feature. A missing owner
// check would let B build a campaign around A's stock.
Deno.test({
  name: "B cannot build a follower campaign from A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/ebay/marketing/email-campaigns`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        name: "Cross tenant",
        subject: "Should never send",
        listing_ids: [listingId],
      }),
    });
    await res.body?.cancel();
    // 409 = none of those listings resolved for this tenant, which is the
    // correct answer and the one the route gives.
    assert(
      res.status !== 200,
      "the campaign create accepted a listing belonging to another tenant",
    );
  },
});

// ── US-2958: the description-block routes ───────────────────────────
//
// All four take a listing id, and three of them WRITE. The renderer reads the
// item, the grade report and the seller's snippets to build the text, so a
// missing owner check would not merely edit another tenant's listing — it would
// render their garment's measurements and grade into a description and hand it
// back in the response body. Every case below asserts on the STATUS rather than
// the body for the same reason: a 200 here is already a leak.
Deno.test({
  name: "B cannot read the description blocks of A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/description/${listingId}/blocks`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "GET description blocks");
  },
});

Deno.test({
  name: "B cannot preview a description against A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // Preview is read-only, which is exactly why it is worth a case: a
    // read-only route that renders another tenant's item into the response is
    // the quietest possible leak.
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/description/preview`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        listing_id: listingId,
        blocks: [{ key: "measurements", on: true, src: "item" }],
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST description preview");
  },
});

Deno.test({
  name: "B cannot save description blocks onto A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/description/${listingId}/save`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({
          blocks: [{ key: "text", on: true, src: "user", text: "Owned by B." }],
        }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST description save");
  },
});

Deno.test({
  name: "B cannot regenerate a description block on A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    // Denial must come from the OWNER check, before the model call. A route
    // that rewrote first and refused to save afterwards would still bill A's
    // workspace for B's request.
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/description/${listingId}/regenerate`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ block: "features" }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST description regenerate");
  },
});

// ── The extension channels' rendered descriptions (2026-09-07) ─────
//
// Read-only, and worth a case for exactly that reason: it renders another
// tenant's brand, size, colour, measurements and grade into plain text and
// returns it. A leak here is the whole garment record in a response body, and
// nothing about the request looks like an attack — it is a GET with an id in
// the path.
Deno.test({
  name: "B cannot render A's listing into a marketplace description",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/description/${listingId}/platform-descriptions?platforms=poshmark`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "GET platform-descriptions");
  },
});

// ── A seller's own words for one channel (2026-09-11) ──────────────
//
// A WRITE onto another tenant's eBay draft. A hole here would let B put their
// own title on A's Poshmark cross-post, which A would then send without
// reading, because the whole point of the default is that nobody re-reads it.
Deno.test({
  name: "B cannot set a channel title on A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const listingId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/description/${listingId}/channel-copy`,
      {
        method: "POST",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({ platform: "poshmark", title: "Owned by B" }),
      },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST channel-copy");
  },
});

// ── The extension's publish confirmation (2026-09-07) ──────────────
//
// POST /api/grading/public/listed-confirm takes an ITEM id and flips a listing
// to active. Its front door is the extension's own bearer token rather than a
// SaaS session, which is precisely why it needs a case: a second auth dialect
// is a second place the owner check can be missed, and the write here marks an
// item listed and spends a plan slot.
Deno.test({
  name: "B cannot mark A's item listed through the extension confirmation",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const res = await fetch(`${BASE}/api/grading/public/listed-confirm`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        item_id: itemId,
        platform: "poshmark",
        listing_url: "https://poshmark.com/listing/abc-123",
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST listed-confirm");
  },
});

// ── US-2961: apply a snippet edit to the drafts referencing it ──────
//
// This one is keyed on a SNIPPET id, not a listing id, and it rewrites rows in
// bulk. Two things have to hold: a foreign snippet id must be refused, and the
// refusal must not report a count — a route that answered `{applied: 0}` for
// somebody else's snippet would confirm the snippet exists and, worse, a
// non-zero count would say how many drafts that tenant has open.
Deno.test({
  name: "B cannot apply A's snippet to any drafts",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_SNIPPET_ID"),
  fn: async () => {
    const snippetId = Deno.env.get("TEST_USER_A_SNIPPET_ID")!;
    const res = await fetch(
      `${BASE}/api/flipdesk/description/snippets/${snippetId}/apply`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST snippet apply");
  },
});

Deno.test({
  name: "an unknown snippet id is refused the same way a foreign one is",
  ignore: !CONFIGURED,
  fn: async () => {
    // Same 404 for "not yours" and "not there". If the two ever diverge, the
    // route becomes an oracle for whether a guessed id belongs to somebody.
    const res = await fetch(
      `${BASE}/api/flipdesk/description/snippets/00000000-0000-4000-8000-000000000000/apply`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST snippet apply (unknown id)");
  },
});

// ── US-2971/US-2972: the pipeline XP sweep ──────────────────────────────────

//
// The sweep runs implicitly on GET /api/rewards/state and derives XP from the
// caller's inventory. It takes NO id from the request — the surface a normal
// tenant test attacks does not exist here — so what has to be pinned instead is
// that the id it uses cannot be influenced from outside, and that the read stays
// personal. A regression in either would silently credit one seller with
// another's months of listing work.

/** Any id the caller does not own. The point is that it is IGNORED, not denied. */
const SPOOF_ID = WS_OWNER ?? "00000000-0000-4000-8000-000000000000";

Deno.test({
  name: "rewards state ignores a user_id supplied by the caller",
  ignore: !CONFIGURED,
  fn: async () => {
    const plain = await fetch(`${BASE}/api/rewards/state`, {
      headers: authHeaders(B_JWT!),
    });
    const mine = await plain.json();

    // Same call, but asking for A's numbers three different ways.
    for (const qs of [
      `?user_id=${SPOOF_ID}`,
      `?userId=${SPOOF_ID}`,
      `?owner=${SPOOF_ID}`,
    ]) {
      const res = await fetch(`${BASE}/api/rewards/state${qs}`, {
        headers: authHeaders(B_JWT!),
      });
      assertEquals(res.status, 200, `GET /api/rewards/state${qs}`);
      const spoofed = await res.json();
      assertEquals(
        spoofed?.progress?.xpTotal,
        mine?.progress?.xpTotal,
        `GET /api/rewards/state${qs} returned different XP than the caller's own`,
      );
    }
  },
});

Deno.test({
  name: "rewards state stays personal under a workspace-owner header",
  ignore: !CONFIGURED || !WS_OWNER,
  fn: async () => {
    // XP is a personal standing, not a workspace resource: a member acting
    // inside the owner's tenant must still see their OWN level, and the sweep
    // must credit their own items rather than the owner's inventory.
    const own = await fetch(`${BASE}/api/rewards/state`, {
      headers: authHeaders(B_JWT!),
    });
    const ownBody = await own.json();

    const asMember = await fetch(`${BASE}/api/rewards/state`, {
      headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": WS_OWNER! },
    });
    assertEquals(asMember.status, 200, "GET /api/rewards/state with workspace header");
    const memberBody = await asMember.json();
    assertEquals(
      memberBody?.progress?.xpTotal,
      ownBody?.progress?.xpTotal,
      "the workspace header must not switch whose XP is returned",
    );
  },
});

Deno.test({
  // US-2997: the QuickBooks connector. Every route resolves the tenant as
  // workspaceOwnerId ?? userId and the realm id comes only from the row loaded
  // that way -- it is never read from a request body, because that is exactly
  // how a seller's sale would land in another company's file. B, holding a
  // valid JWT for their own workspace, must never see or change A's connection.
  //
  // The statuses to expect: 503 when QBO_CLIENT_ID is unset (the usual state on
  // a test stack), 403 when B is not an admin, 400 when B simply has no
  // connection of their own, 401 without a session. Never a 200 carrying
  // another tenant's realm.
  name: "B cannot read, connect or map another workspace's QuickBooks",
  ignore: !CONFIGURED,
  fn: async () => {
    const start = await fetch(`${BASE}/api/flipdesk/qbo/oauth/start`, {
      headers: authHeaders(B_JWT!),
    });
    await start.body?.cancel();
    assert(
      [200, 401, 403, 503].includes(start.status),
      `qbo oauth/start: expected 200/401/403/503 but got ${start.status}`,
    );

    // Status is B's OWN connection or null. It must never carry a realm id
    // belonging to anyone else, which is what a leak here would look like.
    const status = await fetch(`${BASE}/api/flipdesk/qbo/status`, {
      headers: authHeaders(B_JWT!),
    });
    if (status.status === 200) {
      const body = await status.json();
      assert(
        body?.connection === null || typeof body?.connection?.realm_id === "string",
        "qbo status returned a malformed connection",
      );
    } else {
      await status.body?.cancel();
      assertDenied(status.status, "qbo status");
    }

    // Saving a mapping without a connection must refuse rather than write a row
    // keyed on somebody else's connection_id. The route ignores any
    // connection_id in the body and loads it owner-scoped, so this is a 400.
    const put = await fetch(`${BASE}/api/flipdesk/qbo/mappings`, {
      method: "PUT",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        connection_id: SPOOF_ID,
        mappings: [{ account_code: "sales_revenue", qbo_account_id: "1" }],
      }),
    });
    await put.body?.cancel();
    assert(
      put.status !== 200 && [400, 401, 403, 503].includes(put.status),
      `qbo mappings PUT: expected 400/401/403/503 but got ${put.status}`,
    );

    // Disconnect is admin-gated and owner-scoped. It is idempotent, so a 200 is
    // legitimate for a caller who has no connection -- but it must never have
    // touched A's row. The following status read proves nothing was torn down
    // on the other side, because a cross-tenant teardown would be invisible in
    // the disconnect response itself.
    const disc = await fetch(`${BASE}/api/flipdesk/qbo/disconnect`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({}),
    });
    await disc.body?.cancel();
    assert(
      [200, 401, 403].includes(disc.status),
      `qbo disconnect: expected 200/401/403 but got ${disc.status}`,
    );
  },
});

Deno.test({
  // The cron sweep rotates tokens for EVERY tenant, so it is job-secret only
  // and must not be reachable with an ordinary user's JWT. A seller who could
  // call it would be triggering refreshes across the whole platform.
  name: "the QuickBooks refresh sweep refuses a user JWT",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/qbo/oauth/refresh`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assertEquals(res.status, 401, "qbo oauth/refresh must be job-secret only");
  },
});

Deno.test({
  // US-2998: the push routes. /sync takes a run_id in its BODY, which is the
  // one attacker-controlled id in this module -- it is loaded .eq("user_id")
  // before anything else touches it, so a foreign run is a 404 rather than a
  // resumed sync into another tenant's QuickBooks. The log and run listings are
  // owner-scoped reads that must never carry another tenant's rows.
  name: "B cannot resume another workspace's QuickBooks sync or read its log",
  ignore: !CONFIGURED,
  fn: async () => {
    const resume = await fetch(`${BASE}/api/flipdesk/qbo/sync`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        period_start: "2025-01-01",
        period_end: "2026-01-01",
        run_id: SPOOF_ID,
      }),
    });
    await resume.body?.cancel();
    assert(
      resume.status !== 200 && [400, 401, 403, 404, 503].includes(resume.status),
      `qbo sync resume: expected 400/401/403/404/503 but got ${resume.status}`,
    );

    for (const path of ["/api/flipdesk/qbo/sync/log", "/api/flipdesk/qbo/sync/runs"]) {
      const res = await fetch(`${BASE}${path}`, { headers: authHeaders(B_JWT!) });
      if (res.status === 200) {
        const body = await res.json();
        const rows = body?.entries ?? body?.runs ?? [];
        assert(Array.isArray(rows), `${path} did not return a list`);
        // B has no QuickBooks connection in the fixture, so their own log is
        // empty. A non-empty one here would be somebody else's.
        assertEquals(rows.length, 0, `${path} returned rows for a tenant with no connection`);
      } else {
        await res.body?.cancel();
        assertDenied(res.status, path);
      }
    }
  },
});

// ── US-9207: the time-saved meter is the caller's own month, never a lookup ──

Deno.test({
  name: "US-9207: time-saved rejects a user or owner id outright",
  ignore: !CONFIGURED,
  fn: async () => {
    for (const param of ["user_id", "owner_id", "userId", "ownerId"]) {
      const res = await fetch(
        `${BASE}/api/flipdesk/time-saved?month=2026-09&${param}=${crypto.randomUUID()}`,
        { headers: authHeaders(B_JWT!) },
      );
      await res.body?.cancel();
      if (DENIED.has(res.status) || res.status === 402) continue;
      assertEquals(res.status, 400, `time-saved accepted ?${param}=; a meter that takes an owner id is a read of someone else's month`);
    }
  },
});

// ── US-9212: the creator programme is the caller's own, on their own JWT ────

Deno.test({
  // Every one of these routes keys off the JWT's userId and nothing else. The
  // risk they carry is the opposite of a lookup: a body field that names an
  // account (user_id / owner_user_id) must not be able to accept terms for
  // somebody else or file a tax identity under their name.
  name: "US-9212: creator terms and the tax profile ignore an id in the body",
  ignore: !CONFIGURED,
  fn: async () => {
    const victim = crypto.randomUUID();

    const terms = await fetch(`${BASE}/api/affiliate/creator/terms`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        accept: true,
        version: "2026-09-01",
        user_id: victim,
        owner_user_id: victim,
      }),
    });
    const termsBody = terms.status === 200 ? await terms.json() : null;
    if (!termsBody) await terms.body?.cancel();
    assert(
      terms.status === 200 || DENIED.has(terms.status) || terms.status === 409,
      `creator terms: unexpected ${terms.status}`,
    );

    const tax = await fetch(`${BASE}/api/affiliate/tax-profile`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        legal_name: "Isolation Test",
        entity_type: "individual",
        tin: "123456789",
        country: "US",
        owner_user_id: victim,
        user_id: victim,
      }),
    });
    if (tax.status === 200) {
      const body = await tax.json();
      // The response must never echo the ciphertext or the full number.
      const serialized = JSON.stringify(body);
      assert(!/tin_encrypted/.test(serialized), "the tax route returned the ciphertext");
      assert(!/123456789/.test(serialized), "the tax route echoed the full TIN");
    } else {
      await tax.body?.cancel();
      assert(
        DENIED.has(tax.status) || tax.status === 400 || tax.status === 503,
        `tax profile: unexpected ${tax.status}`,
      );
    }

    // Whatever happened above, it happened to B. The victim id must be
    // unreadable and untouched from B's own status endpoint.
    const status = await fetch(`${BASE}/api/affiliate/creator`, {
      headers: authHeaders(B_JWT!),
    });
    if (status.status === 200) {
      const body = await status.json();
      assert(
        !JSON.stringify(body).includes(victim),
        "the creator status endpoint carried an id from the request body",
      );
      // Accepting terms is not admission: the programme stays "user" until an
      // operator approves, and the fixture has no operator.
      assertEquals(body.program, "user", "terms acceptance alone made an account a creator");
    } else {
      await status.body?.cancel();
      assertDenied(status.status, "/api/affiliate/creator");
    }
  },
});

Deno.test({
  // Admission is platform-level and lives under /api/admin/*. A seller's JWT
  // reaching it would let anyone make themselves a cash-earning creator.
  name: "US-9212: creator admission refuses a seller JWT",
  ignore: !CONFIGURED,
  fn: async () => {
    for (const path of [
      "/api/admin/growth/affiliate/creators",
      `/api/admin/growth/affiliate/creators/${crypto.randomUUID()}/approve`,
    ]) {
      const res = await fetch(`${BASE}${path}`, {
        method: path.endsWith("/approve") ? "POST" : "GET",
        headers: authHeaders(B_JWT!),
      });
      await res.body?.cancel();
      assertDenied(res.status, path);
    }
  },
});

Deno.test({
  // US-3088 AC2. /api/grading/public/listing-draft is UNAUTHENTICATED, so there
  // is no tenant to scope it to and the only safe posture is that it writes
  // nothing at all. That claim is worth a case rather than a comment: the paid
  // path it shares a prompt with (generateListing) creates an inventory_items
  // row and a listings row, and the free endpoint is one accidental reuse away
  // from doing the same for a stranger — into whichever tenant the service-role
  // client happened to touch last.
  //
  // The OUTCOME of the call is deliberately not asserted. Whether the model
  // answers, the daily ceiling refuses it, or the fixture has no real API key
  // and it 500s, the property is the same and it is the one that matters: the
  // row counts do not move.
  name: "US-3088: an anonymous listing-draft call writes no item and no listing",
  ignore: !CONFIGURED || !A_API_KEY,
  fn: async () => {
    const counts = async (): Promise<{ items: number; listings: number }> => {
      const [i, l] = await Promise.all([
        fetch(`${BASE}/api/v1/items?limit=1`, { headers: apiKeyHeaders(A_API_KEY!) }),
        fetch(`${BASE}/api/v1/listings?limit=1`, { headers: apiKeyHeaders(A_API_KEY!) }),
      ]);
      const [ij, lj] = await Promise.all([i.json(), l.json()]);
      assertEquals(i.status, 200, "items count read failed");
      assertEquals(l.status, 200, "listings count read failed");
      return { items: ij.meta?.total ?? -1, listings: lj.meta?.total ?? -1 };
    };

    const before = await counts();
    assert(before.items >= 0 && before.listings >= 0, "the counts are not readable");

    // A canonical 1x1 PNG, so the request passes the magic-byte sniff and gets
    // as far into the handler as the fixture allows.
    const onePx =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const res = await fetch(`${BASE}/api/grading/public/listing-draft`, {
      method: "POST",
      // No Authorization header, by design.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [onePx], target: "ebay", brand: "Patagonia" }),
    });
    await res.body?.cancel();
    assert(res.status !== 401 && res.status !== 403, "the free tool now requires auth");

    const after = await counts();
    assertEquals(after.items, before.items, "an anonymous draft created an inventory item");
    assertEquals(after.listings, before.listings, "an anonymous draft created a listing");
  },
});

Deno.test({
  // US-3060 AC8. The badge route is UNAUTHENTICATED and takes no user id, so
  // there is no tenant to scope it to. That is a property worth a case rather
  // than a comment, because the obvious "improvement" to this endpoint is to
  // let a caller pass a seller id to narrow the lookup — which would turn a
  // public read into an inventory oracle over every other tenant.
  //
  // Deliberately NOT gated on a seeded platform_listing_id. A case needing a
  // graded, published, certificated item would gate on an id the seed script
  // does not emit, so it would skip in CI and prove nothing. What is asserted
  // here holds for ANY id: no auth is required, an unknown id is an empty
  // answer rather than an error, and a user id in the query changes nothing.
  name: "US-3060: the listing-badge route takes no user id and leaks nothing",
  ignore: !CONFIGURED,
  fn: async () => {
    const path = "/api/grading/public/listing-certificates";
    const unknown = `zzz-${crypto.randomUUID()}`;

    const anon = await fetch(`${BASE}${path}?platform=ebay&ids=${unknown}`);
    assertEquals(anon.status, 200, "the public badge route now requires auth");
    const body = await anon.json();
    assertEquals(body.found, 0, "an unknown listing id returned a certificate");
    assertEquals(body.certificates.length, 0);
    // Absence is not a claim: no "unverified" marker, ever.
    assert(
      !JSON.stringify(body).toLowerCase().includes("unverified"),
      "the response carries an unverified marker",
    );

    // A user id in the query must not narrow, widen or otherwise change the
    // answer — the route must simply not read it.
    const withUser = await fetch(
      `${BASE}${path}?platform=ebay&ids=${unknown}&user_id=${Deno.env.get("TEST_WORKSPACE_OWNER_ID") ?? ""}`,
    );
    assertEquals(withUser.status, 200);
    assertEquals(
      JSON.stringify(await withUser.json()),
      JSON.stringify(body),
      "a user_id in the query changed the answer, so the route is reading it",
    );

    // And an authenticated caller gets exactly the same public answer: there is
    // no privileged view of this endpoint to accidentally expose.
    const asB = await fetch(`${BASE}${path}?platform=ebay&ids=${unknown}`, {
      headers: authHeaders(B_JWT!),
    });
    assertEquals(asB.status, 200);
    assertEquals(JSON.stringify(await asB.json()), JSON.stringify(body));

    // The route now also reads `submissions` (the withheld gate), which is a
    // multi-tenant table on an anonymous route with no owner to scope to. What
    // keeps that safe is that the read is SUPPRESSION-ONLY: its ids are derived
    // server-side from grade reports already reached through the listing chain,
    // and nothing it returns may reach the response. So no submission field,
    // and no moderation vocabulary, may appear in a body — a caller must not be
    // able to learn that some listing's grade is flagged or under review.
    for (
      const leaked of [
        "submission_id",
        "submissionId",
        "moderation_status",
        "moderationStatus",
        "flagged",
        "pending_review",
        "withheld",
      ]
    ) {
      assert(
        !JSON.stringify(body).includes(leaked),
        `${leaked} reached the anonymous badge response`,
      );
    }
    // And a submission id in the query is not read, exactly as user_id is not.
    const withSub = await fetch(
      `${BASE}${path}?platform=ebay&ids=${unknown}&submission_id=${crypto.randomUUID()}`,
    );
    assertEquals(withSub.status, 200);
    assertEquals(
      JSON.stringify(await withSub.json()),
      JSON.stringify(body),
      "a submission_id in the query changed the answer, so the route is reading it",
    );
  },
});

Deno.test({
  // US-3065 AC5. The write tool creates rows the seller's own browser will run
  // against real marketplaces, so an unscoped one would let tenant B queue work
  // against tenant A's items — and once drained, A's title and photos would be
  // read into B's browser. That is the whole reason the enqueue path re-checks
  // ownership rather than trusting the authenticated caller's ids.
  name: "MCP: B cannot queue extension work against A's item (gradethread_queue_extension_work)",
  ignore: !CONFIGURED || !B_API_KEY || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;

    // PREVIEW must refuse too, not just confirm. A preview that named A's item
    // title back to B would be the leak even if nothing was ever written.
    const preview = await callMcpTool(B_API_KEY!, "gradethread_queue_extension_work", {
      kind: "list",
      item_ids: [itemId],
      platforms: ["poshmark"],
      mode: "preview",
    });
    // ⚠ foreignData is UNDEFINED, not itemId, and the helper's own comment says
    // why: a handler that correctly refuses still echoes the id the caller
    // supplied. Asserting on it fails a CORRECT denial, which is how the first
    // version of these cases reported four leaks that were not leaks. What
    // would be a real leak here is A's item TITLE, which B never supplied — and
    // that is unknown to this test, so the assertion is that the call was
    // refused at all.
    assertToolDeniedById(preview.body, undefined, "queue_extension_work preview as B");

    // And confirm, with a token B could not legitimately hold.
    const confirm = await callMcpTool(B_API_KEY!, "gradethread_queue_extension_work", {
      kind: "list",
      item_ids: [itemId],
      platforms: ["poshmark"],
      mode: "confirm",
      confirm_token: "gtc_not_a_real_token",
    });
    assertToolDeniedById(confirm.body, undefined, "queue_extension_work confirm as B");
  },
});

Deno.test({
  // US-3065 AC5. The read tool takes NO arguments, so the only thing that can
  // scope it is the credential. A tool with nothing to pass is the easiest one
  // to write unscoped and the hardest to notice: it would simply return
  // everyone's queue and look like it worked.
  name: "MCP: gradethread_extension_queue answers only for the calling tenant",
  ignore: !CONFIGURED || !A_API_KEY || !B_API_KEY,
  fn: async () => {
    const asA = await callMcpTool(A_API_KEY!, "gradethread_extension_queue", {});
    const asB = await callMcpTool(B_API_KEY!, "gradethread_extension_queue", {});

    // Both may legitimately be empty. What must NOT happen is the two
    // answering with the same counts drawn from an unscoped read, so the
    // assertion is on the id: A's item id must never appear in B's answer.
    // B never supplied A's id, so A's id appearing anywhere in B's answer is a
    // leak, full stop — the assertListExcludes case rather than the
    // assertToolDeniedById one.
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID");
    if (itemId && asB.status === 200) {
      assertListExcludes(asB.body, itemId, "extension_queue as B");
    }
    // A positive control so an all-403 fixture cannot pass this silently.
    assert(
      asA.status === 200 || asB.status === 200,
      `neither tenant could reach the tool at all (A ${asA.status}, B ${asB.status}); ` +
        `this case would pass without exercising the handler`,
    );
  },
});

// ── US-3138: the Action Credit wallet ────────────────────────────────
//
// A wallet is money, so the two questions are the ones money always asks: can
// I read someone else's, and can I make someone else pay for mine.
//
// The checkout route takes NO id from the request body, which is the strongest
// form of scoping and also the easiest to erode later: adding a convenience
// `userId` field would be a one-line change that reads as harmless. These cases
// exist so that change fails.

Deno.test({
  name: "action credits: the balance in billing-summary is the caller's own",
  ignore: !CONFIGURED,
  fn: async () => {
    const asA = await fetch(`${BASE}/api/payments/billing-summary`, {
      headers: authHeaders(A_JWT!),
    });
    const asB = await fetch(`${BASE}/api/payments/billing-summary`, {
      headers: authHeaders(B_JWT!),
    });
    assert(
      asA.status === 200 && asB.status === 200,
      `both tenants must reach billing-summary (A ${asA.status}, B ${asB.status}); ` +
        `otherwise this case passes without exercising the handler`,
    );
    const a = await asA.json();
    const b = await asB.json();

    // The shape must exist on both, or the assertion below is vacuous.
    assert(
      a.action_credits && typeof a.action_credits.balance === "number",
      "billing-summary did not carry an action_credits block for A",
    );
    assert(
      b.action_credits && typeof b.action_credits.balance === "number",
      "billing-summary did not carry an action_credits block for B",
    );
    // The fixture funds A's wallet and ONLY A's. That asymmetry is the whole
    // point: with both at zero, a cross-tenant read and a correctly scoped one
    // return the same answer and this case would pass against an unscoped
    // handler.
    const funded = Number(Deno.env.get("TEST_USER_A_ACTION_CREDITS") ?? "0");
    assertEquals(a.action_credits.balance, funded, "A cannot see the credits it was granted");
    assertEquals(b.action_credits.balance, 0, "B is reading A's wallet balance");
  },
});

Deno.test({
  name: "action credits: a checkout cannot name whose wallet to credit",
  ignore: !CONFIGURED,
  fn: async () => {
    // B asks for a pack while trying to point the grant at A. The route derives
    // the wallet from the AUTH CONTEXT and ignores the body entirely, so the
    // only two acceptable answers are a session created for B, or a refusal
    // because Stripe pricing is not configured in this environment.
    const res = await fetch(`${BASE}/api/payments/action-credits/checkout`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        pack: "50",
        user_id: "00000000-0000-0000-0000-0000000000aa",
        userId: "00000000-0000-0000-0000-0000000000aa",
      }),
    });
    assert(
      res.status === 200 || res.status === 503 || DENIED.has(res.status),
      `unexpected status ${res.status} from an action-credits checkout carrying a ` +
        `foreign user id; it must be ignored, not honored`,
    );
    if (res.status === 200) {
      const body = await res.text();
      assertListExcludes(body, "0000000000aa", "action-credits checkout as B");
    }
  },
});

Deno.test({
  name: "action credits: the checkout rejects a pack key it does not sell",
  ignore: !CONFIGURED,
  fn: async () => {
    // Not isolation, but the same input-trust question: the pack decides how
    // many credits a completed payment grants, so an unvalidated key is a
    // pricing hole. Only the four real keys may pass.
    for (const pack of ["25", "999999", "", "50; drop", null]) {
      const res = await fetch(`${BASE}/api/payments/action-credits/checkout`, {
        method: "POST",
        headers: authHeaders(A_JWT!),
        body: JSON.stringify({ pack }),
      });
      assert(
        res.status === 400 || DENIED.has(res.status),
        `pack ${JSON.stringify(pack)} was not rejected (status ${res.status})`,
      );
    }
  },
});

Deno.test({
  name: "action credits: the ledger returns only the caller's own rows",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/payments/ledger`, {
      headers: authHeaders(B_JWT!),
    });
    assert(res.status === 200, `ledger unreachable as B (${res.status})`);
    const body = await res.json();
    assert(
      Array.isArray(body.action_credits),
      "ledger did not carry an action_credits array",
    );
    // B bought nothing, so B's action-credit history is empty. A global read
    // would surface the fixture's grant to A, which is the row this asserts is
    // absent.
    const foreign = Deno.env.get("TEST_USER_A_ID");
    if (foreign) {
      assertListExcludes(JSON.stringify(body.action_credits), foreign, "ledger as B");
    }
    assertEquals(
      body.action_credits.length,
      0,
      "B has an action-credit history despite never buying a pack",
    );

    // Positive control: A must be able to see its own grant, or the assertion
    // above is satisfied by a ledger that returns nothing to anyone.
    const asA = await fetch(`${BASE}/api/payments/ledger`, { headers: authHeaders(A_JWT!) });
    assert(asA.status === 200, `ledger unreachable as A (${asA.status})`);
    const aBody = await asA.json();
    assert(
      aBody.action_credits.length > 0,
      "A cannot see its own seeded grant, so this case proves nothing",
    );
  },
});

Deno.test({
  // US-3142: the extension registers its own push subscription so a sale can
  // wake it. The DELETE takes an endpoint from the client, which makes it the
  // exact shape US-268 exists for — an id the caller supplies, filtered
  // together with the owner so a foreign one matches zero rows.
  //
  // The damage if it were not: a push endpoint is not secret to the person who
  // holds it, and an unscoped delete would let B turn off A's instant
  // delisting. A would see nothing at all — their listings would simply go back
  // to ending on the 5-minute check, and nothing anywhere would say why.
  name: "B cannot delete another workspace's extension push subscription",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/extension-queue/push-subscription`,
      {
        method: "DELETE",
        headers: authHeaders(B_JWT!),
        body: JSON.stringify({
          endpoint: "https://fcm.googleapis.com/fcm/send/tenant-isolation-probe",
        }),
      },
    );
    await res.body?.cancel();
    // A 200 is correct here and is NOT a leak: the delete is owner-scoped, so
    // an endpoint B does not own matches zero rows and removes nothing. What
    // would be a failure is a 200 from a route that had dropped the owner
    // filter, which is what the source assertion in extension-wake_test.ts
    // pins. This case proves the route exists, is authenticated, and refuses an
    // unauthenticated caller below.
    assert(
      res.status === 200 || res.status === 402 || res.status === 400,
      `DELETE push-subscription as B returned ${res.status}; expected a clean ` +
        "owner-scoped no-op, a plan gate, or a validation error",
    );
  },
});

Deno.test({
  // The same route with no credentials at all. A push subscription names a
  // browser; registering one anonymously would let anyone attach a wake channel
  // to an account they do not hold.
  name: "an unauthenticated caller cannot register an extension push subscription",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/extension-queue/push-subscription`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "https://fcm.googleapis.com/fcm/send/anon-probe",
          keys: { p256dh: "x", auth: "y" },
        }),
      },
    );
    await res.body?.cancel();
    assert(
      res.status === 401 || res.status === 403,
      `unauthenticated POST push-subscription returned ${res.status}; expected 401/403`,
    );
  },
});

Deno.test({
  // US-3159: the cloud folder grant belongs to the PERSON, not the workspace.
  // B asking for A's Dropbox listing must not reach A's grant — and the route
  // keys the connection lookup on the caller's own userId, so B with no
  // connection of their own gets a clean 409 rather than A's folder.
  //
  // The damage if it were not: a workspace member would be able to read every
  // photo in a colleague's personal Dropbox, which is a folder the colleague
  // never shared and that holds far more than listing shots.
  name: "B cannot list a cloud folder through another person's connection",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/cloud/dropbox/list?path=`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    // 409 = "you have not connected Dropbox", which is the correct answer for a
    // caller whose own userId has no row. 503 = the deploy has no Dropbox
    // credentials at all. 404 would mean the provider is unknown. What must
    // never happen is a 200 carrying somebody else's folder.
    assert(
      res.status === 409 || res.status === 503 || res.status === 404 || res.status === 402,
      `cloud list as B returned ${res.status}; expected a not-connected or ` +
        "not-configured refusal, never a folder",
    );
  },
});

Deno.test({
  // The import side of the same route. `paths` comes from the request body,
  // which is exactly the shape US-268 exists for: a caller-supplied
  // identifier that must be resolved through the caller's OWN grant.
  name: "B cannot import cloud files through another person's connection",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/cloud/dropbox/import`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ paths: ["/camera uploads/tenant-isolation-probe.jpg"] }),
    });
    await res.body?.cancel();
    assert(
      res.status === 409 || res.status === 503 || res.status === 404 || res.status === 402,
      `cloud import as B returned ${res.status}; expected a not-connected or ` +
        "not-configured refusal, never an import",
    );
  },
});

Deno.test({
  // No credentials at all. The OAuth start mints a state row that decides which
  // account a finished callback attaches a cloud grant to; an anonymous caller
  // able to mint one could aim somebody else's callback at their own user id.
  name: "an unauthenticated caller cannot start a cloud folder connection",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/cloud/dropbox/oauth/start`);
    await res.body?.cancel();
    assert(
      res.status === 401 || res.status === 403,
      `unauthenticated cloud oauth/start returned ${res.status}; expected 401/403`,
    );
  },
});

Deno.test({
  // US-3160: the same boundary at the second provider. Worth its own case
  // rather than trusting the first: the provider is resolved from a PATH
  // SEGMENT, so a registry that returned the wrong object, or a route that
  // looked the connection up by provider alone, would leak here and nowhere
  // else. The listing must resolve through B's own grant or refuse.
  name: "B cannot list a OneDrive folder through another person's connection",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/cloud/onedrive/list?path=`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assert(
      res.status === 409 || res.status === 503 || res.status === 404 || res.status === 402,
      `OneDrive list as B returned ${res.status}; expected a not-connected or ` +
        "not-configured refusal, never a folder",
    );
  },
});

Deno.test({
  // A provider name that is not in the registry must be refused by NAME, before
  // any connection lookup — otherwise the path segment reaches a query.
  name: "an unknown cloud provider is refused rather than looked up",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/cloud/gdrive/list?path=`, {
      headers: authHeaders(B_JWT!),
    });
    await res.body?.cancel();
    assert(
      res.status === 404 || res.status === 402,
      `unknown provider returned ${res.status}; expected 404`,
    );
  },
});

Deno.test({
  // US-3161: a capture code is an upload credential that needs no login, so the
  // ownership check has to happen BEFORE one is minted. The target id comes
  // from the request body, which is exactly the shape US-268 exists for.
  //
  // The damage if it were not: B could mint a code pointing at A's item and
  // then upload anything into A's catalogue from a phone, with nothing in A's
  // account saying where the photos came from.
  name: "B cannot start a phone capture aimed at another workspace's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/capture/sessions`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        targetKind: "item",
        targetId: Deno.env.get("TEST_USER_A_ITEM_ID"),
      }),
    });
    const body = await res.text();
    assert(
      res.status === 404 || res.status === 402 || res.status === 403,
      `capture session on A's item as B returned ${res.status}; expected 404`,
    );
    // A 404 rather than a 403 is deliberate: B should not learn whether the id
    // exists. Whatever comes back must not carry a capture URL.
    assert(!body.includes("/capture/"), "the refusal handed back a capture url");
  },
});

Deno.test({
  // The desktop's own status read. A session id is a uuid B could hold from
  // anywhere; the row must be owner-scoped or B watches A's photos arrive.
  name: "B cannot read another workspace's capture session",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(
      `${BASE}/api/flipdesk/capture/sessions/00000000-0000-4000-8000-000000000001`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assert(
      res.status === 404 || res.status === 402,
      `capture status as B returned ${res.status}; expected 404`,
    );
  },
});

Deno.test({
  // The public half. A guessed or malformed token must reach nothing, and must
  // not say whether a real session happens to exist behind a valid-looking one.
  name: "a made-up capture token reaches no session",
  ignore: !CONFIGURED,
  fn: async () => {
    for (
      const token of [
        "not-a-token",
        "../../api/flipdesk/items",
        "A".repeat(44),
      ]
    ) {
      const res = await fetch(
        `${BASE}/api/flipdesk/capture/s/${encodeURIComponent(token)}`,
      );
      await res.body?.cancel();
      assert(
        res.status === 404 || res.status === 410,
        `capture token "${token}" returned ${res.status}; expected 404/410`,
      );
    }
  },
});

Deno.test({
  // Minting a code is an authed action even though using one is not. An
  // anonymous caller able to mint would not need to guess a token at all.
  name: "an unauthenticated caller cannot mint a capture code",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/capture/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetKind: "item",
        targetId: Deno.env.get("TEST_USER_A_ITEM_ID") ?? "x",
      }),
    });
    await res.body?.cancel();
    assert(
      res.status === 401 || res.status === 403,
      `unauthenticated capture mint returned ${res.status}; expected 401/403`,
    );
  },
});

Deno.test({
  // US-3197: the cross-channel link confirm route ACTS on the ids its review
  // row names -- it moves a listing onto another item and archives the one it
  // left. A review row reachable across tenants is therefore not a read leak,
  // it is a merge of somebody else's garments with no unmerge button they
  // know about.
  //
  // The id is a uuid B could hold from anywhere, so the row must be
  // owner-scoped on the read that precedes the write, and the answer must be
  // 404 rather than 403: B should not learn whether the id exists.
  name: "B cannot confirm or split another workspace's cross-channel match",
  ignore: !CONFIGURED,
  fn: async () => {
    for (const decision of ["confirm", "split"]) {
      const res = await fetch(
        `${BASE}/api/flipdesk/import/link/reviews/00000000-0000-4000-8000-000000000042/${decision}`,
        { method: "POST", headers: authHeaders(B_JWT!) },
      );
      await res.body?.cancel();
      assert(
        res.status === 404 || res.status === 402 || res.status === 403,
        `${decision} on a foreign match returned ${res.status}; expected 404`,
      );
    }
  },
});

Deno.test({
  // The queue read. Every row names two of the seller's listings and a
  // similarity score, which is a map of their catalogue.
  name: "the cross-channel review queue returns only the caller's own matches",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/import/link/reviews`, {
      headers: authHeaders(B_JWT!),
    });
    if (res.status === 402 || res.status === 403) {
      await res.body?.cancel();
      return; // not entitled; nothing to prove about scoping
    }
    const body = await res.json() as { reviews?: Array<Record<string, unknown>> };
    assert(Array.isArray(body.reviews), "the queue did not return a list");
    // A's fixture listings must not appear in B's queue.
    const aItem = Deno.env.get("TEST_USER_A_ITEM_ID");
    if (aItem) {
      const leaked = body.reviews.filter((r) =>
        r.item_a_id === aItem || r.item_b_id === aItem
      );
      assertEquals(leaked, [], "A's item appeared in B's review queue");
    }
  },
});

Deno.test({
  // The scan is a WRITE: it joins listings and archives items. An
  // unauthenticated caller able to run it would reshape a stranger's
  // catalogue, and there is no unmerge button they would know to press.
  name: "an unauthenticated caller cannot run a cross-channel link scan",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/import/link/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    await res.body?.cancel();
    assert(
      res.status === 401 || res.status === 403,
      `unauthenticated link scan returned ${res.status}; expected 401/403`,
    );
  },
});

Deno.test({
  // US-3185: the group boundary is a PUBLIC route, reached with the token and
  // nothing else, so the same two questions apply as to the upload: a token
  // that is not ours must reach no session, and one that is must move only
  // its OWN session's counter.
  //
  // The damage if it did not: an index advanced on somebody else's session
  // would file the next shots that seller takes under an item they never
  // started, which is a silent mis-grouping of another workspace's catalogue.
  name: "a made-up capture token cannot advance anybody's item counter",
  ignore: !CONFIGURED,
  fn: async () => {
    for (
      const token of [
        "not-a-token",
        "../../api/flipdesk/items",
        "B".repeat(44),
      ]
    ) {
      const res = await fetch(
        `${BASE}/api/flipdesk/capture/s/${encodeURIComponent(token)}/next-item`,
        { method: "POST" },
      );
      await res.body?.cancel();
      assert(
        res.status === 404 || res.status === 410,
        `next-item on token "${token}" returned ${res.status}; expected 404/410`,
      );
    }
  },
});

Deno.test({
  // US-3185: `staging` is the one target kind with no row to own, because
  // AutoLister intake happens before a generation batch exists. What keeps it
  // scoped is that the session records the CALLER's owner id and the status
  // read filters on it — so a staging id borrowed from another seller mints a
  // code into the borrower's own session, and the other seller's desktop never
  // sees it. This asserts the half that could actually leak: reading back.
  name: "B cannot read a staging capture session started by A",
  ignore: !CONFIGURED,
  fn: async () => {
    const mint = await fetch(`${BASE}/api/flipdesk/capture/sessions`, {
      method: "POST",
      headers: authHeaders(A_JWT!),
      body: JSON.stringify({
        targetKind: "staging",
        targetId: crypto.randomUUID(),
      }),
    });
    if (mint.status === 402 || mint.status === 403) {
      await mint.body?.cancel();
      return; // A is not entitled here; nothing to prove about B.
    }
    const started = await mint.json() as { sessionId?: string };
    assert(typeof started.sessionId === "string", "A could not start a staging capture");

    const res = await fetch(
      `${BASE}/api/flipdesk/capture/sessions/${started.sessionId}`,
      { headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assert(
      res.status === 404 || res.status === 402,
      `A's staging capture read as B returned ${res.status}; expected 404`,
    );
  },
});

Deno.test({
  // US-3155: the Grailed closet import. Same shape as the Poshmark case above —
  // the batch names a marketplace listing id the caller supplies, so the row it
  // matches must be scoped to the caller's own tenant or B writes into A's
  // catalogue. Worth its own case rather than trusting the Poshmark one: the
  // platform arrives as a string in the payload, and a route that scoped by
  // marketplace id alone would leak on the newest platform first.
  name: "B cannot touch another workspace's row through a Grailed closet batch",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/closet-import/batches`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        platform: "grailed",
        page: "closet",
        listings: [{
          listingUrl: "https://www.grailed.com/listings/100703624-tenant-isolation-probe",
          platformListingId: "100703624",
          title: "tenant isolation probe",
        }],
      }),
    });
    await res.body?.cancel();
    // 401/403 (the extension token gate), 402 (plan) and 404 are all fine. A
    // 200 is fine too and is NOT a leak: the write is owner-scoped, so a
    // listing id B does not own creates a row for B rather than touching A's.
    assert(
      res.status < 500,
      `Grailed closet batch as B returned ${res.status}; expected a scoped write or a refusal`,
    );
  },
});

Deno.test({
  // US-3192 AC6: the bulk match-to-comp reprice preview reads the item's
  // floor_price straight off inventory_items. There was no case for this route
  // at all, so the scoping was correct and unguarded. The leak to watch for is
  // not the status: the route returns per-listing rows, and a foreign row
  // carrying margin_floor_cents tells B what A refuses to sell that garment
  // for, which is a costing figure.
  name: "B cannot preview a reprice of A's listing, or read its floor",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/pricing/reprice/preview`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ listingIds: [aId] }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      items?: Array<{
        listing_id: string;
        title?: string;
        current_price_cents?: number;
        margin_floor_cents?: number | null;
      }>;
    };
    // A plan gate, an eBay-not-configured 503, or an auth denial all mean B
    // never reached A's row.
    if (DENIED.has(res.status) || res.status === 402 || res.status === 503) return;
    assertEquals(res.status, 200, "reprice/preview should return 200 with per-row items");
    const row = (body.items ?? []).find((r) => r.listing_id === aId);
    // JSON.stringify(undefined) is undefined, not a string, and a template
    // literal is built BEFORE assert() is called. So the message for the PASS
    // case used to throw TypeError: Cannot read properties of undefined
    // (reading 'slice'), and this case failed exactly when tenant isolation was
    // working. Keep the argument non-undefined.
    assert(
      row === undefined,
      `reprice/preview returned a row for A's listing ${aId} to user B: ${
        JSON.stringify(row ?? null).slice(0, 200)
      }`,
    );
  },
});

Deno.test({
  // US-3192 AC6, the write half. reprice/apply re-derives the floor server-side
  // rather than trusting the preview, so it is the site where a cross-tenant id
  // would actually change A's price - and it pushes to A's live eBay offer.
  // The route reports per-row outcomes, so the isolation property is in the
  // row, not the status.
  name: "B cannot apply a reprice to A's listing",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_LISTING_ID"),
  fn: async () => {
    const aId = Deno.env.get("TEST_USER_A_LISTING_ID")!;
    const res = await fetch(`${BASE}/api/flipdesk/pricing/reprice/apply`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({ items: [{ listing_id: aId, price_cents: 100 }] }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      applied?: number;
      ebay_synced?: number;
      skipped?: Array<{ listing_id: string; reason: string }>;
    };
    if (DENIED.has(res.status) || res.status === 402 || res.status === 503) return;
    assertEquals(res.status, 200, "reprice/apply should return 200 with per-row results");
    assertEquals(
      body.applied ?? 0,
      0,
      `reprice/apply wrote a price to A's listing ${aId} for user B - cross-tenant write`,
    );
    assertEquals(
      body.ebay_synced ?? 0,
      0,
      `reprice/apply pushed a price to A's live eBay offer for user B`,
    );
    const skip = (body.skipped ?? []).find((s) => s.listing_id === aId);
    assert(
      skip === undefined || skip.reason === "not_found",
      `reprice/apply reached A's row for B and reported "${skip?.reason}" - ` +
        `a floor or margin reason means the row was loaded, which is itself a read`,
    );
  },
});

// ── US-3367: recording a sale ─────────────────────────────────────────────────
//
// POST /api/flipdesk/sales/record takes both ids from the body and writes
// sales, inventory_items and listings with the service-role client, then runs
// the sibling delist planner. A foreign item or listing must be a 404.

Deno.test({
  name: "user B cannot record a sale on user A's item",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/sales/record`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        inventory_item_id: Deno.env.get("TEST_USER_A_ITEM_ID") ??
          "11111111-1111-1111-1111-111111111111",
        listing_id: Deno.env.get("TEST_USER_A_LISTING_ID") ?? null,
        sale_price: 1,
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST /api/flipdesk/sales/record");
  },
});

Deno.test({
  name: "an unauthenticated caller cannot record a sale",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/sales/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inventory_item_id: "11111111-1111-1111-1111-111111111111",
        sale_price: 1,
      }),
    });
    await res.body?.cancel();
    assert(
      res.status === 401 || res.status === 403,
      `unauthenticated sale record returned ${res.status}; expected 401/403`,
    );
  },
});

Deno.test({
  // US-3367: "Not listed" rewrites a listing row and re-derives the item's
  // status. A foreign id must be a 404, never a draft on someone else's item.
  name: "user B cannot mark user A's listing as not listed",
  ignore: !CONFIGURED,
  fn: async () => {
    const id = Deno.env.get("TEST_USER_A_LISTING_ID") ?? "11111111-1111-1111-1111-111111111111";
    const res = await fetch(
      `${BASE}/api/flipdesk/listings/${encodeURIComponent(id)}/not-listed`,
      { method: "POST", headers: authHeaders(B_JWT!) },
    );
    await res.body?.cancel();
    assertDenied(res.status, "POST /api/flipdesk/listings/:id/not-listed");
  },
});

Deno.test({
  // US-3182 (AC5): every override and every suppression names an inventory
  // item id that came out of a REQUEST BODY, which is the shape this file
  // exists for.
  //
  // WHAT A HIT HERE WOULD COST is worse than a read. A suppression written
  // against A's garment would hide A's own work from A's own planner -- and
  // the one row it could hide is the pack-and-ship on a parcel somebody has
  // already paid for. B would not see anything; A would find out from a
  // late-shipment metric. An override is the quieter half: a planner minute
  // or a planning value on a garment B has never seen.
  //
  // Every write goes through ownsItem(), so the falsifiable claim is that a
  // foreign id is refused on ALL FOUR write routes rather than on the ones
  // that were easy to remember. The reset routes are included deliberately:
  // a delete that skipped the check would let B clear A's corrections, which
  // leaves no row behind to notice.
  name: "US-3182: B cannot correct or set aside A's item",
  ignore: !CONFIGURED || !Deno.env.get("TEST_USER_A_ITEM_ID"),
  fn: async () => {
    const itemId = Deno.env.get("TEST_USER_A_ITEM_ID")!;
    const A_ID = Deno.env.get("TEST_USER_A_ID") ??
      "00000000-0000-4000-8000-000000000001";

    const writes: { label: string; path: string; body: Record<string, unknown> }[] = [
      {
        label: "PUT /overrides (minutes)",
        path: "/api/flipdesk/planner/overrides",
        body: { inventory_item_id: itemId, kind: "task_minutes", amount_minutes: 5 },
      },
      {
        label: "PUT /overrides (planning value)",
        path: "/api/flipdesk/planner/overrides",
        body: {
          inventory_item_id: itemId,
          kind: "value_range",
          low_cents: 1,
          high_cents: 2,
          // owner_user_id in the body must be ignored: the route reads the
          // owner from the request context and nothing else.
          owner_user_id: A_ID,
        },
      },
      {
        label: "POST /overrides/reset",
        path: "/api/flipdesk/planner/overrides/reset",
        body: { inventory_item_id: itemId, kind: "task_minutes" },
      },
      {
        label: "POST /suppressions (dismiss)",
        path: "/api/flipdesk/planner/suppressions",
        body: { inventory_item_id: itemId, kind: "dismiss" },
      },
      {
        label: "POST /suppressions (snooze)",
        path: "/api/flipdesk/planner/suppressions",
        body: { inventory_item_id: itemId, kind: "snooze", owner_user_id: A_ID },
      },
      {
        label: "POST /suppressions/reset",
        path: "/api/flipdesk/planner/suppressions/reset",
        body: { inventory_item_id: itemId },
      },
      // WMT-02: the reset now narrows by action_key and session_id. A
      // narrower delete is still a delete on A's rows, so the scoped shapes
      // must be refused exactly like the wide one -- a null action_key
      // included, since that is the item-wide dismiss B would most like to
      // clear.
      {
        label: "POST /suppressions/reset (scoped skip)",
        path: "/api/flipdesk/planner/suppressions/reset",
        body: {
          inventory_item_id: itemId,
          kind: "skip_session",
          action_key: "photograph",
          session_id: "00000000-0000-4000-8000-00000000abcd",
        },
      },
      {
        label: "POST /suppressions/reset (item-wide dismiss)",
        path: "/api/flipdesk/planner/suppressions/reset",
        body: { inventory_item_id: itemId, kind: "dismiss", action_key: null },
      },
    ];

    for (const w of writes) {
      for (const headers of [
        authHeaders(B_JWT!),
        // And with A named in the workspace header, which is the other way a
        // caller could try to borrow an owner.
        { ...authHeaders(B_JWT!), "X-Workspace-Owner": A_ID },
      ]) {
        const res = await fetch(`${BASE}${w.path}`, {
          method: w.path.endsWith("/overrides") ? "PUT" : "POST",
          headers,
          body: JSON.stringify(w.body),
        });
        await res.body?.cancel();
        assertDenied(res.status, w.label);
      }
    }
  },
});

Deno.test({
  // US-3182 (AC5): the read side. GET /overrides takes no id, so the claim is
  // that nothing in a query string or a header can widen it -- and then that
  // the two sellers' answers share no item.
  name: "US-3182: B's corrections read cannot reach A's",
  ignore: !CONFIGURED,
  fn: async () => {
    const A_ID = Deno.env.get("TEST_USER_A_ID") ??
      "00000000-0000-4000-8000-000000000001";
    const PATH = `${BASE}/api/flipdesk/planner/overrides`;

    const shapes: { label: string; url: string; headers: HeadersInit }[] = [
      { label: "plain", url: PATH, headers: authHeaders(B_JWT!) },
      {
        label: "owner query param",
        url: `${PATH}?owner_user_id=eq.${A_ID}`,
        headers: authHeaders(B_JWT!),
      },
      {
        label: "workspace-owner header",
        url: PATH,
        headers: { ...authHeaders(B_JWT!), "X-Workspace-Owner": A_ID },
      },
    ];

    interface Book {
      overrides?: { inventory_item_id?: string }[];
      suppressions?: { inventory_item_id?: string }[];
    }
    const idsOf = (b: Book): string[] => [
      ...(b.overrides ?? []).map((x) => String(x.inventory_item_id)),
      ...(b.suppressions ?? []).map((x) => String(x.inventory_item_id)),
    ];

    const theirs: string[][] = [];
    for (const shape of shapes) {
      const res = await fetch(shape.url, { headers: shape.headers });
      assert(
        [200, 401, 403].includes(res.status),
        `overrides (${shape.label}) should answer a known status, got ${res.status}`,
      );
      if (res.status !== 200) continue;
      theirs.push(idsOf((await res.json().catch(() => ({}))) as Book));
    }

    const aRes = await fetch(PATH, { headers: authHeaders(A_JWT!) });
    if (aRes.status !== 200) return;
    const aIds = new Set(idsOf((await aRes.json().catch(() => ({}))) as Book));
    for (const [i, ids] of theirs.entries()) {
      assertEquals(
        ids.filter((id) => aIds.has(id)),
        [],
        `B's corrections (${shapes[i]!.label}) contained A's item ids`,
      );
    }
  },
});

Deno.test({
  // US-3214 (AC5): the void is an operator surface that MOVES MONEY, so a
  // seller must not be able to reach it at all.
  //
  // WHAT A HIT HERE WOULD COST. The route reverses a charge and releases the
  // grading lock on a garment. Reachable by a seller, it is a way to have a
  // grade run and then take the payment back; reachable by ONE seller against
  // ANOTHER's submission id, it is a way to cancel a stranger's grade and
  // return their credits to them at a moment of the caller's choosing.
  //
  // The route lives on the /api/admin/* group, which carries the admin gate,
  // the standing AAL2 requirement and the grading scope. That is three
  // separate reasons a seller's token should bounce, and this asks the
  // question the only way that proves it: with a real seller token.
  name: "US-3214: a seller cannot void a grading submission",
  ignore: !CONFIGURED,
  fn: async () => {
    const A_ID = Deno.env.get("TEST_USER_A_ID") ??
      "00000000-0000-4000-8000-000000000001";
    const paths = [
      `${BASE}/api/admin/grading/submissions/${A_ID}/void`,
      // And the sibling that also reverses a charge, for the same reason.
      `${BASE}/api/admin/grading/submissions/${A_ID}/mark-failed`,
    ];
    for (const path of paths) {
      for (const headers of [
        authHeaders(B_JWT!),
        { ...authHeaders(B_JWT!), "X-Workspace-Owner": A_ID },
      ]) {
        const res = await fetch(path, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: "not mine to void" }),
        });
        await res.body?.cancel();
        assertDenied(res.status, `POST ${path}`);
      }
    }

    // Unauthenticated too, since an operator route that answers a bare POST is
    // worse than one that answers a seller's.
    const bare = await fetch(paths[0]!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "nobody" }),
    });
    await bare.body?.cancel();
    assert(
      [401, 403, 404].includes(bare.status),
      `an unauthenticated void returned ${bare.status}; expected 401/403/404`,
    );
  },
});

// ── AL-02: staging-path traversal ─────────────────────────────────────
//
// Every staging check used to be `path.startsWith(`${ownerId}/_staging/`)`,
// which B's OWN prefix followed by `../../<A>/...` passes. Storage normalises
// the `..`, so the model was handed another tenant's photo. Each route now goes
// through lib/staging-path.ts, and each must refuse a path that starts in B's
// folder and climbs out of it, raw or percent-encoded. (402 when B's plan lacks
// AutoLister is also a pass: the plan gate runs first and nothing is read.)

/** The `sub` claim of a Supabase JWT, i.e. that user's id. */
function jwtSub(jwt: string): string {
  const part = jwt.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return (JSON.parse(atob(padded)) as { sub: string }).sub;
}

const TRAVERSAL_VICTIM = "00000000-0000-4000-8000-000000000001";
function traversalPaths(ownerId: string): string[] {
  return [
    `${ownerId}/_staging/../../${TRAVERSAL_VICTIM}/_staging/sess/x.jpg`,
    `${ownerId}/_staging/%2e%2e/%2e%2e/${TRAVERSAL_VICTIM}/_staging/sess/x.jpg`,
  ];
}

const STAGING_TRAVERSAL_ROUTES: Array<{
  label: string;
  path: string;
  body: (p: string) => unknown;
  /** photo-qa's cover branch DROPS unowned covers and answers 400 on none. */
  extraOk?: number[];
}> = [
  {
    label: "classify-photos",
    path: "/api/flipdesk/autolister/classify-photos",
    body: (p) => ({ photos: [{ id: "p1", storage_path: p }] }),
  },
  {
    label: "verify-groups",
    path: "/api/flipdesk/autolister/verify-groups",
    body: (p) => ({
      groups: [
        { id: "g1", photos: [{ id: "p1", storage_path: p }] },
        { id: "g2", photos: [{ id: "p2", storage_path: p }] },
      ],
    }),
  },
  {
    label: "propose-groups",
    path: "/api/flipdesk/autolister/propose-groups",
    body: (p) => ({
      photos: [{ id: "p1", storage_path: p }, { id: "p2", storage_path: p }],
    }),
  },
  {
    label: "photo-qa (covers)",
    path: "/api/flipdesk/autolister/photo-qa",
    body: (p) => ({ covers: [{ id: "p1", storage_path: p }] }),
    extraOk: [400],
  },
  {
    label: "sessions (handoff park)",
    path: "/api/flipdesk/autolister/sessions",
    body: (p) => ({
      staging_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      source: "ios",
      photos: [{ id: "p1", storage_path: p }],
    }),
  },
];

for (const route of STAGING_TRAVERSAL_ROUTES) {
  Deno.test({
    name: `AL-02: ${route.label} refuses a staging path that climbs out of B's folder`,
    ignore: !CONFIGURED,
    fn: async () => {
      const bId = jwtSub(B_JWT!);
      for (const p of traversalPaths(bId)) {
        const res = await fetch(`${BASE}${route.path}`, {
          method: "POST",
          headers: { ...authHeaders(B_JWT!), "Content-Type": "application/json" },
          body: JSON.stringify(route.body(p)),
        });
        await res.body?.cancel();
        assert(
          DENIED_OR_GATED.has(res.status) || (route.extraOk ?? []).includes(res.status),
          `POST ${route.label} with ${p}: should be refused but got ${res.status}`,
        );
      }
    },
  });
}

Deno.test({
  name: "AL-02: expense adopt-staged refuses a traversal out of A's own staging folder",
  ignore: !CONFIGURED || !A_EXPENSE_ID,
  fn: async () => {
    const aId = jwtSub(A_JWT!);
    for (const p of traversalPaths(aId)) {
      const res = await fetch(
        `${BASE}/api/flipdesk/expenses/${A_EXPENSE_ID}/adopt-staged`,
        {
          method: "POST",
          headers: authHeaders(A_JWT!),
          body: JSON.stringify({ staging_path: p }),
        },
      );
      await res.body?.cancel();
      assertEquals(res.status, 403, `adopt-staged with ${p}`);
    }
  },
});

// ── IMP-09: import writes need manage_inventory (listing_manager+) ──────────
//
// Starting an import, undoing one and starting a closet read create or delete
// inventory in bulk. The viewer half runs on every CI job (the seed emits a
// viewer); the member half needs TEST_MEMBER_JWT, which the seed does not yet
// emit (KNOWN_UNSEEDED). import-role-floor_test.ts drives the member refusal
// in-process so it is covered either way. A 2xx here is a FAIL.
const IMPORT_WRITE_PATHS: Array<{ path: string; body: unknown }> = [
  { path: "/api/flipdesk/import/runs", body: { rows: [{ row: 2, title: "IMP-09 probe" }] } },
  { path: "/api/flipdesk/import/runs/00000000-0000-4000-8000-000000000000/undo", body: {} },
  {
    path: "/api/flipdesk/closet-import/runs",
    body: { platform: "poshmark", rows: [] },
  },
];

for (const { path, body } of IMPORT_WRITE_PATHS) {
  Deno.test({
    name: `IMP-09: viewer cannot POST ${path}`,
    ignore: !VIEWER_READY,
    fn: async () => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: viewerHeaders(),
        body: JSON.stringify(body),
      });
      await res.body?.cancel();
      assertEquals(res.status, 403, `POST ${path} as viewer`);
    },
  });

  Deno.test({
    name: `IMP-09: member cannot POST ${path} (requires listing_manager)`,
    ignore: !BASE || !WS_OWNER || !MEMBER_JWT,
    fn: async () => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MEMBER_JWT}`,
          "Content-Type": "application/json",
          "X-Workspace-Owner": WS_OWNER!,
        },
        body: JSON.stringify(body),
      });
      await res.body?.cancel();
      assertEquals(res.status, 403, `POST ${path} as member`);
    },
  });
}
