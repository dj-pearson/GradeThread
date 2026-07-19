// US-2006 regression guard — the retention sweep must be able to ADVANCE.
//
// The bug: purgeExpiredGradingPii() selected 200 arbitrary SUBMISSIONS past the
// cutoff, with no filter for whether any images remained and no ORDER BY, then
// looked up their images and returned early when there were none. After the
// first run purged those 200, every subsequent nightly run re-selected the SAME
// already-purged submissions, found nothing, and returned objects_deleted: 0.
// Newer expired submissions were never reached — GDPR storage-limitation was
// silently unenforced from run two onward while the cron reported ok:true.
//
// WHAT THIS TEST IS, STATED HONESTLY: a STRUCTURAL guard, not a behavioural
// one. purgeExpiredGradingPii talks to the service-role client directly with no
// injection seam, so there is no way to drive two sweeps over a fixture here
// without a live DB. But the defect IS a property of the query's shape — "does
// the scan select rows that the sweep then deletes?" — so shape is the right
// thing to pin. A behavioural test belongs in the db lane; this one exists so
// the shape cannot regress silently in the meantime.

import { assert, assertEquals } from "@std/assert";

// The US-2006 AC4 block below IMPORTS data-retention.ts (rather than only
// reading its source), which transitively constructs the service-role supabase
// client — that throws without these. Set before any dynamic import.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const SRC = await Deno.readTextFile(
  new URL("../lib/data-retention.ts", import.meta.url),
);

// Isolate the scan query (everything up to the storage-delete section) so these
// assertions can't be satisfied by some unrelated query later in the file.
const SCAN = SRC.slice(0, SRC.indexOf("// Delete the storage objects"));

Deno.test("retention scan drives off submission_images, not submissions", () => {
  assert(
    /\.from\("submission_images"\)[\s\S]{0,200}?submissions!inner\(created_at\)/.test(SCAN),
    "The scan must select submission_images joined to submissions!inner(created_at). " +
      "Selecting submissions first and THEN looking up images is what made the " +
      "sweep re-scan already-purged rows forever.",
  );
  assert(
    /\.lt\("submissions\.created_at", cutoff\)/.test(SCAN),
    "The cutoff must be applied to the joined submissions.created_at.",
  );
});

Deno.test("retention scan is ordered, so progress is deterministic", () => {
  assert(
    /\.order\("created_at", \{ ascending: true \}\)/.test(SCAN),
    "The scan must be ordered oldest-first. Without ORDER BY the batch depends " +
      "on Postgres row order, so 'the next 200' is not a well-defined set.",
  );
});

Deno.test("retention scan does NOT batch on submissions (the stalling shape)", () => {
  // The precise shape of the original bug: a limited scan over `submissions`
  // whose result is then used to find images. If this reappears, the sweep can
  // select rows it will not delete, and it stops advancing.
  assert(
    !/\.from\("submissions"\)[\s\S]{0,160}?\.limit\(BATCH_LIMIT\)/.test(SCAN),
    "The scan must not take a LIMITed batch of `submissions` — that batch can " +
      "consist entirely of already-purged rows, which is exactly the stall this " +
      "guard exists to prevent.",
  );
});

// ── US-2021: email_deliveries must be bounded, WITHOUT eating the operator queue ──
//
// The table stores the full rendered `html` of every critical email and had no
// purge at all, so it grew forever: on track to be the largest table in the DB,
// inflating backup/restore windows and forming the biggest reservoir of
// un-erasable PII. The risk in FIXING it is the opposite mistake — a careless
// bulk delete would wipe dead_letter rows, which are an operator replay queue
// and the only evidence that mail went undelivered.

const CRON = SRC.slice(SRC.indexOf("export async function handleDataRetentionCron"));

Deno.test("US-2021: delivered email records are purged", () => {
  assert(
    /from\("email_deliveries"\)[\s\S]{0,200}?\.delete\(\)/.test(CRON),
    "the retention cron must purge email_deliveries — it stores full message " +
      "bodies and previously had no purge anywhere in the codebase",
  );
});

