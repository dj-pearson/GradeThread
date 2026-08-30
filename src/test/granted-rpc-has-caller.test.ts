import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// US-2814 AC5: every Postgres function GRANTed to a caller is actually called.
//
// A granted function that nothing calls is not free. public.inventory_distinct_brands
// (migration 00482) is the case that prompted this: it was written for the
// Inventory brand dropdown, US-958 rewrote that page into a lazy view router,
// the dropdown went with it, and the function stayed. So did
// idx_inventory_items_user_brand, which exists only to support its DISTINCT scan
// and is now maintained on every inventory_items insert and every brand update
// for a reader that does not exist.
//
// Nothing noticed for months, because a dead RPC looks exactly like a live one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ALLOWLIST IS ONE ENTRY AND MUST STAY SMALL
//
// AC5 makes that a condition rather than a hope: "a guard with 30 exemptions
// guards nothing". If this list grows past a handful, the honest move is to
// delete the guard rather than keep feeding it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A CALLER LOOKS LIKE, and why this does not just grep for `.rpc("name")`
//
// A first pass that matched only `.rpc("name")` over src/ reported NINE dead
// functions. Eight were artifacts, from three distinct causes, and each is
// handled below:
//
//   Swift callers      create_listing_template and update_listing_template are
//                      called from ios/GradeThread/Templates/TemplateService.swift
//                      and from nowhere in TypeScript.
//   a wrapper form     inventory_status_counts, peek_workspace_invitation,
//                      recent_searches and record_search go through a typed
//                      helper and read `)("name", { … })`, so the literal
//                      `.rpc(` never appears next to the name.
//   SQL-internal use   a function called only by another function has no client
//                      caller at all and is not dead.
//
// So the test is "does the name appear as a quoted string in any non-test client
// source, or inside another function's SQL body". Broad on purpose: the question
// is whether anything at all reaches this function, and a false negative here
// costs a real index for a real amount of time.
//
// TEST FILES ARE EXCLUDED, which is the other half of the same point. A
// revoke-gate test naming a function keeps it looking alive after its last real
// caller is deleted, and that is precisely the state this guard exists to catch.

const ROOT = process.cwd();
const CLIENT_TREES = [
  "src",
  "services/edge-functions/src",
  "functions",
  "ios",
  "android/app/src",
];
const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".git", ".gradle", "__snapshots__"]);
const SOURCE = /\.(ts|tsx|swift|kt)$/;
const TEST_PATH =
  /[\\/]tests?[\\/]|[\\/]__tests__[\\/]|\.test\.[tj]sx?$|_test\.ts$|Test\.kt$|Tests\.swift$/;

/**
 * Granted but deliberately uncalled. Shrink-only: an entry that gains a caller
 * must be REMOVED, or this becomes the place dead functions go to be forgotten.
 */
const UNCALLED_ON_PURPOSE: Record<string, string> = {
  // EMPTY, and it got here the right way round. inventory_distinct_brands came
  // OFF this list on 2026-08-23: the owner chose to drop it rather than keep it
  // unwired, so 00661 drops the function and idx_inventory_items_user_brand with
  // it, and `droppedForGood` now excludes it from the granted set entirely.
  //
  // An entry left behind here would have been worse than none: it would still
  // read as a live decision about a function that no longer exists, and the next
  // sweep would have to re-derive that nothing is wrong.
  //
  // ⚠ AND THEN IT GOT ONE BACK, 2026-08-29, WHICH IS THE WEAKER OUTCOME.
  sale_platform:
    "00691 (US-2987) ships it granted to authenticated and service_role, and " +
    "NOTHING calls it - not the edge, not src/, not another migration. The tax " +
    "branch it was written for resolves the platform without it. So it is a " +
    "helper that arrived ahead of its caller, and its own header points at " +
    "US-2992's review queue as where the NULL-platform sales get surfaced, " +
    "which is the likeliest home for it.\n" +
    "\n" +
    "THIS ENTRY CONTRADICTS THE PARAGRAPH ABOVE and is deliberately marked as " +
    "such. The precedent set on 2026-08-23 was to DROP an unwired function " +
    "rather than excuse it, and that is still the better answer here. It is " +
    "not taken because the function is another agent's, written minutes " +
    "earlier in a story still in flight, and dropping someone's work to " +
    "unbreak a build is the wrong trade. Wire it in US-2992 or drop it with " +
    "its grants in one migration - either way this entry comes back out, and " +
    "it should not survive that story.",
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(p)) out.push(p);
  }
  return out;
}

