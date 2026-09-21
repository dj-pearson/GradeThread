#!/usr/bin/env node
// US-3183: the results scorecard, end to end, against a REAL edge service and
// a REAL database.
//
// AC6 names seven cases and every one of them is a way a scorecard reports a
// number that is not true: a garment counted twice because two sessions
// planned it, a cross-listed sale counted twice because two marketplaces
// carried it, a refund still sitting in the win column, a sale whose costs
// were never recorded reported as free money, a rate divided by zero tracked
// minutes, unsold stock quietly dropped, and one seller's work showing in
// another's totals.
//
// None of the seven can be proved by a unit test, because every one of them
// is about rows the READ has to find or not find. So this seeds them, reads
// /api/flipdesk/planner/outcomes over HTTP as each seller, and asserts what
// came back. The arithmetic on top is src/lib/work-scorecard.test.ts; what is
// asserted here is that the route hands the pure layer the right rows.
//
// THE SEED COMMITS AND IS THEN REMOVED. It has to: the HTTP read is a
// different connection, so a transaction that rolls back is invisible to it.
// Cleanup runs first as well as last, so a crashed run does not poison the
// next one.
//
// Usage:
//   node scripts/check-scorecard-e2e.mjs --base http://127.0.0.1:8787 \
//        --token-a <alice jwt> --token-b <mallory jwt> \
//        --user-a <uuid> --user-b <uuid> --dsn postgres://...

import { argv, exit, env } from "node:process";
import { execFileSync } from "node:child_process";

function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = arg("base", "http://127.0.0.1:8787");
const TOKEN_A = arg("token-a");
const TOKEN_B = arg("token-b");
const USER_A = arg("user-a");
const USER_B = arg("user-b");
const DSN = arg("dsn", env.SUPABASE_DB_URL ?? null);

// --seed-only / --cleanup-only exist so the BROWSER spec can use this exact
// fixture rather than defining a second one that drifts from it. Two
// definitions of "a cross-listed garment with two sale rows" is how the
// script and the screen end up testing different things.
const SEED_ONLY = argv.includes("--seed-only");
const CLEANUP_ONLY = argv.includes("--cleanup-only");

if (!DSN) {
  console.error("need --dsn or SUPABASE_DB_URL");
  exit(2);
}
if (!SEED_ONLY && !CLEANUP_ONLY && (!TOKEN_A || !TOKEN_B || !USER_A || !USER_B)) {
  console.error("need --token-a, --token-b, --user-a and --user-b");
  exit(2);
}
if (SEED_ONLY && (!USER_A || !USER_B)) {
  console.error("--seed-only needs --user-a and --user-b");
  exit(2);
}

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function sql(text) {
  return execFileSync("psql", [DSN, "-tA", "-v", "ON_ERROR_STOP=1", "-c", text], {
    encoding: "utf8",
  }).trim();
}

// Every seeded row carries one of these ids, so cleanup is exact rather than
// "delete everything recent".
const S1 = "ccccccc1-0000-4000-8000-000000000001";
const S2 = "ccccccc1-0000-4000-8000-000000000002";
const S3 = "ccccccc1-0000-4000-8000-000000000003";
const SESSIONS = [S1, S2, S3];
const SALE_PREFIX = "ccccccc2-0000-4000-8000-";
const SALES = [1, 2, 3, 4, 5, 6].map((n) => `${SALE_PREFIX}00000000000${n}`);

/**
 * The fixture owns its OWN garments, and that is not tidiness.
 *
 * ⚠ compareOutcomes sums a garment's confirmed minutes across EVERY session
 * that ever touched it, by design (US-3179 AC2). So reusing the shared
 * fixture's items made this script's numbers depend on whatever the browser
 * suite had done to those garments on some earlier afternoon: the hourly
 * figure came out at $58.32 against a hand-computed $86.67, and the
 * difference was 35 minutes a live test had confirmed in September against a
 * garment planned here in January. Own items, own arithmetic.
 */
const ITEMS = {
  jacket: "dddd0001-0000-4000-8000-000000000001",
  fleece: "dddd0002-0000-4000-8000-000000000002",
  jeans: "dddd0003-0000-4000-8000-000000000003",
  synchilla: "dddd0004-0000-4000-8000-000000000004",
  windbreaker: "dddd0005-0000-4000-8000-000000000005",
  overcoat: "dddd0006-0000-4000-8000-000000000006",
  mallorys: "dddd0007-0000-4000-8000-000000000007",
};
const SEEDED_ITEMS = Object.values(ITEMS);