Deno.test("US-2021: the sent purge is SCOPED to sent rows and to a cutoff", () => {
  // Both filters are load-bearing. Without status='sent' the sweep eats the
  // dead-letter queue; without the cutoff it deletes mail sent seconds ago,
  // which support may still need to read back.
  //
  // The scoping now lives on the SCAN (select ids) rather than on the DELETE,
  // because the sweep is batched — see the bounded-sweep test below. Asserting
  // the scan is asserting the same property: the delete only ever receives ids
  // this query produced.
  const scan = CRON.slice(
    CRON.indexOf("const { data: sentBatch"),
    CRON.indexOf("const { data: sentBatch") + 400,
  );
  assert(
    /\.eq\("status", "sent"\)/.test(scan),
    "the email_deliveries purge must be scoped to status='sent' — an unscoped " +
      "sweep would destroy the dead_letter operator replay queue",
  );
  assert(
    /\.lt\("created_at",/.test(scan),
    "the email_deliveries purge must be bounded by a created_at cutoff",
  );
});

Deno.test("US-2021: dead-lettered mail is BODY-STRIPPED, never deleted", () => {
  // A dead-letter row is a queue item someone may still replay. Keep the row,
  // drop only the heavy PII-bearing body.
  const scan = CRON.slice(
    CRON.indexOf("const { data: deadBatch"),
    CRON.indexOf("const { data: deadBatch") + 500,
  );
  assert(
    /\.eq\("status", "dead_letter"\)/.test(scan),
    "the dead-letter sweep must select only dead_letter rows",
  );
  assert(
    /\.update\(\{ html: "" \}\)/.test(CRON),
    "dead_letter rows must have their html stripped rather than being deleted — " +
      "deleting them destroys the evidence that mail was never delivered, which " +
      "is the entire purpose of a dead-letter table",
  );
  // The strongest form of the rule: NOWHERE in the cron may a delete be scoped
  // to dead_letter, in either order.
  assert(
    !/\.eq\("status", "dead_letter"\)[\s\S]{0,120}?\.delete\(\)/.test(CRON) &&
      !/\.delete\(\)[\s\S]{0,120}?\.eq\("status", "dead_letter"\)/.test(CRON),
    "dead_letter rows must never be DELETEd by the retention sweep",
  );
});

// US-2021 (follow-up): the FIRST run sweeps a table that has never been pruned.
// An unbounded DELETE there is a long transaction and a WAL spike on the largest
// table in the DB, during a nightly cron, on a single-replica edge.
Deno.test("US-2021: both email sweeps are BOUNDED per run", () => {
  const limits = CRON.match(/\.limit\(EMAIL_PURGE_BATCH\)/g) ?? [];
  assertEquals(
    limits.length,
    2,
    "both the sent-purge and dead-letter scans must be capped by EMAIL_PURGE_BATCH — " +
      "an uncapped first sweep over a never-pruned table is one enormous transaction",
  );
});

// ── US-2006 AC4: notice when the sweep stops advancing ───────────────
//
// The original bug ran green every night while purging nothing from run two
// onward. The query shape is fixed and pinned above; this is the RUNTIME
// counterpart, because a stall could return in a form no source assertion
// catches (a bad cutoff, an RLS change, a storage outage).

const { decideRetentionStall, RETENTION_STALL_THRESHOLD } = await import(
  "../lib/data-retention.ts"
);

Deno.test("US-2006: progress is never a stall", () => {
  const d = decideRetentionStall({
    objectsDeleted: 12,
    pastCutoffRemaining: 500,
    priorConsecutive: 4,
  });
  assertEquals(d.alert, false);
  assertEquals(d.consecutive, 0, "a productive run must RESET the streak");
});

// The steady state once the backlog is drained. Alerting here would fire every
// night forever, which is how a channel becomes noise and stops being read —
// the same reasoning as the cron-fleet suppression window.
Deno.test("US-2006: zero deleted with nothing left to do is NOT a stall", () => {
  const d = decideRetentionStall({
    objectsDeleted: 0,
    pastCutoffRemaining: 0,
    priorConsecutive: 0,
  });
  assertEquals(d.alert, false);
});

// THE ACTUAL BUG: past-cutoff work exists and the sweep purged nothing.
Deno.test("US-2006: zero deleted WHILE past-cutoff rows remain alerts", () => {
  const d = decideRetentionStall({
    objectsDeleted: 0,
    pastCutoffRemaining: 1_337,
    priorConsecutive: 0,
  });
  assertEquals(d.alert, true);
  assertEquals(d.consecutive, 1);
  assertEquals(d.severity, "warning", "one odd run is a warning, not a page");
});

Deno.test("US-2006: a persistent stall escalates to critical at the threshold", () => {
  const below = decideRetentionStall({
    objectsDeleted: 0,
    pastCutoffRemaining: 10,
    priorConsecutive: RETENTION_STALL_THRESHOLD - 2,
  });
  assertEquals(below.severity, "warning");

  const at = decideRetentionStall({
    objectsDeleted: 0,
    pastCutoffRemaining: 10,
    priorConsecutive: RETENTION_STALL_THRESHOLD - 1,
  });
  assertEquals(at.consecutive, RETENTION_STALL_THRESHOLD);
  assertEquals(at.severity, "critical", "a sweep stuck this long is the original bug");
});

// A corrupt/missing prior count must not make the detector go quiet.
Deno.test("US-2006: a negative or absent prior count still alerts from 1", () => {
  for (const prior of [-5, 0]) {
    const d = decideRetentionStall({
      objectsDeleted: 0,
      pastCutoffRemaining: 1,
      priorConsecutive: prior,
    });
    assertEquals(d.alert, true, `prior=${prior}`);
    assertEquals(d.consecutive, 1);
  }
});
