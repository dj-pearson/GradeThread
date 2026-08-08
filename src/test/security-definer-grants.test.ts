// US-2282 AC4: a new SECURITY DEFINER function must ship with an explicit
// grant decision, not inherit one.
//
// WHY THIS IS NOT THE OBVIOUS RULE. The intuition is "Postgres grants EXECUTE
// to PUBLIC by default, so revoke it." On a Supabase stack that is wrong, and
// US-2282's own investigation proved it by reading pg_proc.proacl on a live
// database: grant_grade_credits carried DIRECT grants to `anon` and
// `authenticated`, granted by `postgres`, from Supabase's own
// ALTER DEFAULT PRIVILEGES bootstrap. PUBLIC did not appear in the ACL at all,
// so `REVOKE ... FROM PUBLIC` changed nothing on exactly the functions that
// mattered. A migration that looks like a security fix and does nothing is
// worse than no migration.
//
// The consequence for THIS test: silence in a migration is not "closed", it is
// "open to anon and authenticated". A SECURITY DEFINER function runs as its
// OWNER — it is the one construct in the schema that can deliberately bypass
// RLS — so a callable one that never states who may call it is granted to the
// browser by a default nobody wrote down.
//
// TRIGGER FUNCTIONS ARE EXEMPT, and that is a real distinction rather than a
// convenience. A `RETURNS trigger` function is invoked by the trigger machinery
// as part of the statement that fired it; EXECUTE on it is not consulted and a
// grant would be noise. 15 of the 83 are this shape.
//
// The runtime lockdown itself (migration 00527) is written and parked as
// .BLOCKED on US-2403 — a Postgres segfault on function-permission denial for
// roles in supautils.hint_roles. This test is the half that does NOT need that
// unblocked: it stops the debt growing while the fix waits.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";

const CREATE_FN =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-zA-Z0-9_]+)"?\s*\(/gi;
const GRANT_FN =
  /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(?:public\.)?"?([a-zA-Z0-9_]+)"?/gi;
const REVOKE_FN =
  /REVOKE\s+(?:ALL|EXECUTE)[^;]*?\s+ON\s+FUNCTION\s+(?:public\.)?"?([a-zA-Z0-9_]+)"?/gi;

interface Fn {
  files: string[];
  trigger: boolean;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Every distinct SECURITY DEFINER function in the corpus, and whether any of
 * its definitions is a trigger function.
 *
 * EACH DEFINITION IS BOUNDED BY THE NEXT `CREATE FUNCTION`, not by a character
 * count. A fixed window is what a first draft reaches for and it was wrong
 * here: 2500 characters from grant_grade_credits (00037:180) runs straight into
 * handle_new_user (00037:233), whose `RETURNS TRIGGER` then made a
 * credit-granting RPC read as an exempt trigger function. That is precisely the
 * misclassification this whole test exists to prevent, produced by the test
 * itself — and the landmark assertions below are what caught it.
 *
 * SECURITY DEFINER may sit before or after the body, so the slice has to cover
 * the whole definition; the next CREATE FUNCTION is where one definition
 * provably ends.
 */
function securityDefinerFunctions(): Map<string, Fn> {
  const out = new Map<string, Fn>();
  for (const f of migrationFiles()) {
    const src = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    const starts = [...src.matchAll(CREATE_FN)];
    for (let i = 0; i < starts.length; i++) {
      const m = starts[i]!;
      const end = starts[i + 1]?.index ?? src.length;
      const body = src.slice(m.index, end);
      if (!/SECURITY\s+DEFINER/i.test(body)) continue;
      const name = m[1]!;
      const entry = out.get(name) ?? { files: [], trigger: false };
      entry.files.push(f);
      if (/\)\s*RETURNS\s+trigger\b/i.test(body)) entry.trigger = true;
      out.set(name, entry);
    }
  }
  return out;
}

function namesMatching(re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const f of migrationFiles()) {
    const src = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const m of src.matchAll(re)) out.add(m[1]!);
  }
  return out;
}

