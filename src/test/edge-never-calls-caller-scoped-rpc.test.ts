import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// US-268: the edge must never call a function that relies on WHO is asking.
//
// The edge uses the service-role client. That bypasses RLS and makes auth.uid()
// NULL, so a function which scopes its rows by either one answers a completely
// different question when the edge calls it than when the browser does — and it
// answers it silently, with a 200. There are two failure directions and both are
// bad:
//
//   scoped by auth.uid()  -> NULL -> returns NOTHING. A feature that looks built
//                            and is empty for every seller.
//   scoped by RLS only    -> RLS off -> returns EVERY TENANT'S ROWS. That is the
//                            US-268 breach, and in the weekly-digest case it
//                            would have been EMAILED.
//
// TODAY THE ANSWER IS ZERO and this holds it there. 20 functions qualify as
// identity-dependent; the edge calls none of them. They are not a bug, they are
// correct as browser RPCs. They are loaded guns, and the trigger is one line in
// a job or an /api/v1 handler.
//
// THIS IS THE BLOCKER ON US-2829 AC2 AND US-2828 AC1, made enforceable. Both
// stories' next step is an edge caller for exactly these analytics functions.
// The fix when this fires is not an allowlist entry: it is a DEFINER wrapper
// taking p_user_id, so the caller's identity is an argument rather than an
// ambient fact.
//
// ── WHY THE EXISTING GUARD DOES NOT COVER IT ─────────────────────────────────
//
// rpc-identity-semantics.test.ts asks about functions called from the browser
// AND the edge. That misses the case that matters here — an edge-ONLY call,
// where nothing is dual-called and the guard never fires while the function
// still returns the wrong tenant's data.
//
// ── THE PART THAT MADE THE FIRST VERSION USELESS ─────────────────────────────
//
// ⚠ VIEWS. The analytics RPCs read `items_full`, not `inventory_items`. A view
// carries no RLS policy of its own, so a rule that only knows base tables sees
// an analytics function reading nothing tenant-shaped and calls it safe. Six of
// the twenty are only reachable through a view. Views are resolved to their
// bases here.
//
// ⚠ AND THE FIRST RUN REPORTED A CLEAN ZERO FOR A DIFFERENT REASON ENTIRELY.
// The table-matching regex was built from a string literal, and `"\b"` in
// JavaScript is the BACKSPACE character, not a word boundary. The pattern could
// never match, every function looked like it read no tenant table, and the scan
// printed a confident 0. Regexes here are literals for that reason. If you must
// build one from a string, escape it as `\\b` and check the result.

const ROOT = process.cwd();
const MIGRATIONS = resolve(ROOT, "supabase/migrations");
const EDGE_SRC = resolve(ROOT, "services/edge-functions/src");

const FILES = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const ALL_SQL = FILES.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");

/** Tables whose RLS scopes by auth.uid() — derived, never listed. */
function tenantTables(): Set<string> {
  const out = new Set<string>();
  for (const m of ALL_SQL.matchAll(
    /create\s+policy[\s\S]{0,400}?\son\s+(?:public\.)?"?([a-z0-9_]+)"?[\s\S]{0,900}?(?:;|$)/gi,
  )) {
    if (/auth\.uid\(\)/i.test(m[0])) out.add(m[1]!.toLowerCase());
  }
  return out;
}

function readsTable(body: string, table: string): boolean {
  return new RegExp(`\\b(from|join)\\s+(public\\.)?${table}\\b`, "i").test(body);
}

/** Views that expose tenant tables, so a function reading one is reading them. */
function viewsOverTenantTables(tenant: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const m of ALL_SQL.matchAll(
    /create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?"?([a-z0-9_]+)"?\s+as([\s\S]{0,4000}?);/gi,
  )) {
    for (const t of tenant) {
      if (readsTable(m[2]!, t)) {
        out.add(m[1]!.toLowerCase());
        break;
      }
    }
  }
  return out;
}

