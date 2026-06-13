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
// For the AutoLister batch-enqueue test, user B should ideally be on a plan
// that includes AutoLister so the OWNERSHIP path is exercised; if B is on a
// free/starter plan the request is denied earlier with 402 (still a pass —
// B never touches A's items).
//
// Run:  deno task test   (or: deno test --allow-net --allow-env)

import { assert } from "@std/assert";

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
// when their id env var is unset). Keep in sync with the seed script.
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
];

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
    const body = (await listForA.json()) as { keys?: Array<{ id: string }> };
    const stillThere = (body.keys ?? []).some((k) => k.id === id);
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
    // Item isn't owned by B → the publish-context assembly can't find it.
    // 422 (unprocessable/blockers) is also acceptable: it did NOT publish.
    assert(
      DENIED.has(status) || status === 422,
      `POST listings/push for another tenant's item should be denied ` +
        `(401/403/404/422) but got ${status}`,
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
    await res.body?.cancel();
    assertDenied(res.status, "POST reconciliation/dismiss (A's payout)");
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
    const body = (await res.json().catch(() => ({}))) as {
      resolved?: number;
      failed?: Array<{ conflict_id: string }>;
    };
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