/**
 * Callable SECURITY DEFINER functions that state nothing about who may execute
 * them, and therefore run on Supabase's anon+authenticated default.
 *
 * SHRINK-ONLY. This is the pre-existing debt US-2282 found, enumerated so it is
 * visible rather than tolerated. A name may leave this list (by gaining a GRANT
 * or REVOKE) and the test then FAILS until the entry is deleted in the same
 * commit — so the ground gained cannot be quietly given back. A name may never
 * be ADDED without someone editing this file and reading the paragraph above.
 *
 * Seven of these move money or credits — grant_grade_credits, grant_api_credits,
 * debit_api_credits, grant_appstore_credits, grant_buyer_reward_credit,
 * issue_buyer_reward_credit, redeem_buyer_reward_credit — and grant_grade_credits
 * is the one US-2282 measured on a live database, where it really did carry
 * EXECUTE for anon. Three more are the RLS predicates themselves
 * (is_admin, is_reviewer_or_admin, is_super_admin), which is a different and
 * sharper problem: a function called inside an RLS policy runs as the QUERYING
 * role, so is_admin has always worked ONLY because of the default this debt
 * describes. Removing that default without granting is_admin explicitly would
 * break 29 migrations' policies at once. 00527 handles exactly that; do not
 * hand-revoke these one at a time.
 */
const UNGRANTED_DEBT = [
  "claim_grade_lease",
  "debit_api_credits",
  "grant_api_credits",
  "grant_appstore_credits",
  "grant_buyer_reward_credit",
  "grant_grade_credits",
  "increment_ai_actions",
  "increment_grades_used",
  "is_admin",
  "is_reviewer_or_admin",
  "is_super_admin",
  "issue_buyer_reward_credit",
  "redeem_buyer_reward_credit",
  "refund_ai_action",
  "refund_buyer_meter",
  "refund_buyer_reward_credit",
  "reserve_ai_action",
  "reserve_buyer_meter",
];

describe("US-2282 AC4: SECURITY DEFINER functions declare who may execute them", () => {
  it("the scanner finds the functions it is checking", () => {
    // Guard the guard. If CREATE FUNCTION formatting drifts, or the window
    // stops reaching the option list, every assertion below passes by finding
    // nothing — the same vacuous-green failure the admin scope guard had.
    const fns = securityDefinerFunctions();
    expect(fns.size).toBeGreaterThanOrEqual(80);
    // Known landmarks, one of each shape.
    expect(fns.get("grant_grade_credits")?.trigger).toBe(false);
    expect(fns.get("handle_new_user")?.trigger).toBe(true);
    expect(fns.get("stamp_audit_actor")?.trigger).toBe(true);

    const trigger = [...fns.values()].filter((f) => f.trigger).length;
    expect(trigger).toBeGreaterThanOrEqual(15);
    expect(trigger).toBeLessThan(fns.size);
  });

  it("no NEW callable SECURITY DEFINER function ships without a grant or revoke", () => {
    const fns = securityDefinerFunctions();
    const granted = namesMatching(GRANT_FN);
    const revoked = namesMatching(REVOKE_FN);

    const undeclared = [...fns.entries()]
      .filter(([, v]) => !v.trigger)
      .map(([name]) => name)
      .filter((name) => !granted.has(name) && !revoked.has(name))
      .filter((name) => !UNGRANTED_DEBT.includes(name))
      .sort();

    expect(
      undeclared,
      `These SECURITY DEFINER functions are callable and no migration says who ` +
        `may execute them, so they run on Supabase's anon+authenticated default ` +
        `— from the browser, with RLS bypassed: ${undeclared.join(", ")}. ` +
        `Add an explicit GRANT EXECUTE ... TO service_role (or the role that ` +
        `actually calls it) in the same migration, plus a REVOKE from anon and ` +
        `authenticated if it should not be reachable from a client. ` +
        `REVOKE ... FROM PUBLIC alone is a NO-OP here — see the header. (US-2282 AC4)`,
    ).toEqual([]);
  });

  it("the ungranted-debt list is shrink-only", () => {
    const fns = securityDefinerFunctions();
    const granted = namesMatching(GRANT_FN);
    const revoked = namesMatching(REVOKE_FN);

    const gone = UNGRANTED_DEBT.filter((n) => !fns.has(n)).sort();
    expect(
      gone,
      `listed as ungranted debt but no longer a SECURITY DEFINER function: ` +
        `${gone.join(", ")}. Delete the entries.`,
    ).toEqual([]);

    const fixed = UNGRANTED_DEBT
      .filter((n) => granted.has(n) || revoked.has(n))
      .sort();
    expect(
      fixed,
      `these now carry an explicit grant or revoke: ${fixed.join(", ")}. ` +
        `Delete them from UNGRANTED_DEBT in the same commit, or the list stops ` +
        `describing anything and the next reader cannot tell which entries are ` +
        `still real.`,
    ).toEqual([]);
  });
});