// A fixed month in the past, so the scorecard's date range can be pointed at
// exactly these rows and nothing the browser run left behind.
const PLANNED_AT = "2026-01-15T10:00:00Z";
const SOLD_AT = "2026-01-20T10:00:00Z";

function cleanup() {
  sql(`
    delete from public.flipdesk_work_session_tasks
     where session_id in (${SESSIONS.map((s) => `'${s}'`).join(",")});
    delete from public.flipdesk_work_sessions
     where id in (${SESSIONS.map((s) => `'${s}'`).join(",")});
    delete from public.sales
     where id in (${SALES.map((s) => `'${s}'`).join(",")});
    delete from public.inventory_items
     where id in (${SEEDED_ITEMS.map((i) => `'${i}'`).join(",")});
  `);
}

function seed() {
  const money = (price) =>
    `${price}, 0, 1.00, 0.50, 0, 0, 0`; // sale_price, shipping_collected, platform_fees, payment_processing_fees, shipping_cost, grading_cost, other_costs

  sql(`
    insert into public.inventory_items (id, user_id, title, status, acquired_price)
      values
      ('${ITEMS.jacket}', '${USER_A}', 'Scorecard jacket', 'sold', 22.00),
      ('${ITEMS.fleece}', '${USER_A}', 'Scorecard fleece', 'sold', 4.00),
      -- NO acquisition basis recorded: this is the missing-costs case.
      ('${ITEMS.jeans}', '${USER_A}', 'Scorecard jeans', 'sold', null),
      ('${ITEMS.synchilla}', '${USER_A}', 'Scorecard pullover', 'sold', 18.00),
      ('${ITEMS.windbreaker}', '${USER_A}', 'Scorecard windbreaker', 'sold', 9.00),
      ('${ITEMS.overcoat}', '${USER_A}', 'Scorecard overcoat', 'photographed', 30.00),
      ('${ITEMS.mallorys}', '${USER_B}', 'Scorecard other-seller coat', 'cataloged', 5.00);

    insert into public.flipdesk_work_sessions
      (id, user_id, state, work_context, budget_minutes, created_at)
      values
      ('${S1}', '${USER_A}', 'completed', 'home', 60, '${PLANNED_AT}'),
      ('${S2}', '${USER_A}', 'completed', 'home', 60, '${PLANNED_AT}'),
      ('${S3}', '${USER_B}', 'completed', 'home', 60, '${PLANNED_AT}');

    insert into public.flipdesk_work_session_tasks
      (session_id, user_id, inventory_item_id, item_title_snapshot, position, state,
       action_key, estimate_value_cents, estimate_source, estimate_taken_at,
       confirmed_minutes)
      values
      -- 1. DUPLICATE SESSIONS: one garment planned twice, 30 + 20 minutes.
      ('${S1}', '${USER_A}', '${ITEMS.jacket}', 'Scorecard jacket', 1, 'completed',
       'measure', 4800, 'sold_comp', '${PLANNED_AT}', 30),
      ('${S2}', '${USER_A}', '${ITEMS.jacket}', 'Scorecard jacket', 1, 'completed',
       'photograph', 4800, 'sold_comp', '2026-01-16T10:00:00Z', 20),
      -- 2. CROSS-LISTED: one garment, two sale rows.
      ('${S1}', '${USER_A}', '${ITEMS.fleece}', 'Scorecard fleece', 2, 'completed',
       'photograph', 1500, 'sold_comp', '${PLANNED_AT}', 10),
      -- 3. MISSING COSTS: the jeans have no acquired_price recorded.
      ('${S1}', '${USER_A}', '${ITEMS.jeans}', 'Scorecard jeans', 3, 'completed',
       'measure', 3000, 'active_asking', '${PLANNED_AT}', 15),
      -- 4. REFUND.
      ('${S1}', '${USER_A}', '${ITEMS.synchilla}', 'Scorecard pullover', 4, 'completed',
       'publish', 2500, 'sold_comp', '${PLANNED_AT}', 12),
      -- 5. ZERO MINUTES: sold, with nothing confirmed against it.
      ('${S1}', '${USER_A}', '${ITEMS.windbreaker}', 'Scorecard windbreaker', 5, 'completed',
       'pack_ship', 2000, 'sold_comp', '${PLANNED_AT}', null),
      -- 6. UNSOLD WORK, and one job carried into another evening.
      ('${S2}', '${USER_A}', '${ITEMS.overcoat}', 'Scorecard overcoat', 2, 'completed',
       'measure', 6000, 'seller_estimate', '${PLANNED_AT}', 25),
      ('${S2}', '${USER_A}', '${ITEMS.overcoat}', 'Scorecard overcoat', 3, 'skipped',
       'photograph', 6000, 'seller_estimate', '${PLANNED_AT}', null),
      -- 7. THE OTHER SELLER.
      ('${S3}', '${USER_B}', '${ITEMS.mallorys}', 'Scorecard other-seller coat', 1, 'completed',
       'measure', 7700, 'sold_comp', '${PLANNED_AT}', 40);

    insert into public.sales
      (id, user_id, inventory_item_id, status, sold_at, sale_date,
       sale_price, shipping_collected, platform_fees, payment_processing_fees,
       shipping_cost, grading_cost, other_costs)
      values
      ('${SALES[0]}', '${USER_A}', '${ITEMS.jacket}', 'completed', '${SOLD_AT}', '${SOLD_AT}', ${money("80.00")}),
      -- the cross-post that was withdrawn, and the one that transacted
      ('${SALES[1]}', '${USER_A}', '${ITEMS.fleece}', 'cancelled', '${SOLD_AT}', '${SOLD_AT}', ${money("25.00")}),
      ('${SALES[2]}', '${USER_A}', '${ITEMS.fleece}', 'completed', '${SOLD_AT}', '${SOLD_AT}', ${money("20.00")}),
      ('${SALES[3]}', '${USER_A}', '${ITEMS.jeans}', 'completed', '${SOLD_AT}', '${SOLD_AT}', ${money("45.00")}),
      ('${SALES[4]}', '${USER_A}', '${ITEMS.synchilla}', 'refunded', '${SOLD_AT}', '${SOLD_AT}', ${money("35.00")}),
      ('${SALES[5]}', '${USER_A}', '${ITEMS.windbreaker}', 'completed', '${SOLD_AT}', '${SOLD_AT}', ${money("28.00")});
  `);
}