/** Every function's LAST definition, bounded by its own dollar tag. */
function currentDefinitions(): Map<string, { text: string; file: string }> {
  const out = new Map<string, { text: string; file: string }>();
  for (const f of FILES) {
    const s = readFileSync(join(MIGRATIONS, f), "utf8");
    for (const m of s.matchAll(
      /create\s+or\s+replace\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi,
    )) {
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

/**
 * Functions whose answer depends on who is asking: they run as the CALLER
 * (SECURITY INVOKER, explicitly or by Postgres default), read tenant data, and
 * take no user argument — so the only thing scoping them is the session.
 */
export function identityDependent(): Array<{ name: string; file: string; reads: string[] }> {
  const tenant = tenantTables();
  const views = viewsOverTenantTables(tenant);
  const out: Array<{ name: string; file: string; reads: string[] }> = [];
  for (const [name, d] of currentDefinitions()) {
    const head = d.text.slice(0, 1200);
    if (/returns\s+trigger/i.test(head)) continue;
    if (/security\s+definer/i.test(head)) continue;
    const sig = d.text.slice(0, d.text.indexOf(")") + 1);
    if (/p_(user|owner|seller|buyer)[a-z_]*\s+uuid/i.test(sig)) continue;
    const reads = [
      ...[...tenant].filter((t) => readsTable(d.text, t)),
      ...[...views].filter((v) => readsTable(d.text, v)).map((v) => `${v} (view)`),
    ];
    if (reads.length) out.push({ name, file: d.file, reads });
  }
  return out;
}

/**
 * The OTHER shape, and the one this file used to miss entirely (US-2828).
 *
 * `identityDependent` above skips every `security definer` function, on the
 * reasonable assumption that a DEFINER function takes its subject as an
 * argument. `flipdesk_price_gap` (00652) disproved it: SECURITY DEFINER, no
 * user parameter, and `where user_id = auth.uid()` in three places. Called from
 * the edge that returns an EMPTY result for every seller, silently, with a 200
 * — which is exactly the failure this file's header describes and exactly what
 * blocked US-2828's weekly digest for weeks.
 *
 * The distinction that matters, and that the first version of this scan got
 * wrong: READING `auth.uid()` is not SCOPING by it. `admin_audit_log_search`
 * reads it to look up the caller's role, `revenue_dashboard` names it only in
 * comments about a guard that was since fixed. Counting those reported four
 * live problems where there are none. So this requires an owner-column
 * predicate (`user_id = auth.uid()` and friends), over the function BODY with
 * comments stripped — a policy or a column DEFAULT elsewhere in the same
 * migration is not this function's scoping.
 */
export function definerRowScoped(): Array<{ name: string; file: string }> {
  const SCOPES =
    /\b(?:[a-z0-9_]+\.)?(?:user_id|owner_user_id|seller_id|buyer_id)\s*=\s*auth\.uid\(\)/i;
  const SCOPES_REV =
    /auth\.uid\(\)\s*=\s*(?:[a-z0-9_]+\.)?(?:user_id|owner_user_id|seller_id|buyer_id)\b/i;
  const out: Array<{ name: string; file: string }> = [];
  for (const [name, d] of currentDefinitions()) {
    const head = d.text.slice(0, 1200);
    if (/returns\s+trigger/i.test(head)) continue;
    if (!/security\s+definer/i.test(head)) continue;
    const sig = d.text.slice(0, d.text.indexOf(")") + 1);
    // A p_user_id-style argument IS the fix, so a function carrying one is out.
    if (/p_(user|owner|seller|buyer)[a-z_]*\s+uuid/i.test(sig)) continue;
    const body = d.text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (SCOPES.test(body) || SCOPES_REV.test(body)) out.push({ name, file: d.file });
  }
  return out;
}

/** Every `.rpc("name")` in edge PRODUCTION code, with where it is called. */
function edgeRpcCalls(): Map<string, Set<string>> {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "tests") walk(p);
      } else if (e.name.endsWith(".ts")) files.push(p);
    }
  })(EDGE_SRC);

  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/gi)) {
      const n = m[1]!.toLowerCase();
      if (!out.has(n)) out.set(n, new Set());
      out.get(n)!.add(f.slice(ROOT.length + 1).split("\\").join("/"));
    }
  }
  return out;
}

