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
const DROP_FN =
  /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-zA-Z0-9_]+)"?/gi;

/**
 * The shared guard helper introduced by 00640.
 *
 * A function calling this refuses anyone who is not service_role (or an admin,
 * or — for the 'authenticated' tier — a signed-in user). The helper's own body
 * is asserted below, so routing the check through it cannot become a way to
 * claim a guard without having one.
 */
const GUARD_HELPER = "gt_require_role";

interface Fn {
  files: string[];
  trigger: boolean;
  /** Every definition's source, so a claimed body guard can be verified. */
  bodies: string[];
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
      const entry = out.get(name) ?? { files: [], trigger: false, bodies: [] };
      entry.files.push(f);
      entry.bodies.push(body);
      if (/\)\s*RETURNS\s+trigger\b/i.test(body)) entry.trigger = true;
      out.set(name, entry);
    }
  }
  // A function DROPPED by a LATER migration than its last CREATE is gone from
  // the surface, and leaving it here would keep it on the debt list for ever.
  // 00640 drops increment_grades_used while 00004 still holds the CREATE.
  //
  // ORDER IS THE WHOLE RULE. A first version deleted any name that appeared in
  // any DROP, and removed grant_appstore_credits — which is dropped and then
  // immediately recreated with a changed signature, the ordinary way to alter
  // one. Dropped-then-recreated is not dropped.
  for (const [name, entry] of out) {
    const lastCreate = entry.files[entry.files.length - 1]!;
    const lastDrop = dropsByName().get(name) ?? null;
    if (lastDrop && lastDrop > lastCreate) out.delete(name);
  }
  return out;
}

/**
 * name -> the LAST migration filename that drops it.
 *
 * Built once. The first version was a per-name lookup that re-read all 640
 * migrations for every function it was asked about, which is O(n squared) and
 * timed the suite out at 30s rather than failing on anything real.
 */
let dropIndex: Map<string, string> | null = null;
function dropsByName(): Map<string, string> {
  if (dropIndex) return dropIndex;
  const out = new Map<string, string>();
  for (const f of migrationFiles()) {
    const src = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const m of src.matchAll(DROP_FN)) out.set(m[1]!, f);
  }
  dropIndex = out;
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
/**
 * Functions that enforce the role check INSIDE THE BODY, on purpose, because a
 * REVOKE on them is not a defence — it is a crash.
 *
 * This is a real third state, not a softer debt list. US-2403: denying EXECUTE
 * to a role in supautils.hint_roles segfaults the backend and restarts the
 * database, which is why 00527 is permanently blocked. For a function in public
 * whose arguments all have defaults, an argument-less POST from the anon key
 * that ships in the browser bundle reaches that path — so a REVOKE would not
 * protect the function, it would publish a restart button.
 *
 * The alternative to this list was adding these names to UNGRANTED_DEBT, and
 * that would have been wrong twice: the debt list is SHRINK-ONLY by
 * construction, and these functions are not ungranted-by-oversight, they are
 * guarded-by-a-better-mechanism.
 *
 * VERIFIED, NOT ASSERTED. Membership here is checked against the function's own
 * SQL below: it must raise 42501 unless auth.role() is service_role. An entry
 * that stops guarding itself fails, which is the difference between this and a
 * comment saying "it's fine".
 *
 * See vault/20-domain/postgres-revoke-from-anon-is-a-noop.md.
 */
const BODY_GUARDED = [
  // 00619 / 00620
  "sweep_mcp_tool_calls",
  "sweep_oauth_expired",
  // 00640 (US-2282). Each of these delegates to gt_require_role, whose own
  // body is asserted by "the shared guard helper actually refuses" below.
  "buyer_growth_metrics",
  "channel_attribution",
  "claim_grade_lease",
  "community_benchmarks",
  "get_or_create_source",
  "increment_ai_actions",
  "increment_certificate_view",
  "merge_inventory_items",
  "record_style_code_name",
  "record_style_code_submission",
  "reserve_ai_action",
  "reserve_buyer_meter",
  "style_code_sweep_candidates",
  // 00651-00654 (US-2819..2822). The seller-analytics aggregates. Each carries
  // an explicit GRANT as well, so the first assertion above would pass without
  // these entries; they are here for the SECOND one, which re-reads the newest
  // definition and fails if a future CREATE OR REPLACE drops the guard. These
  // four read platform-wide sale prices to build a cohort, so an unguarded
  // replacement is the one regression worth catching by name.
  "condition_price_curve",
  "flipdesk_price_gap",
  "flipdesk_defect_cost",
  "seller_scorecard",
  // 00658 (US-2827). The only wave-2 aggregate that reads other sellers' rows;
  // its four siblings are SECURITY INVOKER and need no entry.
  "measurement_drift",
];