const migrationsDir = resolve(ROOT, "supabase/migrations");
const migrationSql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

/** name -> roles it is granted EXECUTE to, across every migration. */
function grantedFunctions(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of migrationSql.matchAll(
    /grant\s+execute\s+on\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(([^)]*)\)\s*to\s+([a-z_,\s]+)/gi,
  )) {
    const name = m[1]!.toLowerCase();
    const roles = m[3]!
      .split(",")
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
    const set = out.get(name) ?? new Set<string>();
    for (const r of roles) set.add(r);
    out.set(name, set);
  }
  return out;
}

/**
 * True when the function's last DROP comes after its last CREATE.
 *
 * Thirteen functions in the corpus are dropped at some point, almost always to
 * change a signature and re-create immediately. Only a drop that STICKS means
 * the function is gone, and a gone function cannot be a dead one.
 */
function droppedForGood(name: string): boolean {
  const lastCreate = lastIndexOfMatch(
    new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${name}\\s*\\(`, "gi"),
  );
  const lastDrop = lastIndexOfMatch(
    new RegExp(`drop\\s+function\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${name}\\b`, "gi"),
  );
  return lastDrop > lastCreate;
}

function lastIndexOfMatch(re: RegExp): number {
  let last = -1;
  for (const m of migrationSql.matchAll(re)) last = m.index!;
  return last;
}

/** Called from another function's SQL body, rather than by a client. */
function calledFromSql(name: string): boolean {
  const re = new RegExp(`(?:^|[^a-z0-9_.])(?:public\\.)?${name}\\s*\\(`, "gi");
  for (const m of migrationSql.matchAll(re)) {
    const before = migrationSql.slice(Math.max(0, m.index! - 220), m.index!).toLowerCase().trimEnd();
    if (/create\s+(or\s+replace\s+)?function$/.test(before)) continue;
    if (/on\s+function$/.test(before)) continue; // COMMENT ON / GRANT ON / REVOKE ON
    if (/drop\s+function(\s+if\s+exists)?$/.test(before)) continue;
    return true;
  }
  return false;
}

const clientFiles = CLIENT_TREES.flatMap((t) => walk(resolve(ROOT, t)));
const productionFiles = clientFiles.filter((p) => !TEST_PATH.test(p));
const productionText = productionFiles.map((p) => readFileSync(p, "utf8")).join("\n");

/**
 * A call site quotes the function name. Double or single quotes only.
 *
 * ⚠ NOT BACKTICKS, and this is the bug the first draft shipped with. In TS,
 * Swift and Kotlin comments a backticked name is MARKDOWN PROSE, not code, and
 * counting it made the guard fire on the documentation written about the
 * function rather than on any caller. use-inventory-status-counts.ts is the
 * case that proved it: deleting BOTH real call sites left the guard green,
 * because its header comment says "Backed by the `inventory_status_counts`
 * RPC". A function whose last caller is deleted but whose docstring survives
 * is exactly the state this guard exists to catch, so it was blind to its own
 * subject.
 *
 * Dropping the branch is safe because no backtick-literal RPC call exists
 * anywhere in the repo, which the case below asserts rather than assumes.
 *
 * Residual, stated rather than hidden: a name in DOUBLE quotes inside a
 * comment still counts. That is rarer (prose quotes names in backticks here,
 * by convention) and stripping comments across four languages would cost more
 * correctness than it buys.
 */
const quotedIn = (text: string, name: string) =>
  text.includes(`"${name}"`) || text.includes(`'${name}'`);

describe("US-2814: every granted Postgres function has a caller", () => {
  const granted = grantedFunctions();

  it("the sweep actually parsed something", () => {
    // Guards the guard. Every assertion below is vacuously true against an empty
    // grant map or an empty file list, and both are one bad regex away.
    expect(granted.size, "no GRANT EXECUTE statements parsed").toBeGreaterThan(50);
    expect(productionFiles.length, "no client sources found").toBeGreaterThan(1000);
    expect(
      productionFiles.length,
      "test files leaked into the production set",
    ).toBeLessThan(clientFiles.length);
    // A name known to be called, from Swift only, so the multi-language scan is
    // proven live rather than assumed.
    expect(granted.has("create_listing_template")).toBe(true);
    expect(quotedIn(productionText, "create_listing_template")).toBe(true);
  });

  it("no granted function is dead, except the ones named as such", () => {
    const dead = [...granted.keys()]
      .filter((name) => !quotedIn(productionText, name))
      .filter((name) => !calledFromSql(name))
      .filter((name) => !droppedForGood(name))
      .sort();

    expect(
      dead,
      "a Postgres function is GRANTed to a caller and nothing calls it. A dead RPC " +
        "is not free: inventory_distinct_brands kept idx_inventory_items_user_brand " +
        "alive on every inventory_items write for a reader that did not exist. " +
        "Either wire it, drop it with its indexes in one migration, or add it to " +
        "UNCALLED_ON_PURPOSE with the reason.",
    ).toEqual(Object.keys(UNCALLED_ON_PURPOSE).sort());
  });

  it("the exemption list can only shrink", () => {
    const nowCalled = Object.keys(UNCALLED_ON_PURPOSE).filter(
      (name) => quotedIn(productionText, name) || calledFromSql(name),
    );
    expect(
      nowCalled,
      `now has a caller, so remove from UNCALLED_ON_PURPOSE: ${nowCalled.join(", ")}`,
    ).toEqual([]);
  });

  it("every exempt function is still granted, and every reason is a real one", () => {
    // An entry for a function that no longer exists makes the list look larger
    // than the debt it describes.
    for (const [name, reason] of Object.entries(UNCALLED_ON_PURPOSE)) {
      expect(granted.has(name), `${name} is exempt but no longer granted`).toBe(true);
      expect(reason.length, `${name} has no real reason recorded`).toBeGreaterThan(60);
    }
  });

  it("a backticked mention in prose is not a caller", () => {
    // The direct unit test of the rule above, and the thing that stops the
    // backtick branch being helpfully added back. Sabotage showed that
    // restoring it turns the guard green against a function whose last caller
    // was deleted - the failure is silent and looks like a passing suite, so
    // it needs an assertion of its own rather than only a comment.
    const name = ["some", "rpc", "fn"].join("_");
    expect(
      quotedIn("// Backed by the `" + name + "` RPC, one row per status", name),
      "a name backticked in a comment counted as a call site",
    ).toBe(false);

    // The forms that ARE calls still count.
    expect(quotedIn(`client.rpc("${name}", {})`, name)).toBe(true);
    expect(quotedIn(`client.rpc('${name}', {})`, name)).toBe(true);

    // And a longer name must not be matched by a shorter one's search.
    expect(quotedIn(`client.rpc("${name}_extended", {})`, name)).toBe(false);
  });

  it("no caller passes the function name as a backtick literal", () => {
    // quotedIn deliberately ignores backticks, so a real backtick-literal call
    // would be invisible to this whole guard. There are none today. If one
    // appears, either rewrite it with double quotes or teach quotedIn to tell a
    // call from a comment - do not simply add the branch back, which is what
    // made the guard blind to its own subject.
    const backtickCall =
      /(?:\.rpc|callRpc|rpc)\(\s*`[a-z0-9_]+`|\)\(\s*`[a-z0-9_]+`/;
    const offenders = productionFiles.filter((p) => backtickCall.test(readFileSync(p, "utf8")));
    expect(
      offenders.map((p) => p.replace(ROOT, "")),
      "an RPC is called with a backtick literal, which quotedIn cannot see",
    ).toEqual([]);
  });

  it("the exemption list stays small enough to be worth having", () => {
    // AC5's own condition, asserted rather than remembered: a guard with thirty
    // exemptions guards nothing, and the honest move at that point is to delete
    // this file rather than keep feeding it.
    expect(
      Object.keys(UNCALLED_ON_PURPOSE).length,
      "this list has grown past the point where the guard means anything. Either " +
        "clear the backlog of dead functions or delete this guard.",
    ).toBeLessThanOrEqual(5);
  });
});
