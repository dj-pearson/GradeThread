import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// A Postgres function called from the BROWSER and from the EDGE is answering two
// different questions, and only one of them is the one it was written for.
//
// The browser calls through PostgREST as the signed-in seller: RLS applies and
// auth.uid() is them. The edge calls through the service-role client: RLS is
// BYPASSED and auth.uid() is NULL. So the same function, same arguments, means
// something else depending on who dials it.
//
// ── THE TWO FAILURE MODES, BOTH SILENT ───────────────────────────────────────
//
//   `where user_id = auth.uid()`   returns NOTHING from the edge. A 200 with the
//                                  seller's own half blank, which reads as a
//                                  thin account rather than a bug.
//   SECURITY INVOKER, RLS-scoped   returns EVERYONE from the edge, because
//                                  service-role bypasses the policy that was
//                                  doing the scoping. A cross-tenant read.
//
// The second is the dangerous one and it is live-adjacent: US-2829's analytics
// API and US-2828's weekly digest both want to read the FlipDesk analytics RPCs
// from a job or an endpoint, and three of those (flipdesk_return_attribution,
// flipdesk_source_yield, flipdesk_listing_quality_lift) are SECURITY INVOKER
// with no auth.uid() at all. Written the obvious way, the digest would EMAIL one
// seller another seller's numbers.
//
// ── WHY THIS RULE AND NOT A BROADER ONE ──────────────────────────────────────
//
// Three broader detectors were tried first and each produced confident false
// positives: "body mentions auth.uid()" flagged 20 admin aggregates whose
// auth.uid() sits inside an is_admin() guard; "body has `= auth.uid()`" flagged
// two, both wrong, one because a function body was sliced from one CREATE to the
// next and swallowed an RLS policy in between; "not SECURITY DEFINER" flagged
// eight, all fine because they take an explicit id.
//
// Called-from-both is narrow, derived, and catches the mistake at the moment it
// is made rather than describing every function that could theoretically be
// misused. Two functions qualify today and BOTH are correct — each for a reason
// the SQL states, which is what this asserts rather than listing their names.

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (["node_modules", "build", "dist", ".git", ".gradle"].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isTest = (p: string) =>
  /[\\/]tests?[\\/]|[\\/]__tests__[\\/]|\.test\.[tj]sx?$|_test\.ts$/.test(p);

/** RPC names invoked in a tree, by both the direct and the wrapper call form. */
function calledRpcs(dir: string, exts: RegExp): Set<string> {
  const out = new Set<string>();
  for (const p of walk(resolve(ROOT, dir)).filter((f) => exts.test(f) && !isTest(f))) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/g)) out.add(m[1]!);
    // The typed helper used by the analytics hooks reads `)("name", …)`.
    for (const m of text.matchAll(/\)\(\s*["'`]([a-z0-9_]+)["'`]/g)) out.add(m[1]!);
  }
  return out;
}

const MIGRATIONS = resolve(ROOT, "supabase/migrations");
const migrationSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

/**
 * A function's declaration and body, bounded by its own `$tag$ … $tag$`.
 *
 * ⚠ NOT "from this CREATE to the next one". That slicing attributed an RLS
 * POLICY's predicate to the function above it and produced a false finding
 * earlier today. The dollar-quoted body is the actual boundary.
 */
function functionText(name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${name}\\s*\\(`,
    "gi",
  );
  // THE LAST DEFINITION WINS, because that is what Postgres ends up holding.
  //
  // ⚠ THIS TOOK THE LONGEST ONE AT FIRST, and sabotage caught it. Both functions
  // that qualify here are redefined later — get_or_create_source in 00640,
  // admin_audit_log_search in 00517 and again in 00518 — so breaking the FIRST
  // definition left a longer, later one still satisfying the check, and the
  // guard reported nothing. "Longest" is not a proxy for "current"; the
  // migrations are concatenated in sorted order, so the last match is.
  let last = "";
  for (const m of migrationSql.matchAll(re)) {
    const from = m.index!;
    const tag = /\$([a-z_]*)\$/i.exec(migrationSql.slice(from, from + 4000));
    if (!tag) continue;
    const open = from + tag.index! + tag[0].length;
    const close = migrationSql.indexOf(tag[0], open);
    last = migrationSql.slice(from, close === -1 ? from + 4000 : close);
  }
  return last;
}

/** Takes the caller's identity as an ARGUMENT rather than reading it. */
const takesExplicitUser = (text: string) =>
  /\bp_(user_id|owner_id|seller_id|buyer_id)\s+uuid/i.test(text);

/**
 * BRANCHES on being called by the service role, so it knows which mode it is in.
 *
 * ⚠ A BRANCH, NOT A MENTION. The first version accepted a bare `v_is_service`
 * anywhere in the body, and sabotage walked straight through it: deleting the
 * `if not v_is_service then` guard left the variable's own ASSIGNMENT behind,
 * which still matched. That is the same shape as an import satisfying a
 * call check (vault/70-agent/guards-that-cannot-fail.md shape 8) — a name in
 * scope is not a decision taken.
 */
const branchesOnServiceRole = (text: string) =>
  /\bif\s+(?:not\s+)?\(?\s*v_is_service\b/i.test(text) ||
  /\bif\s+[^;]{0,80}auth\.role\(\)\s*=\s*'service_role'/i.test(text) ||
  /\breturn\s+[^;]{0,80}auth\.role\(\)\s*=\s*'service_role'/i.test(text);

describe("an RPC called from both the browser and the edge means two things", () => {
  const browser = calledRpcs("src", /\.(ts|tsx)$/);
  const edge = calledRpcs("services/edge-functions/src", /\.ts$/);
  const dual = [...browser].filter((n) => edge.has(n)).sort();

  it("both call sites parsed", () => {
    // Guards the guard: an empty set on either side makes the intersection
    // empty and every assertion below vacuous.
    expect(browser.size, "no browser RPC calls found").toBeGreaterThan(15);
    expect(edge.size, "no edge RPC calls found").toBeGreaterThan(40);
    expect(migrationSql.length, "no migrations read").toBeGreaterThan(100000);
  });

  it("the rule is not vacuous — some function IS called from both", () => {
    // If this ever becomes empty the rule stops protecting anything, and a
    // green run would mean "nobody does this" rather than "everybody does it
    // safely". Those are different and only one of them is worth knowing.
    expect(
      dual.length,
      "no RPC is called from both sides any more, so this guard is inert",
    ).toBeGreaterThan(0);
  });

  it("every dual-called function is explicit about whose rows it means", () => {
    // The JUSTIFICATION is derived, not a list of blessed names: a function is
    // safe from both sides when it takes the user as an argument, or when it
    // branches on the service role so it knows which caller it has.
    const unsafe: string[] = [];
    for (const name of dual) {
      const text = functionText(name);
      if (!text) {
        unsafe.push(`${name} (no CREATE OR REPLACE found to check)`);
        continue;
      }
      if (takesExplicitUser(text) || branchesOnServiceRole(text)) continue;
      unsafe.push(name);
    }
    expect(
      unsafe,
      "a Postgres function is called from the browser AND from the edge without " +
        "saying whose rows it means. From the browser it is the signed-in seller; " +
        "from the edge, RLS is bypassed and auth.uid() is NULL — so it either " +
        "returns nothing or returns EVERYONE. Give it a p_user_id argument, or " +
        "branch on auth.role() = 'service_role'.",
    ).toEqual([]);
  });

  it("the body slicer finds a real function body", () => {
    // The parser has been wrong before. Pin it against a function whose shape is
    // known, so a slicer that starts returning "" cannot make the case above
    // pass by finding nothing to object to.
    const text = functionText("get_or_create_source");
    expect(text.length, "get_or_create_source did not parse").toBeGreaterThan(200);
    expect(takesExplicitUser(text), "the explicit-user check stopped matching").toBe(true);
    expect(branchesOnServiceRole(text), "false positive on the service-role check").toBe(false);
  });
});
