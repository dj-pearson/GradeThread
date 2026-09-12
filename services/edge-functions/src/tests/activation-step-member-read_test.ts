// US-3316: every table the activation checklist reads is either visible to a
// workspace seat, or is named here with the reason it is not.
//
// THE BUG THIS EXISTS FOR. flipdesk_import_runs shipped with one SELECT policy
// (00592, "Users read own import runs"), which is owner-only. The checklist's
// import step is done when a 'completed' run exists, and the browser counts
// that row through RLS with the anon key, so a member on somebody else's
// workspace got zero rows and the step could never tick. Nothing was broken
// from the member's side: the step just sat there, indistinguishable from work
// nobody had done. It was found by reading pg_policies, not by looking at the
// screen, which is exactly why a guard belongs here.
//
// WHAT THIS GUARD IS AND IS NOT. It is a STATIC read of the migration SQL, so
// it runs in CI with no database. That means it proves the shipped SQL says the
// right thing, and it cannot prove production's live policy set matches - a
// policy added by hand would be invisible to it. The live check is
// `select policyname, qual from pg_policies`, and US-3316's proof run did it
// three ways (owner, viewer member, stranger) against the local stack.
//
// HOW FAR THE PARSER WAS TRUSTED. Its output was diffed against pg_policies on
// the local stack, table by table: 451 of the 459 live public-schema policies
// come back identical in name and command. The 8 it misses are all created by
// the `format()` DO loop in 00041 (blog_posts, social_posts, six content_*
// tables), which no text scan can see, and none of them is an activation-step
// table. A missed policy can only ever make this guard fail, never pass - the
// parser invents nothing - so the residual risk is a future DO block that DROPS
// a member policy dynamically.
import { assert, assertEquals } from "@std/assert";

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);
const USE_ACTIVATION = new URL("../../../../src/hooks/use-activation.ts", import.meta.url);

interface ParsedPolicy {
  name: string;
  table: string;
  cmd: string;
  using: string;
  /** Migration filename, so a failure names the file to open. */
  file: string;
}

/** Collapse whitespace so formatting differences are not drift. */
function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Strip SQL comments before parsing.
 *
 * NOT cosmetic. `00622_ebay_search_terms.sql` carries the words "once PER ROW;"
 * inside a `--` comment BETWEEN `CREATE POLICY` and its `FOR SELECT`, so a
 * statement regex that stops at the first semicolon reads that policy as
 * having no command at all. Two more files hide a `;` in a comment the same
 * way. A guard that silently drops the statement it was pointed at is worse
 * than no guard, so the comments come out first.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, "");
}

// A policy name is either "quoted" or a bare identifier. Both spellings are in
// this directory: 00042 quotes, 00256 does not.
const CREATE_POLICY =
  /CREATE\s+POLICY\s+(?:"([^"]+)"|([a-z0-9_]+))\s+ON\s+(?:([a-z0-9_]+)\.)?([a-z0-9_]+)([\s\S]*?);/gi;
const DROP_POLICY =
  /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-z0-9_]+))\s+ON\s+(?:([a-z0-9_]+)\.)?([a-z0-9_]+)/gi;

/**
 * The FINAL policy set the migration directory describes, applied in order.
 *
 * Last writer wins per (table, policy name), because every migration since
 * 00291 is required to DROP POLICY IF EXISTS before CREATE POLICY - so a later
 * file re-creating the same name replaces the earlier one, which is exactly how
 * 00451 replaced 00042's shapes.
 *
 * `public` only. `storage.objects` carries its own per-bucket policies and none
 * of them is an activation-step table.
 */
