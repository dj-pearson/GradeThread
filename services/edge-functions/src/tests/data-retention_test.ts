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

import { assert } from "@std/assert";

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
