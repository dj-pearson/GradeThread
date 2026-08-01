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

async function ensureUser(email: string): Promise<string> {
  const existing = await findUserByEmail(email);
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) die(`updateUserById(${email}) failed: ${error.message}`);
    log(`user exists: ${email} (${existing})`);
    return existing;
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
    title: "Tenant-A fixture jacket",
    brand: "FixtureBrand",
  });
  out.TEST_USER_A_ITEM_ID = itemId;

  const listingId = await insert("listings", {
    inventory_item_id: itemId,
    platform: "ebay",
    listing_price: 42.0,
    listing_title: "Tenant-A fixture listing",
    listing_status: "active",
  });
  out.TEST_USER_A_LISTING_ID = listingId;

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

  out.TEST_USER_A_API_KEY_ID = await insert("api_keys", {
    user_id: aId,
    name: "fixture key",
    key_hash: "fixture-hash-not-a-real-key",
    key_prefix: "gt_fixt",
  });

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

  // US-600: consignment mode.
  out.TEST_USER_A_CONSIGNOR_ID = await insert("consignors", {
    user_id: aId,
    name: "Tenant-A consignor",
    default_split_pct: 50,
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