describe("the edge never calls a function that relies on who is asking", () => {
  const risky = identityDependent();
  const calls = edgeRpcCalls();

  it("the derivation actually saw the corpus", () => {
    // Guards the guard, and it has already been needed: a broken regex made
    // this whole check report a confident zero. Every number below is a floor
    // on something derived, so a silent parse failure fails here instead of
    // reading as a clean codebase.
    expect(tenantTables().size, "no auth.uid()-scoped policies parsed").toBeGreaterThan(50);
    expect(
      viewsOverTenantTables(tenantTables()).size,
      "no views over tenant tables — items_full should be one",
    ).toBeGreaterThan(0);
    expect(risky.length, "no identity-dependent functions found").toBeGreaterThan(10);
    expect(calls.size, "no .rpc() calls found in the edge").toBeGreaterThan(30);
  });

  it("items_full is resolved, because that is where the analytics RPCs read", () => {
    // The specific miss that made version one useless. items_full has no policy
    // of its own, so a base-table-only rule sees an analytics function touching
    // nothing tenant-shaped.
    expect([...viewsOverTenantTables(tenantTables())]).toContain("items_full");
    const viaView = risky.filter((r) => r.reads.some((x) => x.endsWith("(view)")));
    expect(
      viaView.length,
      "no function reaches tenant data through a view — view resolution has broken",
    ).toBeGreaterThan(0);
  });

  it("no edge file calls one of them", () => {
    const violations = risky
      .filter((r) => calls.has(r.name))
      .map((r) => `${r.name} (reads ${r.reads.slice(0, 3).join(", ")}) <- ${[...calls.get(r.name)!].join(", ")}`)
      .sort();

    expect(
      violations,
      "an edge file calls a function that scopes itself by the SESSION, and the " +
        "edge has no session: the service-role client bypasses RLS and makes " +
        "auth.uid() NULL. Depending on which the function relies on, this returns " +
        "NOTHING for every seller, or EVERY TENANT'S ROWS. Both answer 200. The " +
        "fix is a SECURITY DEFINER wrapper taking p_user_id so identity is an " +
        "argument, not an ambient fact — not an entry on a list here.",
    ).toEqual([]);
  });

  describe("nor one that is SECURITY DEFINER and scopes its rows by the session", () => {
    const definer = definerRowScoped();

    it("the derivation saw the corpus", () => {
      // Same reason as above: every number here is a floor on something
      // derived, so a regex that stops matching fails LOUDLY rather than
      // reporting a confident zero. This file has already been bitten once by
      // exactly that — see the `\b` note in the header.
      expect(
        definer.length,
        "no DEFINER row-scoped functions found — the predicate regex has broken",
      ).toBeGreaterThan(0);
      // flipdesk_price_gap is the worked example and it must NOT be here: 00662
      // gave it p_user_id, which is the fix. If it comes back, the fix was
      // reverted.
      expect(
        definer.map((d) => d.name),
        "flipdesk_price_gap is scoping by the session again — 00662 was reverted",
      ).not.toContain("flipdesk_price_gap");
    });

    it("no edge file calls one of them", () => {
      const violations = definer
        .filter((d) => calls.has(d.name))
        .map((d) => `${d.name} (${d.file}) <- ${[...calls.get(d.name)!].join(", ")}`)
        .sort();

      expect(
        violations,
        "an edge file calls a SECURITY DEFINER function that scopes its rows by " +
          "auth.uid(). The service-role client makes auth.uid() NULL, so this " +
          "returns an EMPTY result for every seller — silently, with a 200. It is " +
          "the quieter half of this file's subject and it is what blocked " +
          "US-2828 for weeks. The fix is the one 00662 applied to " +
          "flipdesk_price_gap: add `p_user_id uuid default null`, resolve it in a " +
          "`caller` CTE that honours the argument ONLY for service_role, and " +
          "scope every predicate to that. A logged-in caller passing someone " +
          "else's id then gets their own rows rather than an error, so the " +
          "argument is not an oracle either.",
      ).toEqual([]);
    });
  });
});
