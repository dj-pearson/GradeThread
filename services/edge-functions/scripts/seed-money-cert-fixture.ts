// US-2038 AC2: seed the money/certificate integration fixture.
//
// Five suites — credit-refund, ledger-consistency, ai-quota-concurrency,
// public-certificate, passport-claim — gate on TEST_* fixture env and had no CI
// job supplying any of it, so all 11 of their assertions had never run anywhere
// but a developer's machine. ledger-consistency_test.ts asserts the credit-ledger
// balance invariant (SUM(delta) == users.grade_credit_balance), which is the most
// load-bearing money assertion in the repo.
//
// THE REASON THIS SAT OPEN: the story's own notes concluded twice that AC2
// "needs credentials I do not have". That was wrong, and the counter-example was
// already in the repo — .github/workflows/tenant-isolation.yml boots a THROWAWAY
// local Supabase stack, seeds its own fixture and runs a suite that used to be
// described the same way. None of these five suites needs production: they need
// a database with the schema and some rows they are allowed to destroy. That is
// exactly what `supabase start` gives you, and it is safer than prod because
// every one of these suites MUTATES what it points at (balances, quota counters,
// garment ownership).
//
// So this script builds that fixture against the LOCAL stack — never production.
// It:
//   1. creates three throwaway users, one per money suite, idempotently;
//   2. certifies a grade report so the public certificate view has a subject;
//   3. creates a Garment Passport garment for the claim-redemption suite;
//   4. prints `KEY=VALUE` lines on stdout for the workflow to append to
//      $GITHUB_ENV.
//
// Three SEPARATE users on purpose. The suites are destructive in different
// directions — ledger-consistency drives the balance to zero with 40 parallel
// debits, ai-quota-concurrency parks the AI counter exactly on the cap, and
// credit-refund asserts on a balance delta it measured at test start. Sharing one
// row would make them order-dependent, and an order-dependent money test that
// passes today is a test that fails on an unrelated PR later.
//
// Any failure here is fatal (exit 1). A fixture that cannot be built must fail
// the CI job — never let the suite fall back to a silent SKIP, which is the
// whole defect US-2038 exists to close.
//
// Required env:
//   SUPABASE_URL                e.g. http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY   local service-role key (supabase status)
//
// Run:  deno run --allow-net --allow-env scripts/seed-money-cert-fixture.ts

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "[seed-money] Missing env. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
  );
  Deno.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Deterministic addresses — the local stack is throwaway, so fixed values keep
// the seed idempotent across re-runs.
const PASSWORD = "Money-Cert-Fixture-1!";
const LEDGER_EMAIL = "ledger@money-cert.test";
const CREDIT_EMAIL = "credit@money-cert.test";
const QUOTA_EMAIL = "quota@money-cert.test";
const CERT_EMAIL = "cert-owner@money-cert.test";

const out: Record<string, string> = {};

function log(msg: string): void {
  // Diagnostics go to stderr so stdout carries ONLY KEY=VALUE lines.
  console.error(`[seed-money] ${msg}`);
}

function die(msg: string): never {
  console.error(`[seed-money] FATAL: ${msg}`);
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

/**
 * Put a money user back to a known starting state.
 *
 * Re-runs matter more here than in the tenant fixture: these suites LEAVE the
 * row mutated by design (a zeroed wallet, a counter parked on the cap), so a
 * second run against a reused stack would start from the previous run's wreckage
 * rather than from zero. Resetting the ledger rows too keeps
 * credit_ledger_reconciliation() honest — it compares SUM(delta) against the
 * balance, so clearing one without the other would manufacture the exact drift
 * ledger-consistency_test.ts exists to detect.
 */
async function resetWallet(userId: string): Promise<void> {
  const { error: delErr } = await admin
    .from("grade_credit_transactions")
    .delete()
    .eq("user_id", userId);
  if (delErr) die(`clear ledger for ${userId} failed: ${delErr.message}`);

  const { error: updErr } = await admin
    .from("users")
    .update({
      grade_credit_balance: 0,
      ai_actions_used_this_month: 0,
    })
    .eq("id", userId);
  if (updErr) die(`reset wallet for ${userId} failed: ${updErr.message}`);
}

// Insert a row and return its id; fatal on error (so schema drift fails CI).
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
  // ── The three money users ───────────────────────────────────────────
  const ledgerId = await ensureUser(LEDGER_EMAIL);
  const creditId = await ensureUser(CREDIT_EMAIL);
  const quotaId = await ensureUser(QUOTA_EMAIL);
  for (const id of [ledgerId, creditId, quotaId]) await resetWallet(id);

  out.TEST_LEDGER_USER_ID = ledgerId;
  out.TEST_CREDIT_USER_ID = creditId;
  out.TEST_QUOTA_USER_ID = quotaId;

  // ── A certified report for the public certificate view ──────────────
  // public-certificate_test.ts reads it as ANON, twice: the base table must
  // return nothing (RLS deny-by-default since 00082 dropped the broad policy)
  // and public_grade_reports must return the buyer-facing projection. Both
  // directions need a row that actually carries certificate_id.
  const certOwnerId = await ensureUser(CERT_EMAIL);
  // status must not be 'pending_review' — see the view predicate below.
  // 'completed' is what a real certified submission carries.
  const submissionId = await insert("submissions", {
    user_id: certOwnerId,
    garment_type: "tops",
    garment_category: "t-shirt",
    title: "Money/cert fixture submission",
    status: "completed",
  });

  // confidence_score 0.92 lands in the 'very_high' bucket, so the suite's
  // assertion that confidence_label is a string exercises a real CASE branch
  // rather than the ELSE fallback.
  //
  // review_status MATTERS and is easy to get wrong. Since 00312 (mandatory grade
  // review) the view's predicate is not just `certificate_id IS NOT NULL` — it
  // is that AND review_status IN ('approved','modified') AND the submission is
  // neither pending_review nor unapproved-flagged. A row that omits
  // review_status defaults to 'pending' and is therefore INVISIBLE through the
  // view, which reads as "anon cannot see the certificate" and looks exactly
  // like the RLS bug the suite is hunting. Verified by hitting it: the first run
  // of this fixture failed both view assertions for precisely this reason.
  const certificateId = crypto.randomUUID();
  await insert("grade_reports", {
    submission_id: submissionId,
    overall_score: 8.4,
    grade_tier: "Excellent",
    fabric_condition_score: 8.5,
    structural_integrity_score: 8.5,
    cosmetic_appearance_score: 8.0,
    functional_elements_score: 8.5,
    odor_cleanliness_score: 8.5,
    ai_summary: "Money/cert fixture report. Not a real grade.",
    confidence_score: 0.92,
    model_version: "fixture",
    certificate_id: certificateId,
    review_status: "approved",
  });
  out.TEST_PUBLIC_CERTIFICATE_ID = certificateId;

  // ── A garment for the passport claim-redemption suite ───────────────
  // passport-claim_test.ts seeds its own tokens per case; it only needs a
  // garment whose ownership it may transfer. Deliberately NOT the tenant
  // fixture's garment: that one is an isolation subject, and this suite ends by
  // moving current_owner_node_id to a buyer node.
  out.TEST_PASSPORT_GARMENT_ID = await insert("garments", {
    created_by: certOwnerId,
  });

  log(
    `seeded ledger=${ledgerId} credit=${creditId} quota=${quotaId} ` +
      `cert=${certificateId}`,
  );

  // Emit KEY=VALUE lines on stdout for $GITHUB_ENV.
  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}=${v}`);
  }
}

await main();
