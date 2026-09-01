// US-350: seed a two-tenant fixture for the tenant-isolation regression suite.
//
// tenant-isolation_test.ts drives a RUNNING edge service with two real Supabase
// user sessions and a set of resource ids OWNED BY user A. Historically that
// fixture only existed on a developer's machine, so the suite SKIPped in CI and
// a missing `.eq("user_id", …)` scoping could ship silently (US-268).
//
// This script builds that fixture against a LOCAL, throwaway Supabase stack
// (the one `supabase start` boots in CI — never production). It:
//   1. creates two confirmed users, A (victim) and B (attacker), idempotently;
//   2. mints an access-token JWT for each via password sign-in;
//   3. seeds the resources A owns (inventory item, listing, sync run, reconcile
//      session, payout import, sync conflict, api key, template, repricing rule,
//      generation batch, grading submission, consignor);
//   4. prints `KEY=VALUE` lines on stdout for the workflow to append to
//      $GITHUB_ENV, so `deno test` runs the suite for real with
//      TENANT_ISOLATION_REQUIRED=1.
//
// Any failure here is fatal (exit 1) — a fixture that can't be built must fail
// the CI job, never let the suite silently SKIP.
//
// Required env:
//   SUPABASE_URL                e.g. http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY   local service-role key (supabase status)
//   SUPABASE_ANON_KEY           local anon key (for the password sign-in)
//
// Run:  deno run --allow-net --allow-env scripts/seed-tenant-isolation-fixture.ts

import { createClient } from "@supabase/supabase-js";
// US-9107: the SAME generator the product uses, so key_hash matches what the
// edge computes on every request. NOTE: hashApiKey reads API_KEY_PEPPER at
// call time, so the seeder and the edge service must run with the same value
// (they do in the local recipe and in CI, where neither sets one).
import { generateApiKey } from "../src/lib/api-key.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error(
    "[seed] Missing env. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
      "SUPABASE_ANON_KEY",
  );
  Deno.exit(1);
}

// ── LOCAL ONLY, ENFORCED (added 2026-08-16) ──────────────────────────────
//
// Every comment in this file said "never production" and NOTHING checked. That
// was survivable while `ensureUser` merely reset a password on an existing row.
// It stopped being survivable the moment the same function started DELETING the
// user to make the fixture re-runnable, because deleting an auth user cascades
// through their data — so a mistyped SUPABASE_URL would erase real accounts
// rather than inconvenience them.
//
// Not overridable by a flag. A flag would get used, and the whole value of this
// check is that it holds on the day someone is pasting env vars in a hurry.
{
  const host = new URL(SUPABASE_URL).hostname;
  const isLocal = host === "127.0.0.1" || host === "localhost" ||
    host === "0.0.0.0" || host === "::1" || host === "[::1]";
  if (!isLocal) {
    console.error(
      `[seed] REFUSING to run against ${host}. This script DELETES and ` +
        "re-creates its fixture users, which cascades through their rows. It " +
        "is for the throwaway `supabase start` stack only.",
    );
    Deno.exit(1);
  }
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Deterministic creds — the local stack is throwaway, so fixed values keep the
// seed idempotent across re-runs.
const PASSWORD = "Tenant-Isolation-Fixture-1!";
const A_EMAIL = "tenant-a@tenant-isolation.test";
const B_EMAIL = "tenant-b@tenant-isolation.test";
// US-2039: a read-only VIEWER inside A's workspace. Distinct from B, who is a
// FOREIGN tenant — the two prove different things. B tests cross-tenant
// isolation ("you cannot touch another account's data"); V tests INTRA-workspace
// role enforcement ("you are legitimately inside this workspace but may not
// spend its money"). Seven tenant-isolation cases, including
// "viewer cannot pay for a grade (drains owner credits)", skipped silently
// because this user was never seeded.
const V_EMAIL = "tenant-viewer@tenant-isolation.test";

const out: Record<string, string> = {};

function log(msg: string): void {
  // Diagnostics go to stderr so stdout carries ONLY KEY=VALUE lines.
  console.error(`[seed] ${msg}`);
}

function die(msg: string): never {
  console.error(`[seed] FATAL: ${msg}`);
  Deno.exit(1);
}

async function findUserByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) die(`listUsers failed: ${error.message}`);
    const hit = data.users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

