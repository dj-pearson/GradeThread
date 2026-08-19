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

// ── US-2642: a published retention promise needs a sweep that reaches everyone ──
//
// The Privacy Policy says of listings checked through the extension: "Deleted
// automatically 90 days after the check." Unconditional, no "while you keep
// using it" attached.
//
// The only prune was INLINE ON THE WRITE PATH in public-grading.ts, scoped to
// the ingesting buyer. That is right for an active buyer and structurally
// cannot reach the case the promise most needs to cover: someone who used the
// extension, stopped, and never writes again. No next write, no prune, and
// their browsing history sits forever while a public page says otherwise.
//
// These pin the backstop, and they pin the INLINE prune too — deleting the fast
// path and leaving only a nightly job would be a quiet regression in latency
// for the active buyer, which is the thing the inline comment argues for.

Deno.test("US-2642: the cron sweeps ingested_listings fleet-wide", () => {
  assert(
    /\.from\("ingested_listings"\)[\s\S]{0,400}?\.delete\(\)/.test(CRON),
    "nothing in the retention cron deletes ingested_listings, so a buyer who " +
      "stops using the extension keeps their checked-listing history forever — " +
      "against an unconditional promise in the Privacy Policy",
  );
});

Deno.test("US-2642: that sweep is time-scoped and bounded", () => {
  const at = CRON.indexOf('.from("ingested_listings")');
  assert(at > -1, "the ingested_listings sweep was renamed or removed");
  const window = CRON.slice(at, at + 700);
  assert(
    /\.lt\("created_at", ingestCutoff\)/.test(window),
    "the sweep must be scoped to a cutoff — an unfiltered delete on this table " +
      "would destroy every buyer's current checks",
  );
  assert(
    /\.limit\(INGEST_PURGE_BATCH\)/.test(window),
    "the first fleet-wide pass over a table nothing has ever swept must be bounded",
  );
  // Fleet-wide by design, so nothing may narrow it to a caller-supplied owner.
  assert(
    !/\.eq\("user_id"/.test(window),
    "this is a fleet sweep; scoping it to one user_id would recreate the gap it exists to close",
  );
});

Deno.test("US-2642: the window is imported, not restated", () => {
  // A published commitment written down twice is how a page and a job come to
  // disagree, and the page is the one a regulator reads.
  assert(
    /import \{ INGEST_RETENTION_DAYS \} from "\.\/listing-ingest\.ts"/.test(SRC),
    "the retention window must come from listing-ingest.ts, not a local literal",
  );
  assert(
    !/const\s+INGEST_RETENTION_DAYS\s*=/.test(SRC),
    "data-retention.ts declares its own copy of the retention window",
  );
});

Deno.test("US-9113/US-9122: the connector's two sweeps are actually CALLED", () => {
  // Both SQL functions shipped with headers describing a cron that calls them,
  // and for two commits nothing did. A retention policy with no caller is a
  // comment. The OAuth one matters more than storage does: spent authorization
  // codes and revoked refresh tokens are credentials, and keeping them forever
  // keeps every one of them available to whatever replay bug turns up next.
  for (const fn of ["sweep_mcp_tool_calls", "sweep_oauth_expired"]) {
    assert(
      new RegExp(`["']${fn}["']`).test(CRON),
      `the retention cron never calls ${fn}, so the retention window that ` +
        `migration promises is not enforced anywhere`,
    );
  }
  // Called through .rpc, not merely named in a comment or a log string.
  assert(
    /supabaseAdmin\.rpc\(fn, \{\}\)/.test(CRON),
    "the sweep names appear without an rpc call behind them",
  );
});

Deno.test("US-9113/US-9122: neither sweep may fail the PII purge", () => {
  // Every prune in this handler is best-effort for the same reason: the job's
  // reason to exist is the grading-photo purge, and a connector table must
  // never be what stops it.
  const at = CRON.indexOf("sweep_mcp_tool_calls");
  assert(at > -1, "the connector sweeps were renamed or removed");
  const window = CRON.slice(at, at + 900);
  assert(
    /try \{[\s\S]*?catch \(err\) \{[\s\S]*?captureException/.test(window),
    "the sweeps must be wrapped so a failure is captured and swallowed",
  );
});

Deno.test("US-2642: the inline write-path prune is still there", () => {
  // The backstop is an ADDITION. Removing the inline prune would mean an active
  // buyer's own stale rows wait for a nightly job, which is exactly what that
  // code's comment argues against.
  const ingest = Deno.readTextFileSync(
    new URL("../routes/public-grading.ts", import.meta.url),
  );
  assert(
    /INGEST_RETENTION_DAYS[\s\S]{0,600}?\.from\("ingested_listings"\)[\s\S]{0,200}?\.delete\(\)[\s\S]{0,200}?\.eq\("user_id", ownerId\)/
      .test(ingest),
    "the per-owner inline prune on the ingest write path is gone; the nightly " +
      "backstop was added alongside it, not instead of it",
  );
});
