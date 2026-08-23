import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// A SECURITY DEFINER function callable by the browser must decide WHO is asking.
//
// DEFINER is the one construct in this schema that deliberately bypasses RLS: it
// runs as its owner, so the policies that scope every other read do not apply.
// Grant EXECUTE on one to `authenticated` and any logged-in account can call it.
// That is fine — most of them are exactly this by design — PROVIDED the function
// itself establishes who the caller is. Three ways count, and each is a real
// pattern already in the corpus:
//
//   ROLE-GUARDED   gt_require_role(...) (00640), or an is_admin() /
//                  is_super_admin() / auth.role() = 'service_role' check.
//   CALLER-SCOPED  the body filters on auth.uid(), so it can only ever return
//                  or touch the caller's own rows.
//   EXPLICIT ARG   it takes p_user_id and the caller passes one, which makes it
//                  the CALLER's job to be authorised — the shape
//                  get_or_create_source uses.
//
// A function with none of the three runs as owner, unscoped, for anyone with an
// account. Today exactly one qualifies and it is deliberate; this holds the
// count there.
//
// ── WHY THE EXISTING GUARDS DO NOT COVER THIS ────────────────────────────────
//
// security-definer-grants.test.ts (US-2282) asks whether a grant DECISION was
// written down — silence means "open to anon and authenticated" on this stack,
// so it makes the decision explicit. It does not ask what the body does.
// rls-guard_test.ts holds policies to the initplan form and classifies
// zero-policy tables. Neither reads a DEFINER body for a caller check.
//
// ⚠ BOTH auth.uid() FORMS, AND THAT IS THE WHOLE TRAP. Migration 00451 rewrote
// every hot-path `auth.uid()` into `(select auth.uid())` so the planner hoists
// it to one InitPlan. A detector matching only `= auth.uid()` therefore misses
// precisely the functions that migration touched — when this sweep was first
// run it reported is_workspace_member and is_workspace_member_with_role as
// unguarded, and both scope by `member_id = (select auth.uid())`. Two false
// positives out of three findings, from the one migration most likely to be
// involved.

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");
const FILES = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const ALL_SQL = FILES.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");

/**
 * Every function's LAST definition, bounded by its own dollar tag.
 *
 * Last, not longest and not first: a function re-created in a later migration is
 * what the database holds. Bounded by `$tag$` rather than by "up to the next
 * CREATE", because that slicing swallows any RLS policy or GRANT sitting
 * between two functions and attributes it to the one above.
 */
function currentDefinitions(): Map<string, { text: string; file: string }> {
  const out = new Map<string, { text: string; file: string }>();
  for (const f of FILES) {
    const s = readFileSync(join(MIGRATIONS, f), "utf8");
    const re = /create\s+or\s+replace\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
    for (const m of s.matchAll(re)) {
      const from = m.index!;
      const tag = /\$([a-z_]*)\$/i.exec(s.slice(from, from + 6000));
      if (!tag) continue;
      const open = from + tag.index! + tag[0].length;
      const close = s.indexOf(tag[0], open);
      out.set(m[1]!.toLowerCase(), {
        text: s.slice(from, close === -1 ? from + 6000 : close),
        file: f,
      });
    }
  }
  return out;
}

function grantsByFunction(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of ALL_SQL.matchAll(
    /grant\s+execute\s+on\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\([^)]*\)\s*to\s+([a-z_,\s]+)/gi,
  )) {
    const name = m[1]!.toLowerCase();
    const set = out.get(name) ?? new Set<string>();
    for (const r of m[2]!.split(",").map((x) => x.trim().toLowerCase())) set.add(r);
    out.set(name, set);
  }
  return out;
}

const head = (t: string) => t.slice(0, 1500);
const isDefiner = (t: string) => /security\s+definer/i.test(head(t));
/**
 * A trigger function is invoked by the trigger machinery, not called; EXECUTE
 * is not consulted for it.
 *
 * ⚠ DEFENSIVE AND CURRENTLY INERT, which is worth stating rather than leaving
 * it looking load-bearing. Measured: the corpus has 39 trigger functions and
 * ZERO of them are granted to anon or authenticated, so they never reach the
 * set this filters. Sabotage removing this line changes no result.
 *
 * It stays because the grant filter and this one answer different questions,
 * and a stray `GRANT EXECUTE ON FUNCTION some_trigger_fn() TO authenticated` —
 * harmless, and the sort of thing a copied migration produces — would
 * otherwise put a trigger body in front of a caller check it cannot satisfy.
 */
const isTrigger = (t: string) => /returns\s+trigger/i.test(head(t));

