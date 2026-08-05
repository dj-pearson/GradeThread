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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
    "SUPERSEDED by 00525 (US-2398). Migrations are immutable, so the old text " +
    "stays on disk; admin_platform_analytics now reads flipdesk_plan",
  "00514_admin_metrics_service_role_guard.sql":
    "SUPERSEDED by 00525 (US-2398). admin_system_metrics now reads flipdesk_plan",
  "00147_admin_aggregates.sql":
    "superseded revision of the 00514 aggregate; kept because migrations are " +
    "immutable, and it no longer defines the live function",
};

// ── The TypeScript half of the guard (US-2398 AC5) ───────────────────────────

const CODE_ROOTS = ["services/edge-functions/src", "src", "functions"];

/** A double-quoted literal, the form every PostgREST column list is written in. */
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"/g;
/** The object body of a `.update({ … })`. */
const UPDATE_BODY = /\.update\(\s*\{([^}]*)\}/g;
/**
 * `plan` as a KEY inside that body — `{ plan }`, `{ plan: x }`, `…, plan, …`.
 *
 * The leading `^|,` is what makes it a key rather than a value, and it is not
 * pedantry: `.update({ flipdesk_plan: plan })` is the single most common write
 * in this codebase, and a pattern that allows whitespace before `plan` flags
 * every one of them. Five files failed that way before this was tightened.
 */
const PLAN_AS_KEY = /(^|,)\s*plan\s*(:|,|$)/;

/**
 * Every file that names `plan` as a COLUMN — in a select list or an update —
 * rather than as a variable or a field on an already-fetched object.
 *
 * Deliberately scoped to the query, not to `.plan` property access: the access
 * is downstream of a query this scan already sees, and matching it would flag
 * `opts.plan`, `slice.plan` and every chart row, which is how a guard earns the
 * reputation that gets it deleted.
 */
function scanCode(): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      // Tests name the column while pinning this very behaviour.
      if (/\.test\.tsx?$|_test\.ts$/.test(entry)) continue;

      const src = readFileSync(p, "utf8")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      let matched = false;
      UPDATE_BODY.lastIndex = 0;
      let u: RegExpExecArray | null;
      while ((u = UPDATE_BODY.exec(src)) !== null) {
        if (PLAN_AS_KEY.test(u[1] ?? "")) {
          matched = true;
          break;
        }
      }

      // A column list: `"id, plan, role"`. The comma is required — a lone
      // `"plan"` is a chart dataKey, a switch case or a CSV header far more
      // often than it is a query, and those cost more in noise than the
      // single-column select they would catch (which no file does today).
      if (!matched) {
        STRING_LITERAL.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STRING_LITERAL.exec(src)) !== null) {
          const parts = m[0].slice(1, -1).split(",").map((s) => s.trim());
          if (parts.length > 1 && parts.includes("plan")) {
            matched = true;
            break;
          }
        }
      }

      // `.eq("plan", …)` / `.neq("plan", …)` — a filter names the column just as
      // surely as a select does, and this is the shape the admin dashboard's
      // subscriber count and the user-list plan filter were both hiding in.
      if (!matched && /\.(?:eq|neq|in|not)\(\s*"plan"/.test(src)) matched = true;

      if (matched) hits.push(relative(process.cwd(), p).replace(/\\/g, "/"));
    }
  };
  for (const root of CODE_ROOTS) walk(resolve(process.cwd(), root));
  return hits;
}

/**
 * Application code that still queries the column, each with why.
 *
 * EMPTY, and that is the point (US-2398 AC4). The last entry was
 * admin-users.ts's POST /:id/plan — the column's only writer as well as a
 * reader — and rewiring it to flipdesk_plan + a 'comp' status left users.plan
 * unread by every line of application code. Adding an entry back is a decision
 * to read a column nothing writes; if you are doing that, say why in the string.
 */
const KNOWN_CODE: Record<string, string> = {};

/**
 * The scan run against a fixture instead of the tree.
 *
 * Needed because the tree is now clean: an all-clear from a matcher that
 * silently stopped matching looks exactly like an all-clear from a codebase
 * that stopped reading the column, and only one of those is worth anything.
 * The old "not vacuously green" case leaned on a real offender existing, which
 * stopped being true the moment the fix landed.
 */
