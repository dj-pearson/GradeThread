// US-2282: the authorization guard that lets anonymous callers straight through.
//
// THE SHAPE:
//
//     if auth.uid() is not null and not public.is_admin() then
//       raise exception '…: admin role required' using errcode = '42501';
//     end if;
//
// An ANONYMOUS caller has no `auth.uid()`. The condition is false, no exception
// fires, and the function returns its document. It only ever constrained users
// who were signed IN — the population least likely to be the attacker. And it
// reads as a real check, which is why six functions shipped with it and passed
// review.
//
// Measured against PRODUCTION on 2026-08-17 with nothing but the anon key that
// ships in the browser bundle: ai_spend, ai_profitability, funnel_metrics,
// retention_cohorts and ai_budget_status all answered 200 with real numbers, and
// reconciliation_candidates answered 200 with USER EMAIL ADDRESSES.
//
// THE CORRECT FORM is a positive allowlist — you are the service role, or an
// admin, or you are refused:
//
//     if not (auth.role() = 'service_role' or public.is_admin()) then
//
// WHY A SOURCE SCAN AND NOT A DATABASE CHECK. `check-rpc-column-refs.mjs`
// executes functions and needs Docker; this needs neither, so it runs in the
// cheap web lane on every push. The database half is covered by 00611 having
// been applied and verified.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(process.cwd(), "supabase/migrations");

/** The defect, as it appears in SQL. */
const PERMISSIVE = /if\s+auth\.uid\(\)\s+is\s+not\s+null\s+and\s+not\s+public\.is_admin\(\)/i;

/**
 * Migrations that shipped the shape before 00611 closed it.
 *
 * Applied migrations are IMMUTABLE, so these cannot be edited — they are fixed
 * forward, and 00611 is the fix. Pinned by FILE so a NEW migration reusing the
 * shape fails even though history does not. The list may only shrink: an entry
 * that stops matching fails too, mirroring KNOWN_GAPS in migrations-lint.
 */
const GRANDFATHERED = new Set(
  readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 5)) < 611)
    .filter((f) => PERMISSIVE.test(readFileSync(join(DIR, f), "utf8"))),
);

describe("US-2282: no NEW migration may ship the permissive admin guard", () => {
  it("history is grandfathered, and there is some of it", () => {
    // If this hits zero the rule below is vacuous and somebody should notice,
    // rather than the suite going quietly green forever.
    expect(GRANDFATHERED.size).toBeGreaterThan(0);
  });

  it("nothing at or after 00611 uses it", () => {
    const offenders = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 5)) >= 611)
      .filter((f) => {
        const sql = readFileSync(join(DIR, f), "utf8");
        // Comment lines only quote it to EXPLAIN it — 00611's own header does,
        // and a whole-file scan reads that as the defect surviving. That false
        // positive fired three times in one session before being scoped out.
        const code = sql
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("--"))
          .join("\n");
        return PERMISSIVE.test(code);
      });
    expect(
      offenders,
      `these migrations use the permissive guard, which lets an ANONYMOUS caller ` +
        `through — auth.uid() is null for anon, so the condition is false and no ` +
        `exception fires. Use the allowlist instead:\n` +
        `  if not (auth.role() = 'service_role' or public.is_admin()) then`,
    ).toEqual([]);
  });

  it("00614 replaced it with the allowlist in every function it touches", () => {
    const sql = readFileSync(join(DIR, "00614_analytics_rpc_allowlist.sql"), "utf8");
    const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(PERMISSIVE.test(code)).toBe(false);
    // Six functions, six allowlists. A count, not a presence check: one correct
    // guard in a six-function migration would satisfy "contains".
    expect((code.match(/auth\.role\(\) = 'service_role'/g) ?? []).length).toBe(6);
    // And it must not reach for a REVOKE — a denied call segfaults this
    // Postgres image (US-2403), which is why 00527 is a permanent do-not-apply.
    expect(/^\s*revoke\b/im.test(code)).toBe(false);
  });

  it("00615 guards all nine credit functions, which had NO check at all", () => {
    // A DIFFERENT defect from 00611's six. Those had a guard that was wrong;
    // these had none and relied entirely on the CREATE FUNCTION grant to
    // PUBLIC. The exploit was demonstrated, not theorised: an anonymous caller
    // moved a real grade-credit balance 0 → 999.
    const sql = readFileSync(
      join(DIR, "00615_credit_functions_service_role_only.sql"),
      "utf8",
    );
    const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    // Counted, not merely present: one correct guard in a nine-function
    // migration would satisfy a contains-check while eight stayed open.
    expect((code.match(/auth\.role\(\) = 'service_role'/g) ?? []).length).toBe(9);
    expect(/^\s*revoke\b/im.test(code)).toBe(false);
    // Every guard must name its own function, or a failure in production says
    // "service role required" without saying which call was refused.
    expect((code.match(/: service role required/g) ?? []).length).toBe(9);
  });

  it("00616 converts two SQL functions to plpgsql so they CAN be guarded", () => {
    // The third defect shape. These were LANGUAGE sql: no block to raise from,
    // so the one-line insertion that closed the other fifteen does not apply.
    //
    // IT WAS SIX UNTIL 2026-08-17. origin/main's 00611 landed first doing the
    // same conversion to data_integrity_scan, north_star_weekly_counts,
    // north_star_lifetime_counts and refund_snap. Two migrations CREATE OR
    // REPLACE-ing one function is worse than an error — whichever applies last
    // silently wins — so those four were removed here and 00611 owns them.
    // drip_analytics and newsletter_analytics are the two 00611 does not touch.
    const sql = readFileSync(
      join(DIR, "00616_sql_functions_service_role_only.sql"),
      "utf8",
    );
    const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect((code.match(/auth\.role\(\) = 'service_role'/g) ?? []).length).toBe(2);
    expect((code.match(/LANGUAGE plpgsql/g) ?? []).length).toBe(2);
    // The conversion is the point: a leftover LANGUAGE sql cannot hold a guard.
    expect(/LANGUAGE sql\b/.test(code)).toBe(false);
    expect(/^\s*revoke\b/im.test(code)).toBe(false);
    // SECURITY DEFINER and search_path must survive the language change, or the
    // function starts running as the caller and the guard becomes moot.
    expect((code.match(/SECURITY DEFINER/g) ?? []).length).toBe(2);
    expect((code.match(/SET search_path/g) ?? []).length).toBe(2);
  });

  it("peek_workspace_invitation is never guarded — the browser calls it", () => {
    // It is in the same unguarded set and must STAY that way: accept-invite.tsx
    // calls it before the user has an account, gated by a capability token
    // rather than by identity. A role check would break invitation acceptance.
    for (const f of ["00615_credit_functions_service_role_only.sql", "00616_sql_functions_service_role_only.sql"]) {
      const sql = readFileSync(join(DIR, f), "utf8");
      const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
      expect(code, `${f} must not guard peek_workspace_invitation`)
        .not.toContain("FUNCTION public.peek_workspace_invitation");
    }
  });
});