const roleGuarded = (t: string) =>
  /gt_require_role\s*\(/i.test(t) ||
  /auth\.role\(\)\s*=\s*'service_role'/i.test(t) ||
  /\b(is_admin|is_super_admin|is_reviewer_or_admin)\s*\(\)/i.test(t);

/** BOTH forms — see the trap in the header. */
const callerScoped = (t: string) =>
  /=\s*auth\.uid\(\)/i.test(t) ||
  /auth\.uid\(\)\s*=/i.test(t) ||
  /=\s*\(\s*select\s+auth\.uid\(\)\s*\)/i.test(t) ||
  /\(\s*select\s+auth\.uid\(\)\s*\)\s*=/i.test(t);

const takesUserArg = (t: string) =>
  /p_(user_id|owner_id|seller_id|buyer_id)\s+uuid/i.test(head(t));

/**
 * Callable by the browser, DEFINER, and deliberately without a caller check.
 *
 * SHRINK-ONLY: an entry that gains a check must be removed, so this cannot
 * become where unguarded functions go to be forgotten.
 */
const NO_CALLER_CHECK_ON_PURPOSE: Record<string, string> = {
  peek_workspace_invitation:
    "Reads one invitation by its TOKEN, and the token is the authorisation. The " +
    "caller is by definition not yet a member of the workspace — they are " +
    "deciding whether to accept — so there is no membership to check and " +
    "auth.uid() may be null. rls-guard_test.ts records the same exemption from " +
    "the other side: 'never guarded — the browser calls it'.",
};

describe("a browser-callable SECURITY DEFINER function decides who is asking", () => {
  const defs = currentDefinitions();
  const grants = grantsByFunction();

  const browserCallable = [...grants]
    .filter(([, roles]) => roles.has("authenticated") || roles.has("anon"))
    .map(([name]) => name)
    .filter((name) => {
      const d = defs.get(name);
      return d !== undefined && isDefiner(d.text) && !isTrigger(d.text);
    });

  it("the corpus parsed and the set is not empty", () => {
    // Guards the guard. An empty set makes every assertion below vacuous, and
    // the body slicer has been wrong before.
    //
    // 166 distinct functions parse today. The floor is 100 rather than 165
    // because this is asking 'did the parse work at all', not policing the
    // corpus size — a schema that legitimately loses a few functions should not
    // redden a security check. I first wrote 200 by guessing and it failed on
    // the real number, which is the right way round for a floor to be wrong.
    expect(FILES.length).toBeGreaterThan(100);
    expect(defs.size, "no function definitions parsed").toBeGreaterThan(100);
    expect(
      browserCallable.length,
      "no browser-callable DEFINER functions found — the grant or definer parse broke",
    ).toBeGreaterThan(15);
  });

  it("BOTH auth.uid() forms are recognised", () => {
    // The false positive that made this file worth writing. 00451 rewrote the
    // hot-path calls into the subquery form; a detector that only knows the
    // bare form reports exactly those functions as unguarded.
    expect(callerScoped("where member_id = auth.uid()")).toBe(true);
    expect(callerScoped("where member_id = (select auth.uid())")).toBe(true);
    expect(callerScoped("select (select auth.uid()) = workspace_owner")).toBe(true);
    expect(callerScoped("select 1 from t where x = 2")).toBe(false);
    // And a real one from the corpus, so the unit cases cannot drift from it.
    const wm = defs.get("is_workspace_member_with_role");
    expect(wm, "is_workspace_member_with_role is gone").toBeDefined();
    expect(callerScoped(wm!.text)).toBe(true);
  });

  it("every one of them checks the caller, except the named exception", () => {
    const unchecked = browserCallable
      .filter((name) => {
        const t = defs.get(name)!.text;
        return !roleGuarded(t) && !callerScoped(t) && !takesUserArg(t);
      })
      .sort();

    expect(
      unchecked,
      "a SECURITY DEFINER function is granted to anon or authenticated and never " +
        "establishes who the caller is. It runs as its OWNER, so RLS does not " +
        "apply, and any logged-in account can call it. Add a gt_require_role or " +
        "is_admin guard, scope the body on auth.uid(), or take p_user_id — or add " +
        "it to NO_CALLER_CHECK_ON_PURPOSE with the reason.",
    ).toEqual(Object.keys(NO_CALLER_CHECK_ON_PURPOSE).sort());
  });

  it("the exemption can only shrink, and each entry is real", () => {
    for (const [name, why] of Object.entries(NO_CALLER_CHECK_ON_PURPOSE)) {
      const d = defs.get(name);
      expect(d, `${name} is exempt but no longer defined`).toBeDefined();
      expect(why.length, `${name} has no real reason recorded`).toBeGreaterThan(60);
      const t = d!.text;
      expect(
        roleGuarded(t) || callerScoped(t) || takesUserArg(t),
        `${name} now checks its caller — remove it from NO_CALLER_CHECK_ON_PURPOSE`,
      ).toBe(false);
    }
  });
});
