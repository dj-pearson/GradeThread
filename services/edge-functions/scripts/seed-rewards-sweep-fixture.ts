// US-2971 AC3: seed the pipeline-XP sweep fixture.
//
// src/tests/rewards-pipeline-idempotency_test.ts is the one assertion in this
// story that a pure test cannot make. The planner dropping already-granted
// marks is covered in-process, and migration 00417's UNIQUE
// uq_reputation_event_ref makes a duplicate emit a database no-op. Neither is
// the same claim as "running the sweep twice leaves the reputation_events row
// count identical", which is what a backfill re-run actually does. That claim
// needs rows.
//
// The test had no seed and no workflow, so it skipped everywhere and its cases
// had never executed. scripts/integration-lane-coverage.test.mjs caught exactly
// that and was failing on main.
//
// WHY ITS OWN USER RATHER THAN ONE OF THE MONEY-CERT USERS. The sweep GRANTS
// XP, and it grants it for every stage of every item the user owns. Sharing a
// row with ledger-consistency (which drives a balance to zero with 40 parallel
// debits) or with credit-refund (which asserts on a delta it measured at test
// start) would make both order-dependent on a suite that touches neither
// balance. A separate user costs one insert.
//
// The item deliberately carries evidence for SIX of the seven stages, so a
// first sweep has real work to do and a second sweep has a real chance to
// double-grant. The seventh (item_sold) is left off on purpose: a sales row
// changes the money surfaces, and this fixture has no business being visible
// to them.
//
// Any failure here is fatal (exit 1). A fixture that cannot be built must fail
// the job rather than let the suite fall back to a silent skip, which is the
// whole defect this file exists to close.
//
// Required env:
//   SUPABASE_URL                e.g. http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY   local service-role key (supabase status)
//
// Run:  deno run --allow-net --allow-env scripts/seed-rewards-sweep-fixture.ts
//
// Prints `KEY=VALUE` on stdout for the workflow to append to $GITHUB_ENV; all
// progress goes to stderr, so a `2>&1` here would poison the env file with
// lines that are not KEY=VALUE.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "[seed-sweep] Missing env. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
  );
  Deno.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SWEEP_EMAIL = "sweep@rewards-pipeline.test";
const PASSWORD = "Rewards-Sweep-Fixture-1!";

function log(msg: string): void {
  console.error(`[seed-sweep] ${msg}`);
}

function die(msg: string): never {
  console.error(`[seed-sweep] FATAL: ${msg}`);
  Deno.exit(1);
}

async function findUserByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) die(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureUser(email: string): Promise<string> {
  const existing = await findUserByEmail(email);
  if (existing) {
    log(`user exists: ${email} (${existing})`);
    return existing;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) die(`createUser(${email}) failed: ${error?.message ?? "no user"}`);
  log(`user created: ${email} (${data.user.id})`);
  return data.user.id;
}

/**
 * Put the sweep user back to a state where a first sweep has work to do.
 *
 * The suite is destructive by construction — it grants XP and leaves the events
 * behind — so a re-run against a swept user would report marksGranted 0 on the
 * FIRST sweep and the idempotency assertion would pass without ever exercising
 * the path it exists to check. Clearing the pipeline events is what makes the
 * fixture re-runnable; it is not tidiness.
 */
async function resetPipelineEvents(userId: string): Promise<void> {
  const { error } = await admin
    .from("reputation_events")
    .delete()
    .eq("user_id", userId)
    .in("event_type", [
      "item_cataloged",
      "item_measured",
      "item_photographed",
      "item_comped",
      "item_drafted",
      "item_listed",
      "item_sold",
    ]);
  if (error) die(`clearing prior pipeline events failed: ${error.message}`);
  log("prior pipeline events cleared");
}

async function ensureItem(userId: string): Promise<string> {
  const sku = "SWEEP-FIXTURE-1";
  const { data: found, error: findErr } = await admin
    .from("inventory_items")
    .select("id")
    .eq("user_id", userId)
    .eq("sku", sku)
    .limit(1);
  if (findErr) die(`inventory lookup failed: ${findErr.message}`);
  if (found && found.length > 0) {
    const id = (found[0] as { id: string }).id;
    log(`item exists: ${sku} (${id})`);
    return id;
  }

  const { data, error } = await admin
    .from("inventory_items")
    .insert({
      user_id: userId,
      sku,
      title: "Sweep fixture jacket",
      // item_cataloged needs an identifying field that is not title — title is
      // NOT NULL, so deriving the stage from it would make every row qualify.
      brand: "Fixture Brand",
      garment_type: "outerwear",
      // item_measured reads the measurements JSON, not a count of columns.
      measurements: { chest: 21, length: 27 },
      status: "cataloged",
      // item_comped takes either a repricing row or this timestamp.
      comped_at: new Date("2026-01-05T00:00:00Z").toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) die(`item insert failed: ${error?.message ?? "no row"}`);
  const id = (data as { id: string }).id;
  log(`item created: ${sku} (${id})`);
  return id;
}

async function ensurePhoto(userId: string, itemId: string): Promise<void> {
  const { data, error: findErr } = await admin
    .from("item_photos")
    .select("id")
    .eq("inventory_item_id", itemId)
    .limit(1);
  if (findErr) die(`photo lookup failed: ${findErr.message}`);
  if (data && data.length > 0) {
    log("photo exists");
    return;
  }
  // NOTE: item_photos has no user_id column. Ownership runs through
  // inventory_item_id, which is exactly why the sweep loads photos with
  // .in("inventory_item_id", <already owner-scoped ids>) rather than by user.
  const { error } = await admin.from("item_photos").insert({
    inventory_item_id: itemId,
    photo_url: "https://example.invalid/sweep-fixture/front.jpg",
    storage_path: `${userId}/sweep-fixture/front.jpg`,
    photo_type: "front",
    sort_order: 0,
  });
  if (error) die(`photo insert failed: ${error.message}`);
  log("photo created");
}

async function ensureListing(itemId: string): Promise<void> {
  const { data, error: findErr } = await admin
    .from("listings")
    .select("id")
    .eq("inventory_item_id", itemId)
    .limit(1);
  if (findErr) die(`listing lookup failed: ${findErr.message}`);
  if (data && data.length > 0) {
    log("listing exists");
    return;
  }
  const { error } = await admin.from("listings").insert({
    inventory_item_id: itemId,
    platform: "ebay",
    listing_price: 48,
    listing_status: "active",
    is_active: true,
    // item_listed is derived from platform_listing_id, NOT from listed_at:
    // listings.listed_at is NOT NULL DEFAULT now() and so is populated on
    // drafts too. Setting it is what separates listed from merely drafted.
    platform_listing_id: "SWEEP-FIXTURE-LISTING-1",
    listed_at: new Date("2026-01-10T00:00:00Z").toISOString(),
  });
  if (error) die(`listing insert failed: ${error.message}`);
  log("listing created");
}

const userId = await ensureUser(SWEEP_EMAIL);
const itemId = await ensureItem(userId);
await ensurePhoto(userId, itemId);
await ensureListing(itemId);
await resetPipelineEvents(userId);

log("fixture ready");
console.log(`TEST_SWEEP_USER_ID=${userId}`);
console.log(`TEST_SWEEP_ITEM_ID=${itemId}`);
