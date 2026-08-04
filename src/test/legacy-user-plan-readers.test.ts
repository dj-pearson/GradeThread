// US-2398: users.plan is FROZEN, and its readers must not multiply.
//
// 00001 defines it NOT NULL DEFAULT 'free'. 00039 backfilled flipdesk_plan FROM
// it — the legacy-to-new direction, once — and deliberately kept the legacy
// column. Nothing has written it since: no .update({ plan: … }) in the edge, no
// SET plan = in any migration.
//
// So its value is whatever the backfill left, which for anyone who signed up
// afterwards is the default. Four admin metrics still read it, and that is
// US-2398's job to fix. What THIS guard does is stop a fifth appearing while
// that fix waits on a migration window — because the reason four accumulated is
// that nothing ever objected to the fourth.
//
// Deliberately an ENUMERATION with reasons rather than a ban: the column exists
// and the fix will legitimately touch these very lines. A new reader has to be
// added here, which is the moment someone reads why they should not.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");

/**
 * Reads of the legacy column, as `u.plan` or a bare `plan` in a users query.
 *
 * Matched narrowly on the aliased form and on `group by plan` / `where plan`,
 * because `plan` is an extremely common word — `flipdesk_plan`, `buyer_plan`,
 * `to_plan`, `pricing_plans` and the word in prose would all match a loose
 * pattern, and a guard that cries wolf on its own vocabulary gets deleted.
 */
const LEGACY_READ =
  /\bu\.plan\b(?!_)|(?<![_a-z])plan\s*<>\s*'free'|group by plan\b|coalesce\(u\.plan/g;

/**
 * Known readers, each with why it is still here.
 *
 * Trimmed to what the scan ACTUALLY matches. My first draft also listed the
 * 00039 backfill and a one-off super-admin grant on the reasoning that they
 * obviously touch the column — neither matches, and one of the two filenames I
 * confidently wrote does not exist. A stale exemption is a documented promise
 * the code no longer keeps, so the third case below fails on one.
 */
const KNOWN: Record<string, string> = {
  "00513_admin_dashboard_aggregates.sql":
    "planDistribution + topUsers[].plan — US-2398 AC1 moves these to flipdesk_plan",
  "00514_admin_metrics_service_role_guard.sql":
    "totalPaid + churnFreeWithActivity — US-2398 AC1, and the churn numerator is " +
    "the sharpest of the four",
  "00147_admin_aggregates.sql":
    "superseded revision of the 00514 aggregate; kept because migrations are " +
    "immutable, and it no longer defines the live function",
};

describe("US-2398: the frozen users.plan column", () => {
  const offenders: string[] = [];
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));

  for (const f of files) {
    const sql = readFileSync(resolve(MIGRATIONS, f), "utf8")
      // Comments stripped: several migrations DISCUSS the legacy column at
      // length (00037 and 00163 explain the split), and a raw scan would report
      // the explanation as a reader.
      .replace(/--[^\n]*/g, "");
    if (LEGACY_READ.test(sql)) offenders.push(f);
    LEGACY_READ.lastIndex = 0;
  }

  it("has no reader that is not accounted for", () => {
    const unknown = offenders.filter((f) => !(f in KNOWN));
    expect(
      unknown,
      "a migration reads users.plan without being listed in KNOWN. That column " +
        "has not been written since the 00039 backfill, so whatever this query " +
        "reports is frozen at that point in time — which is exactly how the " +
        "admin dashboard came to undercount paid users and overstate churn. Use " +
        "flipdesk_plan, or add an entry here saying why not.",
    ).toEqual([]);
  });

  it("the guard is actually finding things — it is not vacuously green", () => {
    // Without this, a broken pattern would report zero offenders and pass
    // forever while the column quietly gained readers.
    expect(
      offenders.length,
      "the scan found NO reads of users.plan at all. Either every reader was " +
        "migrated (in which case delete this guard and the column), or the " +
        "pattern stopped matching and this test is now decorative.",
    ).toBeGreaterThan(0);
  });

  it("carries no stale exemption", () => {
    // The other direction, and the one I got wrong first: an entry for a file
    // that no longer reads the column (or never did) reads as a considered
    // decision about live code. It also inflates the list, which is how the
    // "shrink-only" intent quietly stops meaning anything.
    const stale = Object.keys(KNOWN).filter((f) => !offenders.includes(f));
    expect(
      stale,
      "these files are exempted but do not read users.plan — either the reader " +
        "was migrated (delete the entry) or the filename is wrong, in which " +
        "case the exemption was never protecting what it claimed to",
    ).toEqual([]);
  });

  it("MRR is NOT one of the readers", () => {
    // The specific thing I got wrong before checking, pinned so the next reader
    // does not repeat it: the revenue RPC prices MRR off flipdesk_plan and is
    // correct. Believing otherwise sends someone to fix a number that is fine
    // while the counts beside it stay broken.
    const revenue = readFileSync(
      resolve(MIGRATIONS, "00215_revenue_dashboard.sql"),
      "utf8",
    ).replace(/--[^\n]*/g, "");
    expect(revenue).toMatch(/pp\.key = u\.flipdesk_plan/);
    expect(revenue).not.toMatch(/\bu\.plan\b(?!_)/);
  });
});