export function finalPolicies(): Map<string, ParsedPolicy> {
  const files = [...Deno.readDirSync(MIGRATIONS_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();

  const byKey = new Map<string, ParsedPolicy>();
  const dropped = new Set<string>();
  for (const file of files) {
    const sql = stripComments(Deno.readTextFileSync(new URL(file, MIGRATIONS_DIR)));
    // A DROP POLICY with no CREATE behind it removes the policy for good.
    for (const m of sql.matchAll(DROP_POLICY)) {
      const schema = (m[3] ?? "public").toLowerCase();
      if (schema !== "public") continue;
      dropped.add(`${m[4]!.toLowerCase()}::${m[1] ?? m[2]!}`);
    }
    for (const m of sql.matchAll(CREATE_POLICY)) {
      const schema = (m[3] ?? "public").toLowerCase();
      if (schema !== "public") continue;
      const name = m[1] ?? m[2]!;
      const table = m[4]!.toLowerCase();
      const body = m[5]!;
      const cmdMatch = body.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i);
      const usingMatch = body.match(/\bUSING\s*\(([\s\S]*?)\)\s*(?:WITH\s+CHECK|$)/i);
      const key = `${table}::${name}`;
      dropped.delete(key);
      byKey.set(key, {
        name,
        table,
        cmd: (cmdMatch?.[1] ?? "ALL").toUpperCase(),
        using: norm(usingMatch?.[1] ?? ""),
        file,
      });
    }
  }
  for (const key of dropped) byKey.delete(key);
  return byKey;
}

const POLICIES = finalPolicies();

export function selectPolicies(table: string): ParsedPolicy[] {
  return [...POLICIES.values()].filter(
    (p) => p.table === table && (p.cmd === "SELECT" || p.cmd === "ALL"),
  );
}

/** A predicate that lets a workspace VIEWER through, not just an owner. */
export function viewerVisible(p: ParsedPolicy): boolean {
  return /is_workspace_member(_with_role)?\s*\(\s*user_id\s*(,\s*'viewer')?\s*\)/i
    .test(p.using);
}

// ════════════════════════════════════════════════════════════════════════════
// The fix itself.
// ════════════════════════════════════════════════════════════════════════════

Deno.test("flipdesk_import_runs is readable by a workspace viewer (US-3316)", () => {
  const policies = selectPolicies("flipdesk_import_runs");
  assert(
    policies.some(viewerVisible),
    "flipdesk_import_runs has no SELECT policy a workspace viewer can pass. " +
      "The activation checklist's import step counts these rows through RLS, so " +
      "a member sees a step that can never tick. Policies found: " +
      JSON.stringify(policies.map((p) => `${p.name} (${p.file})`)),
  );
});

Deno.test(
  "the import step's predicate is the same one the item step already uses (US-3316 AC2)",
  () => {
    const runs = selectPolicies("flipdesk_import_runs").find(viewerVisible);
    const items = selectPolicies("inventory_items").find(viewerVisible);
    assert(runs, "no viewer-visible SELECT policy on flipdesk_import_runs");
    assert(items, "no viewer-visible SELECT policy on inventory_items");
    assertEquals(
      runs.using,
      items.using,
      "The import step and the item step now read through DIFFERENT predicates. " +
        `import runs (${runs.file}): ${runs.using}\n` +
        `inventory items (${items.file}): ${items.using}\n` +
        "They sit side by side on one checklist, so they must not drift.",
    );
  },
);

Deno.test(
  "flipdesk_import_effects stays owner-only (US-3316 scoped the widening to runs)",
  () => {
    const widened = selectPolicies("flipdesk_import_effects").filter(viewerVisible);
    assertEquals(
      widened.map((p) => `${p.name} (${p.file})`),
      [],
      "An effect row holds the pre-import values of every column a fill-only " +
        "re-import overwrote. Only the service role reads it and no checklist " +
        "step is behind it, so widening it buys nothing and discloses more.",
    );
  },
);

// ════════════════════════════════════════════════════════════════════════════
// AC5: the same question, asked of every other step.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Steps whose table a workspace VIEWER genuinely cannot read, each with the
 * reason it stays that way. An entry here is a decision, not a silence.
 *
 * It is deliberately not empty. US-3316 asked whether the import step was the
 * only one of its shape and the answer is no - but the other two are tables
 * where widening would be wrong, so they are recorded rather than fixed.
 */
const NOT_VISIBLE_TO_A_VIEWER: Record<string, string> = {
  // The `ebay` step (useEbayConnection, src/hooks/use-ebay.ts). Its member
  // policy is "Workspace admins can view marketplace connections", admin-only,
  // and that is right: the row carries the account handle and the token
  // expiry for the owner's live eBay grant. A viewer therefore sees "Connect
  // eBay" permanently unticked, and unlike the import step it is NOT
  // skippable. That is a UI decision to make on the checklist side, not a
  // reason to hand a read-only seat the owner's marketplace credentials.
  marketplace_connections: "admin-only on purpose: OAuth account handle + token expiry",
  // The `apikey` step (developer persona). "Workspace admins can view api
  // keys" is admin-only for the same reason: these are credentials.
  api_keys: "admin-only on purpose: these rows are credentials",
  // The buyer persona's two. A workspace seat is a SELLER concept - the buyer
  // steps complete on the seat-holder's OWN saved searches and closet, which
  // their own owner-scoped policy already returns. There is nothing to widen.
  saved_searches: "buyer step: completes on the reader's own rows",
  closet_items: "buyer step: completes on the reader's own rows",
};

Deno.test("every table the activation checklist counts is classified (US-3316 AC5)", () => {
  // The count queries the checklist actually runs, read out of the hook rather
  // than copied here - so a NEW step is covered the moment it is added.
  const hook = Deno.readTextFileSync(USE_ACTIVATION);
  const counted = [...hook.matchAll(/\bhead\(\s*"([a-z0-9_]+)"\s*\)/g)]
    .map((m) => m[1]!)
    .filter((t, i, a) => a.indexOf(t) === i)
    .sort();

  assert(
    counted.length >= 5,
    `Expected to find the checklist's count queries in use-activation.ts, found ${
      JSON.stringify(counted)
    }. If the head() helper was renamed, this guard stopped guarding.`,
  );

  // marketplace_connections is read by useEbayConnection rather than by a
  // head() call, so it is added by hand. It is in the map below either way.
  const tables = [...new Set([...counted, "marketplace_connections"])].sort();

  const unclassified = tables.filter(
    (t) => !selectPolicies(t).some(viewerVisible) && !(t in NOT_VISIBLE_TO_A_VIEWER),
  );
  assertEquals(
    unclassified,
    [],
    "These activation-step tables are invisible to a workspace viewer and no " +
      "reason is recorded. Either give them the member policy inventory_items " +
      "uses, or add an entry to NOT_VISIBLE_TO_A_VIEWER saying why not. A step " +
      "a seat can never tick reads the same as work nobody has done.",
  );

  // The map may not go stale in the other direction either: an entry for a
  // table that HAS since been widened is a stale reason nobody rechecks.
  const staleEntries = Object.keys(NOT_VISIBLE_TO_A_VIEWER).filter((t) =>
    selectPolicies(t).some(viewerVisible)
  );
  assertEquals(
    staleEntries,
    [],
    "NOT_VISIBLE_TO_A_VIEWER names a table that a viewer CAN now read. Delete " +
      "the entry in the same change that widened the policy.",
  );
});