function matchesFixture(src: string): boolean {
  let matched = false;
  UPDATE_BODY.lastIndex = 0;
  let u: RegExpExecArray | null;
  while ((u = UPDATE_BODY.exec(src)) !== null) {
    if (PLAN_AS_KEY.test(u[1] ?? "")) matched = true;
  }
  if (!matched) {
    STRING_LITERAL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRING_LITERAL.exec(src)) !== null) {
      const parts = m[0].slice(1, -1).split(",").map((s) => s.trim());
      if (parts.length > 1 && parts.includes("plan")) matched = true;
    }
  }
  if (!matched && /\.(?:eq|neq|in|not)\(\s*"plan"/.test(src)) matched = true;
  return matched;
}

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

  it("US-2398: the REPLACEMENT migration is not itself a reader", () => {
    // The fix is only a fix if 00525 stopped reading the frozen column. Since
    // the superseded definitions stay on disk forever, the KNOWN list alone
    // cannot tell "replaced" from "still broken" — this is what distinguishes
    // them.
    const sql = readFileSync(
      resolve(MIGRATIONS, "00525_admin_metrics_flipdesk_plan.sql"),
      "utf8",
    ).replace(/--[^\n]*/g, "");
    LEGACY_READ.lastIndex = 0;
    expect(
      LEGACY_READ.test(sql),
      "00525 still reads users.plan — it was written to stop doing exactly that",
    ).toBe(false);
    // And it must actually read the live column, not merely avoid the dead one.
    expect(sql).toMatch(/flipdesk_plan/);
  });

  it("US-2398 AC5: no application code queries the column outside the list", () => {
    // WHY THIS EXISTS, and it is the correction that matters most in this file:
    // the original guard scanned MIGRATIONS ONLY. The story counted four SQL
    // readers, a later pass found six — and NONE of the counts included the
    // TypeScript layer, which had SEVEN more. Two of them were not cosmetic:
    //
    //   • drip.ts fed `users.plan` into the drip campaign branch field, so a
    //     `plan` condition took the free-tier path for every paying seller.
    //   • admin-flags.ts sampled it to preview a flag's reach AND offered the
    //     frozen vocabulary ('professional'/'enterprise') as the targets, so a
    //     plan-targeted rule could not match a live account.
    //
    // A guard that watches one language while the column is read from two is
    // not a guard; it is the reason the count kept being wrong.
    const offenders = scanCode();
    const unknown = offenders.filter((f) => !(f in KNOWN_CODE));
    expect(
      unknown,
      "this file queries users.plan. It is frozen — nothing has written it " +
        "through the subscription path since the 00039 backfill, so it reads " +
        "'free' for every account created since. Entitlements, MRR, the grade " +
        "allowance and the AI-action caps all live on users.flipdesk_plan. " +
        "Use that, or add an entry to KNOWN_CODE saying why not.",
    ).toEqual([]);
  });

  it("US-2398 AC5: the code guard carries no stale exemption", () => {
    const offenders = scanCode();
    const stale = Object.keys(KNOWN_CODE).filter((f) => !offenders.includes(f));
    expect(
      stale,
      "these files are exempted but no longer query users.plan — delete the " +
        "entry, or the exemption is documenting a decision about code that " +
        "does not exist",
    ).toEqual([]);
  });

  it("US-2398 AC5: the code guard is not vacuously green", () => {
    // Each shape the scan claims to catch, proved against a fixture. The tree
    // is clean now, so this is the only thing standing between "no code reads
    // the column" and "the matcher broke and nobody noticed".
    expect(matchesFixture('.select("id, plan, role")')).toBe(true);
    expect(matchesFixture(".update({ plan })")).toBe(true);
    expect(matchesFixture('.update({ plan: "free" })')).toBe(true);
    expect(matchesFixture('.neq("plan", "free")')).toBe(true);

    // And the near-misses it must NOT report, which are the reason it took two
    // passes to get right.
    expect(matchesFixture('.update({ flipdesk_plan: plan })')).toBe(false);
    expect(matchesFixture('case "plan":')).toBe(false);
    expect(matchesFixture('.select("id, flipdesk_plan, role")')).toBe(false);
    expect(matchesFixture('.eq("flipdesk_plan", "pro")')).toBe(false);
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
