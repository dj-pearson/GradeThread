// runbook-sync walks back past commits that only moved generator output.
//
// The narrowing is the risky half of that change: a classifier that is too
// greedy turns the whole lane green forever, which is worse than the ten false
// alarms it was written to stop. Every case below is either a line the cron
// doc generator really emits, or a line a person really wrote, taken from the
// actual diffs of `vault/10-ops/deploy.md` and `launch-checklist.md`.

import { describe, expect, it } from "vitest";
import { isGeneratedOnlyDiff } from "../../scripts/runbook-sync.mjs";

/** A diff body as `git show --format= --unified=0` prints it. */
const diff = (...lines: string[]) =>
  ["--- a/vault/10-ops/deploy.md", "+++ b/vault/10-ops/deploy.md", "@@ -1 +1 @@", ...lines].join(
    "\n",
  );

describe("runbook-sync only skips generator output", () => {
  it("skips a commit that just regenerated the cron table", () => {
    // b71cde5a5, the tenth false alarm: one new cron row and the two counts.
    expect(
      isGeneratedOnlyDiff(
        diff(
          "-  there are **91** (`CRON_REGISTRY` in `services/edge-functions/src/lib/cron-runs.ts`",
          "+  there are **92** (`CRON_REGISTRY` in `services/edge-functions/src/lib/cron-runs.ts`",
          "+| ebay-payout-link | `30 5 * * *` | `/api/jobs/ebay-payout-link` | secret | 200 {ok} |",
          "-_91 scheduled jobs. Default healthy response: 200 `{\"ok\":true,...}`._",
          "+_92 scheduled jobs. Default healthy response: 200 `{\"ok\":true,...}`._",
        ),
      ),
    ).toBe(true);
  });

  it("does NOT skip a commit that changed the procedure", () => {
    // The thing the lane exists for. If this ever returns true, an operator
    // reads a deploy order that no longer matches the note.
    expect(
      isGeneratedOnlyDiff(
        diff(
          "-- **Deploy order:** DB, then edge, then frontend.",
          "+- **Deploy order:** edge, then DB, then frontend.",
        ),
      ),
    ).toBe(false);
  });

  it("does NOT skip a mixed commit, even one generated line short", () => {
    // A real edit hidden among generated churn is exactly how a change gets
    // through unread, so ONE substantive line has to be enough.
    expect(
      isGeneratedOnlyDiff(
        diff(
          "+| ebay-payout-link | `30 5 * * *` | `/api/jobs/ebay-payout-link` | secret | 200 |",
          "+- **Rollback:** redeploy the previous image tag from Coolify.",
        ),
      ),
    ).toBe(false);
  });

  it("does NOT skip prose that merely sits inside the generated block", () => {
    expect(
      isGeneratedOnlyDiff(
        diff("+Spot-check one task with Run Now before you walk away."),
      ),
    ).toBe(false);
  });

  it("treats an empty diff as substantive rather than skippable", () => {
    // A commit this script cannot read must never be silently walked past.
    expect(isGeneratedOnlyDiff("")).toBe(false);
  });
});