const UNGRANTED_DEBT = [
  "debit_api_credits",
  "grant_api_credits",
  "grant_appstore_credits",
  "grant_buyer_reward_credit",
  "grant_grade_credits",
  "is_admin",
  "is_reviewer_or_admin",
  "is_super_admin",
  "issue_buyer_reward_credit",
  "redeem_buyer_reward_credit",
  "refund_ai_action",
  "refund_buyer_meter",
  "refund_buyer_reward_credit",
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
      .filter((name) => !BODY_GUARDED.includes(name))
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

  it("every body-guarded function actually guards its body", () => {
    // The assertion that makes BODY_GUARDED a category rather than a second
    // allowlist. A name here claims the function refuses anyone who is not
    // service_role, from inside; this reads the SQL and checks it.
    const fns = securityDefinerFunctions();

    const missing = BODY_GUARDED.filter((name) => !fns.has(name)).sort();
    expect(
      missing,
      `listed as body-guarded but not a SECURITY DEFINER function any more: ` +
        `${missing.join(", ")}. Delete the entries.`,
    ).toEqual([]);

    const unguarded = BODY_GUARDED.filter((name) => {
      const bodies = fns.get(name)?.bodies ?? [];
      // THE NEWEST DEFINITION, which is the one that wins.
      //
      // This said "every definition must guard, not just the newest", on the
      // reasoning that an older unguarded CREATE OR REPLACE is still reachable
      // if it is applied last. Migrations apply in NNNNN order and
      // apply-prod-migrations.sh re-runs the whole directory in that order, so
      // the newest always wins and nothing can apply an older one afterwards.
      //
      // The rule also could not be satisfied. Adding a guard to a function that
      // already exists necessarily creates a SECOND definition, and the older
      // one will never contain the check — so under "every", no function with
      // history could ever join this list. It passed only because the two
      // original entries happened to have exactly one definition each. 00640
      // guards thirteen functions that all have history, which is what exposed
      // it.
      //
      // What the rule was actually protecting against is a future CREATE OR
      // REPLACE that quietly drops the guard. Checking the newest catches that
      // exactly: the new definition becomes the newest, and it fails here.
      const newest = bodies[bodies.length - 1] ?? "";
      const inline = /auth\.role\(\)/i.test(newest) && /42501/.test(newest) &&
        /service_role/i.test(newest);
      const viaHelper = new RegExp(`${GUARD_HELPER}\\s*\\(`, "i").test(newest);
      return !(inline || viaHelper);
    }).sort();
    expect(
      unguarded,
      `these are listed as body-guarded but their SQL does not raise 42501 ` +
        `unless auth.role() is service_role: ${unguarded.join(", ")}. Either ` +
        `add the guard or remove them from BODY_GUARDED — an unchecked entry ` +
        `here is exactly the comment-says-it-is-fine failure this file exists ` +
        `to prevent.`,
    ).toEqual([]);

    // And the two lists stay disjoint: a function is either ungranted debt or
    // deliberately body-guarded, and claiming both hides which one is true.
    const both = BODY_GUARDED.filter((n) => UNGRANTED_DEBT.includes(n)).sort();
    expect(both, `listed in BOTH lists: ${both.join(", ")}`).toEqual([]);
  });

  it("the shared guard helper actually refuses", () => {
    // Thirteen functions delegate their check to gt_require_role, so the check
    // above accepts a call to it as proof of a guard. That is only sound while
    // the helper itself refuses — otherwise the indirection becomes a way to
    // claim a guard without having one, which is the exact failure BODY_GUARDED
    // exists to prevent, one level down.
    const src = migrationFiles()
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .find((s) => new RegExp(`FUNCTION\\s+(?:public\\.)?${GUARD_HELPER}\\s*\\(`, "i").test(s));

    expect(src, `no migration defines ${GUARD_HELPER}, but BODY_GUARDED entries call it`)
      .toBeDefined();

    const def = src!.slice(
      src!.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${GUARD_HELPER}`, "i")),
    );
    // It must raise 42501, and it must decide on the ROLE rather than merely on
    // the presence of a uid — a JWT claiming role=anon while carrying a sub is a
    // shape the client controls.
    expect(def, `${GUARD_HELPER} does not raise 42501`).toMatch(/42501/);
    expect(def, `${GUARD_HELPER} does not check auth.role()`).toMatch(/auth\.role\(\)/i);
    expect(def, `${GUARD_HELPER} does not admit service_role`).toMatch(/service_role/i);
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