/**
 * Make the fixture genuinely re-runnable by starting the two tenants from
 * nothing (fixed 2026-08-16).
 *
 * REUSING THE USER WAS NOT ENOUGH, and the failures were a queue rather than
 * one bug. A second run against any stack died at `api_keys` on
 * `idx_api_keys_key_hash`, and with that fixed, immediately again at
 * `listing_templates` on `listing_templates_user_id_name_key` — every fixture
 * row this file inserts under a fixed human-readable name is one more unique
 * constraint waiting. Fixing them one at a time is a queue with no end, and
 * each failure leaves a HALF-BUILT fixture behind, which is worse than
 * refusing: the suite then runs against a partial tenant and the errors point
 * anywhere but here.
 *
 * Nobody noticed because every CI lane run starts from `supabase start`. A
 * fixture that works exactly once looks identical to a fixture that works.
 *
 * DELETING THE AUTH USER is the reset, not a per-table cleanup: the fixture's
 * rows hang off the tenant by foreign key, so removing the user removes them,
 * and there is no list of tables to keep in step with the inserts below. Only
 * the two `@tenant-isolation.test` addresses are ever touched, and this script
 * refuses a non-local SUPABASE_URL (the guard above, added with this change
 * because the comments claiming it were not enforcement).
 */
async function ensureUser(email: string): Promise<string> {
  const existing = await findUserByEmail(email);
  if (existing) {
    const { error: delErr } = await admin.auth.admin.deleteUser(existing);
    if (delErr) die(`reset ${email} failed: ${delErr.message}`);
    log(`user reset: ${email} (${existing} deleted, re-creating)`);
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    die(`createUser(${email}) failed: ${error?.message ?? "no user"}`);
  }
  log(`user created: ${email} (${data.user.id})`);
  return data.user.id;
}

async function mintJwt(email: string): Promise<string> {
  const anon = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // config.toml enables [auth.captcha] (turnstile), so the local GoTrue rejects
  // any sign-in WITHOUT a captcha token. Send one — it's harmless when captcha is
  // off (GoTrue ignores it), and validated by the Turnstile ALWAYS-PASSES test
  // secret the CI job sets (SUPABASE_AUTH_CAPTCHA_SECRET=1x000…AA), under which
  // any non-empty token passes. Override via SEED_CAPTCHA_TOKEN if needed.
  const captchaToken =
    Deno.env.get("SEED_CAPTCHA_TOKEN") ?? "ci-seed-dummy-captcha-token";
  const { data, error } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
    options: { captchaToken },
  });
  if (error || !data.session?.access_token) {
    die(`signIn(${email}) failed: ${error?.message ?? "no session"}`);
  }
  return data.session.access_token;
}

// Insert a row and return its id; fatal on error (so a schema drift fails CI).
async function insert(
  table: string,
  row: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    die(`insert into ${table} failed: ${error?.message ?? "no row"}`);
  }
  return (data as { id: string }).id;
}