async function outcomesFor(token) {
  const res = await fetch(`${BASE}/api/flipdesk/planner/outcomes`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 429) {
    console.error(
      "\nSTOPPED: the edge rate-limited this run. That is the limiter working, " +
      "not a failure of the scorecard. Wait and run again.",
    );
    exit(3);
  }
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    console.error(`\nSTOPPED: /outcomes answered ${res.status}: ${JSON.stringify(json)}`);
    exit(3);
  }
  return json;
}

async function main() {
  if (CLEANUP_ONLY) {
    cleanup();
    console.log("scorecard fixture removed");
    return;
  }
  if (SEED_ONLY) {
    cleanup();
    seed();
    console.log(`scorecard fixture seeded (planned ${PLANNED_AT.slice(0, 10)})`);
    return;
  }

  console.log(`scorecard e2e against ${BASE}`);
  cleanup();
  seed();

  try {
    const a = await outcomesFor(TOKEN_A);
    const b = await outcomesFor(TOKEN_B);

    const tasksFor = (book, itemId) =>
      (book.tasks ?? []).filter((t) => t.inventory_item_id === itemId);
    const salesFor = (book, itemId) =>
      (book.sales ?? []).filter((s) => s.inventory_item_id === itemId);

    section("the read finds the work");
    check("it answers with tasks, sales and items", Array.isArray(a.tasks) && Array.isArray(a.sales));
    check("and the server's own clock", typeof a.now === "string" && a.now.length > 10);

    section("1. one garment planned in two sessions");
    const jacketTasks = tasksFor(a, ITEMS.jacket);
    check("both sessions' tasks come back", jacketTasks.length >= 2,
      `got ${jacketTasks.length}`);
    check("they name two different sessions",
      new Set(jacketTasks.map((t) => t.session_id)).size >= 2);
    check("the minutes are on the rows, not summed by the server",
      jacketTasks.some((t) => t.confirmed_minutes === 30) &&
      jacketTasks.some((t) => t.confirmed_minutes === 20));

    section("2. a cross-listed garment with two sale rows");
    const fleeceSales = salesFor(a, ITEMS.fleece);
    check("both rows come back, so the pure layer can pick", fleeceSales.length === 2,
      `got ${fleeceSales.length}`);
    check("one is cancelled and one is not",
      fleeceSales.filter((s) => s.status === "cancelled").length === 1 &&
      fleeceSales.filter((s) => s.status === "completed").length === 1);

    section("3. a sale whose costs were never recorded");
    const jeansSale = salesFor(a, ITEMS.jeans)[0];
    check("the sale is there", Boolean(jeansSale));
    check("and its acquisition basis is NULL rather than zero",
      jeansSale?.acquired_price === null,
      `got ${JSON.stringify(jeansSale?.acquired_price)}`);

    section("4. a refund");
    const refund = salesFor(a, ITEMS.synchilla)[0];
    check("the row is reported as refunded, not dropped", refund?.status === "refunded");
    check("and its money is still there to restate",
      refund?.money?.sale_price !== null && refund?.money?.sale_price !== undefined);

    section("5. a sale with no tracked minutes");
    const windTask = tasksFor(a, ITEMS.windbreaker)[0];
    check("the task comes back", Boolean(windTask));
    check("with NULL minutes rather than a zero",
      windTask?.confirmed_minutes === null,
      `got ${JSON.stringify(windTask?.confirmed_minutes)}`);
    check("and it did sell", salesFor(a, ITEMS.windbreaker).length === 1);

    section("6. work on something that has not sold");
    const coatTasks = tasksFor(a, ITEMS.overcoat);
    check("its tasks come back", coatTasks.length === 2, `got ${coatTasks.length}`);
    check("one finished and one was skipped",
      coatTasks.some((t) => t.task_state === "completed") &&
      coatTasks.some((t) => t.task_state === "skipped"));
    check("and there is no sale row for it", salesFor(a, ITEMS.overcoat).length === 0);

    section("7. two sellers (US-268)");
    const aIds = new Set((a.tasks ?? []).map((t) => t.inventory_item_id));
    const bIds = new Set((b.tasks ?? []).map((t) => t.inventory_item_id));
    check("A's read does not contain B's garment", !aIds.has(ITEMS.mallorys));
    check("B's read does not contain A's garments",
      ![...bIds].some((id) => Object.values(ITEMS).includes(id) && id !== ITEMS.mallorys));
    check("B sees their own work", bIds.has(ITEMS.mallorys));
    const aSaleIds = new Set((a.sales ?? []).map((s) => s.sale_id));
    const bSaleIds = new Set((b.sales ?? []).map((s) => s.sale_id));
    check("and the two sale lists share nothing",
      [...aSaleIds].filter((id) => bSaleIds.has(id)).length === 0);

    section("the sales read does not widen past the planned items");
    // ⚠ THIS REPLACED A CHECK THAT ASSERTED B HAD NO SALES AT ALL, which was
    // a claim about the fixture rather than about the code, and it failed the
    // first time it ran because B does have one. What is actually worth
    // holding is that the route reads sales only for items the seller
    // PLANNED: a read that widened to every sale they ever made would put
    // garments the planner never touched into the scorecard's denominator.
    const bPlanned = new Set(
      (b.tasks ?? []).map((t) => t.inventory_item_id).filter(Boolean),
    );
    check("every sale returned belongs to a planned item",
      (b.sales ?? []).every((s) => bPlanned.has(s.inventory_item_id)));
    const aPlanned = new Set(
      (a.tasks ?? []).map((t) => t.inventory_item_id).filter(Boolean),
    );
    check("same for A", (a.sales ?? []).every((s) => aPlanned.has(s.inventory_item_id)));

    // The "new seller with no learning data" half of AC6 is a claim about the
    // PLAN rather than about this read, and it is proved in the browser:
    // e2e/worth-my-time-live.spec.ts asserts a plan built with no confirmed
    // history still shows the estimator's labelled defaults.
  } finally {
    cleanup();
  }

  section("the seed left nothing behind");
  check("no seeded sessions remain",
    sql(`select count(*) from public.flipdesk_work_sessions where id in (${SESSIONS.map((s) => `'${s}'`).join(",")})`) === "0");
  check("no seeded sales remain",
    sql(`select count(*) from public.sales where id in (${SALES.map((s) => `'${s}'`).join(",")})`) === "0");

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) exit(1);
}

main().catch((err) => {
  cleanup();
  console.error(err);
  exit(1);
});
