// US-3214: a double click on Submit must not buy a second grade.
//
// WHAT IS PROVED WHERE, because neither half is sufficient alone.
//
//   scripts/check-one-open-grade.mjs runs against a REAL Postgres and proves
//   00821's partial unique index: nine refusals across the three non-terminal
//   states, and five things it must not refuse (a re-grade after completed or
//   failed, two garments at once, a released lock). That is the behaviour, and
//   a source scan cannot produce it.
//
//   THIS FILE pins the ORDER, which the database cannot see. The index only
//   saves money if the row that takes it is written BEFORE the charge. Move
//   the insert back below runPaymentPrecedence and every case in that script
//   still passes while a double click costs twice again -- which is exactly
//   the shape this defect had for as long as it existed.

import { assert } from "@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../lib/grading-submit.ts", import.meta.url),
);
const BILLING = await Deno.readTextFile(
  new URL("../lib/grade-billing.ts", import.meta.url),
);
const SQL_00821 = await Deno.readTextFile(
  new URL("../../../../supabase/migrations/00821_one_open_grade_per_item.sql", import.meta.url),
);

/**
 * Source with its comments stripped.
 *
 * ⚠ NOT A TIDINESS MEASURE. A sabotage that replaced `=== "23505"` with
 * `false` left every assertion here green, because the comment explaining
 * what 23505 means is two lines below the code and satisfied the scan. This
 * file asserts what the code DOES, so it must not be able to read the
 * sentences describing it.
 */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

const CODE = codeOf(SRC);

/** The per-item loop, so buildValidation's own reads cannot satisfy anything. */
const LOOP = codeOf(SRC.slice(SRC.indexOf("for (const item of validation.result.items)")));

Deno.test("US-3214 AC1: the lock row is written BEFORE the charge", () => {
  const lock = LOOP.indexOf('.from("flipdesk_grading_submissions")');
  const charge = LOOP.indexOf("runPaymentPrecedence(");
  assert(lock > 0, "the loop must insert a flipdesk_grading_submissions row");
  assert(charge > 0, "the loop must call runPaymentPrecedence");
  assert(
    lock < charge,
    "the flipdesk_grading_submissions insert must come BEFORE " +
      "runPaymentPrecedence. Below it, the index refuses the second press " +
      "only after the second press has already been charged.",
  );
});

Deno.test("US-3214 AC1: the submissions row is created before the lock", () => {
  // The link row carries submission_id NOT NULL in practice, so the order
  // within the pair is fixed; asserted so a reorder that drops the id is
  // caught here rather than by a foreign-key error in production.
  const sub = LOOP.indexOf('.from("submissions")');
  const lock = LOOP.indexOf('.from("flipdesk_grading_submissions")');
  assert(sub > 0 && lock > sub, "submissions insert, then the lock row");
});

Deno.test("US-3214 AC1: a 23505 on the lock is a refusal, not a thrown error", () => {
  const seg = LOOP.slice(LOOP.indexOf('.from("flipdesk_grading_submissions")'));
  assert(
    /23505/.test(seg.slice(0, 1200)),
    "the insert must recognise the unique violation by CODE. Matching the " +
      "message text breaks on a Postgres upgrade and on a locale change.",
  );
  assert(
    /code:\s*"already_submitted"/.test(seg.slice(0, 1600)),
    "a duplicate must report a machine-readable code, so the screen can tell " +
      "it from a payment failure without matching on the sentence",
  );
});

Deno.test("US-3214 AC1: the empty submission is cleaned up on a refusal", () => {
  const seg = LOOP.slice(LOOP.indexOf('.from("flipdesk_grading_submissions")'));
  const window = seg.slice(0, 1600);
  assert(
    /\.from\("submissions"\)\s*\.delete\(\)/.test(window),
    "a refused second press must not leave an orphan submissions row behind",
  );
});

Deno.test("US-3214: the pre-loop read fails CLOSED", () => {
  const preLoop = codeOf(SRC.slice(0, SRC.indexOf("for (const item of validation.result.items)")));
  // From the QUERY, not from the const declaration three hundred lines above
  // it -- the first version sliced from the declaration and the window never
  // reached the code it was asserting about.
  const seg = preLoop.slice(
    preLoop.indexOf('.in("status", NON_TERMINAL_SUBMISSION_STATES)'),
  );
  assert(
    /status:\s*503/.test(seg.slice(0, 1200)),
    "if we cannot tell whether a grade is already running, we must refuse. " +
      "Guessing wrong charges a seller twice.",
  );
});

Deno.test("US-3214: a failure releases the lock", () => {
  // A link row left `pending` after a photo-copy failure would refuse every
  // future submission for that garment, so a transient failure would lock a
  // seller out of grading it until somebody noticed.
  const cat = LOOP.slice(LOOP.lastIndexOf("} catch (err) {"));
  assert(
    /flipdesk_grading_submissions[\s\S]{0,200}?status:\s*"failed"/.test(cat),
    "the catch must close the lock row",
  );
  const unpaid = LOOP.slice(LOOP.indexOf("if (!precedence.paid)"));
  assert(
    /flipdesk_grading_submissions[\s\S]{0,200}?\.delete\(\)/.test(unpaid.slice(0, 900)),
    "an unpaid submission must drop its lock row too",
  );
});

Deno.test("US-3214: the non-terminal set is the one the index uses", () => {
  // The migration's own header explains the state set in prose, so the
  // predicate is read from the CREATE INDEX statement alone.
  const sql = SQL_00821.slice(SQL_00821.indexOf("CREATE UNIQUE INDEX"));
  for (const state of ["pending", "processing", "pending_review"]) {
    assert(
      CODE.includes(`"${state}"`),
      `NON_TERMINAL_SUBMISSION_STATES must contain ${state}`,
    );
    assert(
      sql.includes(`'${state}'`),
      `00821's index predicate must contain ${state}`,
    );
  }
  // And the terminal ones are in neither, or the index would refuse a
  // legitimate re-grade.
  for (const state of ["completed", "expired", "disputed"]) {
    assert(
      !sql.includes(`'${state}'`),
      `00821 must NOT cover ${state}: a finished grade may be re-run`,
    );
  }
});

Deno.test("US-3214 AC7: the INCLUDED monthly claim has no idempotency key", () => {
  // ⚠ THIS TEST ASSERTS A HOLE, and it is here so the hole cannot be closed
  // silently or reopened silently.
  //
  // AC7 asked which half of the money is deduped. Checked rather than assumed:
  // debitCredits passes p_idempotency_key into debit_grade_credits, so a
  // retried CREDIT charge is idempotent at the database. claimIncluded is a
  // compare-and-swap increment on users.grades_used_this_month and takes no
  // key at all, so before US-3214 a double click really did burn two of the
  // monthly bundle.
  //
  // What closes it is 00821 plus the reorder above: there is no second
  // submission to charge. The claim itself is still keyless, and if somebody
  // gives it a key this assertion fails and the comment in the note stops
  // being true -- which is the point.
  const billing = codeOf(BILLING);
  const claim = billing.slice(billing.indexOf("claimIncluded:"));
  const body = claim.slice(0, claim.indexOf("debitCredits:"));
  assert(
    !/idempotencyKey/.test(body),
    "claimIncluded now takes an idempotency key. Good -- update US-3214's " +
      "note, which records that it does not.",
  );
  const debit = billing.slice(billing.indexOf("debitCredits:"));
  assert(
    /p_idempotency_key:\s*idempotencyKey/.test(debit.slice(0, 800)),
    "the credit debit must stay idempotent (US-2289/US-2564)",
  );
});