async function main(): Promise<void> {
  const aId = await ensureUser(A_EMAIL);
  const bId = await ensureUser(B_EMAIL);
  const vId = await ensureUser(V_EMAIL);

  // US-9112: both tenants need a plan whose gateFlags include apiAccess,
  // or every /api/v1 and /mcp case in the suite is answered by the PLAN
  // GATE rather than by the handler - and a cross-tenant assertion against
  // a 403 passes without proving anything. This bit exactly that way: ten
  // MCP tool cases reported green against a surface they never reached.
  for (const id of [aId, bId]) {
    const { error } = await admin.from("users").update({
      flipdesk_plan: "business",
      subscription_status: "active",
    }).eq("id", id);
    if (error) die(`plan setup for ${id} failed: ${error.message}`);
  }
  log("plan: A and B set to business (apiAccess) so the API surface is reachable");

  out.TEST_USER_A_JWT = await mintJwt(A_EMAIL);
  out.TEST_USER_B_JWT = await mintJwt(B_EMAIL);

  // US-2039: make V a VIEWER of A's workspace. Upsert on the (owner_id,
  // member_id) unique constraint so re-running the seed is idempotent and a
  // role changed by a previous run is reset rather than duplicated.
  {
    const { error } = await admin
      .from("workspace_members")
      .upsert(
        { owner_id: aId, member_id: vId, role: "viewer", invited_by: aId },
        { onConflict: "owner_id,member_id" },
      );
    if (error) die(`seed workspace_members(viewer) failed: ${error.message}`);
    log(`viewer membership: ${V_EMAIL} -> owner ${aId} (role=viewer)`);
  }
  out.TEST_VIEWER_JWT = await mintJwt(V_EMAIL);
  // The X-Workspace-Owner value the viewer acts under — A's id.
  out.TEST_WORKSPACE_OWNER_ID = aId;

  // ── Resources OWNED BY A ────────────────────────────────────────────
  const itemId = await insert("inventory_items", {
    user_id: aId,
    title: "Tenant-A-fixture-jacket",
    brand: "FixtureBrand",
  });
  out.TEST_USER_A_ITEM_ID = itemId;
  // NOTE: no spaces in the value. The script prints bare KEY=VALUE lines for
  // $GITHUB_ENV, which takes them raw - so quoting here would put literal quotes
  // in the value in CI, while NOT quoting makes a local `. seed.env` split the
  // line and silently leave the variable unset. A space-free value works in both.
  // US-9112: a denial case cannot assert on the id, because a handler that
  // correctly refuses still echoes the id the CALLER supplied. A's data is
  // what must not appear, so the title is exported to match against.
  out.TEST_USER_A_ITEM_TITLE = "Tenant-A-fixture-jacket";

  const listingId = await insert("listings", {
    inventory_item_id: itemId,
    platform: "ebay",
    listing_price: 42.0,
    listing_title: "Tenant-A fixture listing",
    listing_status: "active",
  });
  out.TEST_USER_A_LISTING_ID = listingId;

  // US-2961: a standing line on A's account. The apply-to-drafts route is keyed
  // on the SNIPPET id rather than on a listing, so proving the listing cases
  // hold says nothing about this one — it needs an id of A's to be refused.
  out.TEST_USER_A_SNIPPET_ID = await insert("listing_snippets", {
    user_id: aId,
    name: "Tenant-A-fixture-snippet",
    body: "Ships within one business day.",
  });

  // US-2697: a POSHMARK listing WITH a listing_url, so the sold-sync isolation
  // case can hand B a sold row carrying A's URL and prove it never confirms.
  // The eBay fixture above cannot serve: /api/flipdesk/sync only accepts the
  // extension-mechanism platforms, and it has no listing_url either.
  // No spaces in the value - see the $GITHUB_ENV note above.
  const syncUrl = "https://poshmark.com/listing/tenant-a-sync-fixture";
  const syncListingId = await insert("listings", {
    inventory_item_id: itemId,
    platform: "poshmark",
    listing_price: 55.0,
    listing_title: "Tenant-A-sync-fixture",
    listing_status: "active",
    listing_url: syncUrl,
  });
  out.TEST_USER_A_SYNC_LISTING_ID = syncListingId;
  out.TEST_USER_A_SYNC_LISTING_URL = syncUrl;

  // US-9201: a Poshmark listing of A's WITH a marketplace id, so the closet
  // import isolation case can hand B a batch naming that id and prove B's run
  // creates B's own row instead of touching A's. The id is the dedupe key the
  // worker matches on, and the whole point of the case is that the match is
  // owner-scoped. 24 hex characters, the shape listingIdFromUrl accepts.
  const closetPid = "a1b2c3d4e5f60718293a4b5c";
  await insert("listings", {
    inventory_item_id: itemId,
    platform: "poshmark",
    platform_listing_id: closetPid,
    listing_price: 42.0,
    listing_title: "Tenant-A-closet-fixture",
    listing_status: "active",
    listing_url: `https://poshmark.com/listing/tenant-a-closet-fixture-${closetPid}`,
  });
  out.TEST_USER_A_CLOSET_LISTING_PID = closetPid;

  // US-2395 AC6: a MULTI-VARIATION listing, which the group-revise branch takes
  // a different path for. Deliberately seeded rather than classified as
  // unseeded: it needs nothing external — a listings row with `variations` set,
  // a pinned inventory_sku and NO platform_offer_id is exactly what eBay leaves
  // behind after publish_by_inventory_item_group, and it is a plain insert.
  const variationListingId = await insert("listings", {
    inventory_item_id: itemId,
    platform: "ebay",
    listing_price: 55.0,
    listing_title: "Tenant-A fixture variation listing",
    listing_status: "active",
    // The group is keyed on this, not on the item's current sku (US-1999).
    inventory_sku: "FIXTURE-VAR-A",
    // Published by group, so eBay minted an item id and never an offer id.
    platform_listing_id: "111111111111",
    variations: {
      specifications: ["Size"],
      variants: [
        { aspects: { Size: "M" }, quantity: 1, price_cents: null },
        { aspects: { Size: "L" }, quantity: 2, price_cents: 6500 },
      ],
    },
  });
  out.TEST_USER_A_VARIATION_LISTING_ID = variationListingId;

  out.TEST_USER_A_SYNC_RUN_ID = await insert("flipdesk_sync_runs", {
    user_id: aId,
    marketplace: "ebay",
    status: "success",
  });

  out.TEST_USER_A_RECONCILE_SESSION = await insert(
    "flipdesk_reconcile_sessions",
    { user_id: aId, photo_count: 0 },
  );

  out.TEST_USER_A_PAYOUT_ID = await insert("payout_imports", {
    user_id: aId,
    marketplace: "ebay",
    import_method: "csv_upload",
    raw_payload: { order_id: "fixture-A", amount: 42 },
    reconciled: false,
  });

  out.TEST_USER_A_CONFLICT_ID = await insert("flipdesk_sync_conflicts", {
    user_id: aId,
    listing_id: listingId,
    field_name: "price",
    flipdesk_value: "42.00",
    ebay_value: "40.00",
  });

  // ── PER-RUN HASH (fixed 2026-08-16) ─────────────────────────────────
  //
  // This was the literal string "fixture-hash-not-a-real-key", and
  // idx_api_keys_key_hash is UNIQUE — so the SECOND run of this seeder against
  // any stack died with `duplicate key value violates unique constraint`. Every
  // other step in this file already tolerates a re-run (it logs "user exists"
  // and reuses the row), so the intent was always re-runnability; this one
  // insert did not honour it.
  //
  // It never surfaced because each CI lane run starts from `supabase start`.
  // Same shape as the money fixture's ledger delete, arriving through a
  // different door: a fixture that works exactly once looks identical to a
  // fixture that works.
  //
  // Per-run rather than an upsert on the hash: the tests only need A to OWN a
  // key, not a specific one, and a stable hash across runs would let a stale
  // row from an earlier run satisfy a later assertion.
  // US-9107: REAL keys now, not a placeholder hash.
  //
  // The old row carried a fake hash, which was fine while the only assertion was
  // "A owns an api_keys row" — but it meant no test could ever AUTHENTICATE as
  // either tenant against /api/v1, so every public-API cross-tenant path was
  // unverified and TEST_USER_B_API_KEY sat in KNOWN_UNSEEDED. generateApiKey()
  // produces the plaintext, its hash and its prefix together, so the row and the
  // emitted key cannot disagree.
  const aKey = await generateApiKey();
  out.TEST_USER_A_API_KEY_ID = await insert("api_keys", {
    user_id: aId,
    name: "fixture key A",
    key_hash: aKey.keyHash,
    key_prefix: aKey.keyPrefix,
  });
  out.TEST_USER_A_API_KEY = aKey.fullKey;

  const bKey = await generateApiKey();
  out.TEST_USER_B_API_KEY_ID = await insert("api_keys", {
    user_id: bId,
    name: "fixture key B",
    key_hash: bKey.keyHash,
    key_prefix: bKey.keyPrefix,
  });
  out.TEST_USER_B_API_KEY = bKey.fullKey;

  out.TEST_USER_A_TEMPLATE_ID = await insert("listing_templates", {
    user_id: aId,
    name: "Tenant-A template",
  });

  out.TEST_USER_A_RULE_ID = await insert("repricing_rules", {
    user_id: aId,
    name: "Tenant-A rule",
    drop_pct: 5,
  });

  out.TEST_USER_A_BATCH_ID = await insert("listing_generation_batches", {
    user_id: aId,
  });

  out.TEST_USER_A_SUBMISSION_ID = await insert(
    "flipdesk_grading_submissions",
    { inventory_item_id: itemId },
  );

  // US-1855's Showcase-consent case gates on a real `submissions` row owned by
  // A. It shipped unseeded, so the one case proving B cannot publish A's private
  // find skipped on every CI run while the suite reported green. A plain
  // uncertified row is enough: the denial comes from the `.eq("user_id", userId)`
  // filter on the consent UPDATE, which does not care about grade state.
  out.TEST_USER_A_GRADE_SUBMISSION_ID = await insert("submissions", {
    user_id: aId,
    garment_type: "tops",
    garment_category: "t-shirt",
    title: "Tenant-A fixture grading submission",
  });

  // US-2670: a grade report owned by A, so the disputes RLS case has a real
  // foreign report id to aim at. Without it that case skips and the policy this
  // story tightened would go unproven on every run.
  out.TEST_USER_A_GRADE_REPORT_ID = await insert("grade_reports", {
    submission_id: out.TEST_USER_A_GRADE_SUBMISSION_ID,
    overall_score: 8.0,
    grade_tier: "Very Good",
    fabric_condition_score: 8.0,
    structural_integrity_score: 8.0,
    cosmetic_appearance_score: 8.0,
    functional_elements_score: 8.0,
    odor_cleanliness_score: 8.0,
    ai_summary: "Tenant-A fixture grade report",
    confidence_score: 0.9,
    model_version: "fixture",
  });

  // US-600: consignment mode.
  out.TEST_USER_A_CONSIGNOR_ID = await insert("consignors", {
    user_id: aId,
    name: "Tenant-A consignor",
    default_split_pct: 50,
  });

  // US-2518: a CSV import run owned by A. Its payload is A's catalog file and
  // its undo deletes inventory, so both the read and the undo need a case. A
  // completed run, because undo refuses one still in flight — otherwise the
  // case would pass on the wrong refusal.
  out.TEST_USER_A_IMPORT_RUN_ID = await insert("flipdesk_import_runs", {
    user_id: aId,
    status: "completed",
    origin: "csv",
    total_rows: 1,
    processed_rows: 1,
  });

  // US-2228: an operating expense owned by A. The receipt routes hang off this
  // row, and a plain insert is enough — the denial comes from the ownership
  // load, which runs before the body is read and does not care whether a
  // receipt is attached.
  out.TEST_USER_A_EXPENSE_ID = await insert("flipdesk_expenses", {
    user_id: aId,
    category: "other",
    amount: 12.34,
  });

  // US-2078: the plain-DB-row resources that gated cross-tenant cases but were
  // never emitted, so 26 cases skipped silently on every CI run. Each is a
  // minimal row OWNED BY A (or scoped to A's item), matching how the route
  // verifies ownership — see tenant-isolation_test.ts for the paired case.

  // A closet entry owned by A (manual source needs no link target).
  out.TEST_USER_A_CLOSET_ITEM_ID = await insert("closet_items", {
    user_id: aId,
    source: "manual",
    title: "Tenant-A fixture closet item",
  });

  // A support chat owned by A (workspace_owner_id = A for a solo seller).
  out.TEST_USER_A_CONVERSATION_ID = await insert("support_conversations", {
    user_id: aId,
    workspace_owner_id: aId,
    subject: "Tenant-A fixture conversation",
  });

  // A support ticket owned by A.
  out.TEST_USER_A_TICKET_ID = await insert("support_tickets", {
    user_id: aId,
    subject: "Tenant-A fixture ticket",
  });

  // A sale, scoped to A via its inventory item. sales DOES carry user_id since
  // 00146, filled by the set_sales_tenant BEFORE trigger from inventory_item_id
  // — so this insert stays correct without naming it, and every handler verifies
  // ownership through inventory_items.user_id.
  out.TEST_USER_A_SALE_ID = await insert("sales", {
    inventory_item_id: itemId,
    sale_price: 42.0,
  });

  // A grading batch owned by A.
  out.TEST_USER_A_GRADING_BATCH_ID = await insert("grading_batches", {
    user_id: aId,
  });

  // A demand-board want owned by A.
  out.TEST_USER_A_WANT_ID = await insert("buyer_wants", {
    user_id: aId,
  });

  // A Garment Passport garment. Ownership is verified by created_by before any
  // event/claim write, so created_by = A is the isolation surface (US-1090/1094).
  out.TEST_USER_A_GARMENT_ID = await insert("garments", {
    created_by: aId,
  });

  // A FlipDesk automation rule owned by A (US-2156). Deliberately is_active
  // false: the cases only need an id B can aim PUT/PATCH/DELETE/dry-run at, and
  // an active rule would be picked up by the hourly fan-out and start acting on
  // the fixture inventory. The trigger/action pair is the cheapest valid one.
  out.TEST_USER_A_AUTOMATION_RULE_ID = await insert("flipdesk_automation_rules", {
    user_id: aId,
    name: "Tenant-A fixture rule",
    trigger_json: { type: "days_listed_gt", days: 30, cooldown_days: 7 },
    action_json: { type: "advance_status", status: "archived" },
    is_active: false,
  });

  // A sourcing location owned by A (US-1864). The personal Radar layer links a
  // source to a shared venue, so this is the id B must never be able to point at
  // a venue of their choosing — a plain insert, hence seeded rather than
  // classified unseeded.
  out.TEST_USER_A_SOURCE_ID = await insert("sources", {
    user_id: aId,
    name: "Tenant-A fixture thrift store",
    source_type: "thrift",
  });

  // A passport owner node linked to A (owner_node_kind 'seller').
  out.TEST_USER_A_PASSPORT_NODE_ID = await insert("owner_nodes", {
    pseudonymous_label: "Tenant-A fixture node",
    kind: "seller",
    linked_user_id: aId,
  });

  log(`seeded fixture for A=${aId} B=${bId}`);

  // Emit KEY=VALUE lines on stdout for $GITHUB_ENV. JWTs are single-line tokens.
  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}=${v}`);
  }
}

await main();
