// US-3350: a service-role table's GRANT and its POLICIES must not contradict.
//
// Two layers are supposed to keep anon and authenticated out of an operator
// table: the table-level GRANT (what PostgREST is allowed to ask for at all)
// and RLS (which rows come back once it asks). The repo's operator tables use
// both, but not always: of the 142 tables registered in SERVICE_ROLE_ONLY, 88
// carry no REVOKE at any point in their history, so anon and authenticated
// hold all seven privileges on them from the Supabase default-privilege grant
// that fires at CREATE TABLE. Those 88 are safe today only because they have
// zero policies, and zero policies with RLS on denies everything.
//
// That makes the dangerous change a POLICY, not a grant. Adding one line to a
// future migration turns a table nobody ever revoked from into a readable one,
// and nothing in the repo goes red. rls-guard_test.ts does not catch it: it
// fails a table that has NO policy and is NOT registered, which is the exact
// opposite direction.
//
// So the rule here is a contradiction check rather than a posture check:
//
//   a table that DECLARED itself closed to clients must not end up with a
//   policy that its still-effective grant would let a client use.
//
// "Declared closed" is derived, never pinned:
//   - any table some migration REVOKEs from anon/authenticated declared the
//     privileges it revoked, or
//   - any table registered in rls-guard_test.ts's SERVICE_ROLE_ONLY declared
//     all of them, because that registration IS the claim that no client
//     touches the table.
//
// "Still effective" is replayed from the migrations in file order, starting
// from the Supabase default (ALL to anon and authenticated at CREATE TABLE,
// confirmed against pg_default_acl on the local stack 2026-09-11), applying
// every GRANT and REVOKE. A revoke followed by a later re-grant is therefore
// scored as open, which is the case this guard exists for.
//
// What this guard is NOT. It does not assert that a REVOKE survived in a
// live database; source cannot answer that (see the story's AC1). It scores
// the migrations against each other.
import { assert, assertEquals } from "@std/assert";

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);
const RLS_GUARD_SRC = new URL("./rls-guard_test.ts", import.meta.url);

// The seven privileges Postgres grants on a table, and exactly what
// pg_default_acl hands anon and authenticated when a table is created in
// schema public on this stack: arwdDxt = INSERT, SELECT, UPDATE, DELETE,
// TRUNCATE, REFERENCES, TRIGGER.
const ALL_PRIVS = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;
type Priv = (typeof ALL_PRIVS)[number];

const CLIENT_ROLES = ["anon", "authenticated"] as const;
type ClientRole = (typeof CLIENT_ROLES)[number];

// Only these four are reachable through PostgREST, so only these four can be
// the privilege a policy hands to a client.
const POLICY_PRIVS: Priv[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

// Comment stripping, and why it is spelled this way.
//
// The obvious form - split on "\n", drop /--.*$/ - removes NOTHING from a file
// with CRLF line endings, because "." stops at the "\r" and "$" without the m
// flag only matches the very end of the input. Worse, running the block-comment
// regex over all 785 migrations CONCATENATED lets one unbalanced "/*" eat every
// file after it: the first draft of this guard saw 218 of the 360 tables and
// reported a clean 26 revokes instead of 83. Normalise line endings first, and
// strip block comments per FILE so a stray opener is bounded by its own file.
function stripComments(sql: string): string {
  return sql
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

const PRIV_TOKEN =
  "(?:all(?:\\s+privileges)?|select|insert|update|delete|truncate|references|trigger|maintain)";
const PRIV_LIST = `(?:${PRIV_TOKEN})(?:\\s*,\\s*(?:${PRIV_TOKEN}))*`;
const GRANT_RE = new RegExp(
  `\\b(grant|revoke)\\s+(${PRIV_LIST})\\s+on\\s+(?:table\\s+)?` +
    `([a-z0-9_"]+(?:\\.[a-z0-9_"]+)?)\\s+(?:to|from)\\s+([a-z0-9_,\\s"']+?)\\s*;`,
  "gi",
);

const TABLE_RE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(/gi;

// Same CREATE/DROP-in-file-order treatment rls-guard_test.ts uses, for the same
// reason: a policy a later migration dropped is not a policy.
const POLICY_RE =
  /(CREATE|DROP)\s+POLICY\s+(?:IF EXISTS\s+)?(?:"([^"]+)"|([a-z0-9_]+))\s+ON\s+(?:public\.)?(\w+)([\s\S]*?);/gi;

function bareName(obj: string): string {
  return obj.replace(/"/g, "").replace(/^public\./, "");
}

function privsOf(list: string): Priv[] {
  if (/\ball\b/i.test(list)) return [...ALL_PRIVS];
  const out: Priv[] = [];
  for (const raw of list.split(",")) {
    const p = raw.trim().toUpperCase();
    if ((ALL_PRIVS as readonly string[]).includes(p)) out.push(p as Priv);
  }
  return out;
}

function granteesOf(list: string): string[] {
  return list
    .replace(/['"]/g, "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

interface PolicyFacts {
  name: string;
  /** SELECT / INSERT / UPDATE / DELETE the policy covers (FOR ALL expands). */
  commands: Priv[];
  /** True when the TO clause is absent or names public/anon/authenticated. */
  reachesClients: boolean;
  /** True for USING (false) / WITH CHECK (false): grants nothing to anyone. */
  alwaysFalse: boolean;
}

function policyFacts(name: string, body: string): PolicyFacts {
  const norm = ` ${body.replace(/\s+/g, " ").toLowerCase()} `;
  const forMatch = / for (all|select|insert|update|delete) /.exec(norm);
  const cmd = forMatch ? forMatch[1]!.toUpperCase() : "ALL";
  const commands = cmd === "ALL" ? [...POLICY_PRIVS] : [cmd as Priv];

  const toMatch = / to ([a-z0-9_,\s]+?)(?: using | with check |$)/.exec(norm);
  const roles = toMatch
    ? toMatch[1]!.split(",").map((r) => r.trim()).filter(Boolean)
    : ["public"];
  const reachesClients = roles.some((r) =>
    r === "public" || r === "anon" || r === "authenticated"
  );

  // quest_definitions (00539) is the live example: RLS on, wide-open grant, and
  // one policy that is USING (false) WITH CHECK (false). That is STRICTER than
  // zero policies, not weaker, so counting it as a client-reachable policy would
  // make this guard fire at correct code on the day it shipped.
  const hasUsing = /\busing\s*\(/.test(norm);
  const hasCheck = /\bwith check\s*\(/.test(norm);
  const usingFalse = !hasUsing || /\busing\s*\(\s*false\s*\)/.test(norm);
  const checkFalse = !hasCheck || /\bwith check\s*\(\s*false\s*\)/.test(norm);
  const alwaysFalse = (hasUsing || hasCheck) && usingFalse && checkFalse;

  return { name, commands, reachesClients, alwaysFalse };
}

export interface Violation {
  table: string;
  role: ClientRole;
  policy: string;
  privs: Priv[];
  reason: string;
}

export interface Analysis {
  /** Every table the migrations CREATE. */
  tables: Set<string>;
  /** Privileges anon/authenticated still hold after replaying every DDL. */
  held: Map<string, Record<ClientRole, Set<Priv>>>;
  /** Privileges some migration explicitly revoked, per role. */
  revoked: Map<string, Record<ClientRole, Set<Priv>>>;
  /** Final policy set per table. */
  policies: Map<string, PolicyFacts[]>;
  /** Tables that declared themselves closed to clients, and how. */
  declared: Map<string, Record<ClientRole, Set<Priv>>>;
  grantStatements: number;
  violations: Violation[];
}

function emptyPrivs(): Record<ClientRole, Set<Priv>> {
  return { anon: new Set<Priv>(), authenticated: new Set<Priv>() };
}

function fullPrivs(): Record<ClientRole, Set<Priv>> {
  return { anon: new Set(ALL_PRIVS), authenticated: new Set(ALL_PRIVS) };
}

/**
 * Pure analyzer. The real corpus and the synthetic self-checks below go through
 * this same function, so a self-check that passes is a statement about the code
 * that reads the migrations rather than about a second implementation of it.
 */
export function analyze(fullSql: string, registry: Iterable<string>): Analysis {
  const tables = new Set<string>();
  const held = new Map<string, Record<ClientRole, Set<Priv>>>();
  for (const m of fullSql.matchAll(TABLE_RE)) {
    const t = m[1]!;
    tables.add(t);
    if (!held.has(t)) held.set(t, fullPrivs());
  }

  const revoked = new Map<string, Record<ClientRole, Set<Priv>>>();
  let grantStatements = 0;
  for (const m of fullSql.matchAll(GRANT_RE)) {
    const kind = m[1]!.toLowerCase();
    const privs = privsOf(m[2]!);
    const table = bareName(m[3]!);
    const grantees = granteesOf(m[4]!);

    // A GRANT naming PUBLIC reaches anon and authenticated, because both
    // inherit from PUBLIC. A REVOKE naming ONLY public does not take their
    // role-specific ACL entries away - that is US-2666's no-op, and scoring it
    // as a revoke would credit the migration with protection it never had.
    const roles: ClientRole[] = [];
    for (const r of CLIENT_ROLES) if (grantees.includes(r)) roles.push(r);
    if (kind === "grant" && grantees.includes("public")) {
      for (const r of CLIENT_ROLES) if (!roles.includes(r)) roles.push(r);
    }
    if (roles.length === 0) continue;

    grantStatements += 1;
    const heldFor = held.get(table);
    if (!heldFor) continue; // a view or a table this corpus never creates

    for (const role of roles) {
      for (const p of privs) {
        if (kind === "grant") {
          heldFor[role].add(p);
        } else {
          heldFor[role].delete(p);
          if (!revoked.has(table)) revoked.set(table, emptyPrivs());
          revoked.get(table)![role].add(p);
        }
      }
    }
  }

  const policies = new Map<string, PolicyFacts[]>();
  for (const m of fullSql.matchAll(POLICY_RE)) {
    const name = (m[2] ?? m[3])!;
    const table = m[4]!;
    const list = policies.get(table) ?? [];
    if (m[1]!.toUpperCase() === "DROP") {
      policies.set(table, list.filter((p) => p.name !== name));
    } else {
      list.push(policyFacts(name, m[5]!));
      policies.set(table, list);
    }
  }

  // What each table declared closed. A REVOKE declares the privileges it named;
  // a SERVICE_ROLE_ONLY registration declares all of them, since the whole
  // claim behind that entry is "no client reads or writes this".
  const declared = new Map<string, Record<ClientRole, Set<Priv>>>();
  for (const [table, byRole] of revoked) {
    declared.set(table, {
      anon: new Set(byRole.anon),
      authenticated: new Set(byRole.authenticated),
    });
  }
  for (const table of registry) {
    if (!tables.has(table)) continue;
    const existing = declared.get(table) ?? emptyPrivs();
    for (const role of CLIENT_ROLES) for (const p of ALL_PRIVS) existing[role].add(p);
    declared.set(table, existing);
  }

  const violations: Violation[] = [];
  for (const [table, byRole] of [...declared.entries()].sort()) {
    const pols = policies.get(table) ?? [];
    if (pols.length === 0) continue;
    const heldFor = held.get(table);
    if (!heldFor) continue;
    for (const pol of pols) {
      if (!pol.reachesClients || pol.alwaysFalse) continue;
      for (const role of CLIENT_ROLES) {
        const live = pol.commands.filter((c) =>
          byRole[role].has(c) && heldFor[role].has(c)
        );
        if (live.length === 0) continue;
        violations.push({
          table,
          role,
          policy: pol.name,
          privs: live,
          reason:
            `${table}: policy "${pol.name}" gives ${role} ${live.join("/")}, ` +
            `but this table is declared closed to clients and ${role} still ` +
            `HOLDS ${live.join("/")} on it. Either revoke those privileges in ` +
            `the same migration as the policy, or stop declaring the table ` +
            `service-role-only.`,
        });
      }
    }
  }

  return { tables, held, revoked, policies, declared, grantStatements, violations };
}

async function loadMigrations(): Promise<string> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  const parts: string[] = [];
  for (const name of names) {
    parts.push(stripComments(await Deno.readTextFile(new URL(name, MIGRATIONS_DIR))));
  }
  return parts.join("\n");
}

/**
 * The operator-table registry lives in rls-guard_test.ts and there must not be
 * a second copy of it here: a pinned list is the thing this story found rotting.
 * It is read as TEXT rather than imported, because importing a _test.ts module
 * registers its Deno.test cases a second time in this run.
 */
export function parseServiceRoleRegistry(src: string): string[] {
  const block = /const SERVICE_ROLE_ONLY = new Set\(\[([\s\S]*?)\n\]\);/.exec(src);
  if (!block) return [];
  const body = block[1]!
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
}

Deno.test("US-3350: no service-role table has a policy its grant would let through", async () => {
  const sql = await loadMigrations();
  const registry = parseServiceRoleRegistry(await Deno.readTextFile(RLS_GUARD_SRC));
  const a = analyze(sql, registry);

  if (a.violations.length > 0) {
    throw new Error(
      "a table declared closed to anon/authenticated carries a live policy:\n" +
        a.violations.map((v) => `  - ${v.reason}`).join("\n"),
    );
  }
});

// Floors. Every assertion above is of the form "nothing matched", which is also
// what a broken regex, a moved directory and an empty registry all look like.
// These numbers are the difference between a clean corpus and a guard that
// stopped reading one. They are lower bounds well under today's values, so
// ordinary growth never touches them; a HALVING is what they catch.
Deno.test("US-3350: the guard is reading a real corpus (floor assertions)", async () => {
  const sql = await loadMigrations();
  const registrySrc = await Deno.readTextFile(RLS_GUARD_SRC);
  const registry = parseServiceRoleRegistry(registrySrc);
  const a = analyze(sql, registry);

  assert(sql.length > 5_000_000, `migration corpus collapsed to ${sql.length} chars`);
  assert(a.tables.size >= 340, `only ${a.tables.size} CREATE TABLE blocks parsed`);
  assert(
    a.grantStatements >= 100,
    `only ${a.grantStatements} GRANT/REVOKE statements naming anon/authenticated parsed`,
  );
  assert(a.revoked.size >= 80, `only ${a.revoked.size} tables carry a REVOKE`);
  assert(registry.length >= 120, `SERVICE_ROLE_ONLY parsed as ${registry.length} entries`);

  // The policy arm is the half that can go vacuous without changing any of the
  // counts above: if POLICY_RE stops matching, every table has zero policies and
  // the main test passes for the wrong reason.
  const withPolicies = [...a.declared.keys()].filter((t) =>
    (a.policies.get(t) ?? []).length > 0
  );
  assert(
    withPolicies.length >= 8,
    `only ${withPolicies.length} declared-closed tables have any policy - POLICY_RE probably broke`,
  );
  assert(a.policies.size >= 100, `only ${a.policies.size} tables have parsed policies`);

  // Known-member checks, so a registry regex that matches the wrong literals
  // cannot satisfy the count floor with garbage.
  for (const known of ["job_locks", "marketplace_supply_cells", "comp_condition_reads"]) {
    assert(a.revoked.has(known), `${known} lost its REVOKE from the parse`);
  }
  for (const known of ["quest_definitions", "garment_baselines", "oauth_grants"]) {
    assert(registry.includes(known), `${known} missing from the parsed registry`);
  }
});

// Behavioural self-checks: synthetic SQL through the SAME analyze(), one case
// per way the rule has to discriminate. Without these, "zero violations" is
// indistinguishable from "the violation branch is unreachable".
const SYNTH_REGISTRY = ["ops_widgets"];

function synth(ddl: string): Analysis {
  return analyze(stripComments(ddl), SYNTH_REGISTRY);
}

Deno.test("US-3350 self-check: a registered table with an open grant and a real policy FAILS", () => {
  const a = synth(`
    create table if not exists public.ops_widgets (id uuid primary key);
    alter table public.ops_widgets enable row level security;
    create policy ops_widgets_read on public.ops_widgets
      for select using (true);
  `);
  assertEquals(a.violations.length, 2, "expected one violation per client role");
  assertEquals(a.violations[0]!.table, "ops_widgets");
  assertEquals(a.violations[0]!.privs, ["SELECT"]);
});

Deno.test("US-3350 self-check: revoke all, then a policy, is NOT a violation", () => {
  const a = synth(`
    create table if not exists public.ops_widgets (id uuid primary key);
    revoke all on public.ops_widgets from anon, authenticated;
    create policy ops_widgets_read on public.ops_widgets
      for select using (true);
  `);
  assertEquals(a.violations.length, 0, "a closed grant makes the policy unreachable");
});

Deno.test("US-3350 self-check: revoke all, then a LATER re-grant, is a violation", () => {
  const a = synth(`
    create table if not exists public.ops_widgets (id uuid primary key);
    revoke all on public.ops_widgets from anon, authenticated;
    create policy ops_widgets_read on public.ops_widgets
      for select using (true);
    grant select on public.ops_widgets to anon;
  `);
  assertEquals(a.violations.length, 1);
  assertEquals(a.violations[0]!.role, "anon");
  assertEquals(a.violations[0]!.privs, ["SELECT"]);
});

Deno.test("US-3350 self-check: a write-only revoke beside a SELECT policy is NOT a violation", () => {
  // The garments / pricing_plans shape: public read on purpose, writes revoked.
  const a = analyze(
    stripComments(`
      create table if not exists public.passport_things (id uuid primary key);
      revoke insert, update, delete on public.passport_things from anon, authenticated;
      create policy passport_things_read on public.passport_things
        for select using (true);
    `),
    [],
  );
  assertEquals(a.violations.length, 0);
});

Deno.test("US-3350 self-check: a USING (false) policy is not a client-reachable policy", () => {
  const a = synth(`
    create table if not exists public.ops_widgets (id uuid primary key);
    create policy ops_widgets_deny_all on public.ops_widgets
      for all using (false) with check (false);
  `);
  assertEquals(a.violations.length, 0, "deny-all is stricter than zero policies");
});

Deno.test("US-3350 self-check: a policy scoped TO service_role is not client-reachable", () => {
  const a = synth(`
    create table if not exists public.ops_widgets (id uuid primary key);
    create policy ops_widgets_svc on public.ops_widgets
      for all to service_role using (true);
  `);
  assertEquals(a.violations.length, 0);
});

Deno.test("US-3350 self-check: a DROPPED policy stops counting", () => {
  const a = synth(`
    create table if not exists public.ops_widgets (id uuid primary key);
    create policy ops_widgets_read on public.ops_widgets
      for select using (true);
    drop policy if exists ops_widgets_read on public.ops_widgets;
  `);
  assertEquals(a.violations.length, 0);
});

Deno.test("US-3350 self-check: REVOKE naming only PUBLIC is scored as the no-op it is", () => {
  // US-2666. PUBLIC is not in the ACL of a Supabase table, so revoking from it
  // removes nothing - and a guard that scored it as protection would read an
  // exposed table as closed.
  const a = synth(`
    create table if not exists public.ops_widgets (id uuid primary key);
    revoke all on public.ops_widgets from public;
    create policy ops_widgets_read on public.ops_widgets
      for select using (true);
  `);
  assertEquals(a.violations.length, 2, "the PUBLIC revoke must not count as closing the grant");
});

Deno.test("US-3350 self-check: the CRLF corpus is parsed, not silently emptied", () => {
  // The first draft of this guard read 218 of 360 tables because "--.*$" strips
  // nothing from a CRLF line and one unbalanced "/*" ate the rest of the joined
  // corpus. Both inputs are reproduced here.
  const crlf = "create table if not exists public.ops_widgets (id uuid primary key);\r\n" +
    "-- revoke all on public.ops_widgets from anon, authenticated;\r\n" +
    "create policy ops_widgets_read on public.ops_widgets for select using (true);\r\n";
  const a = synth(crlf);
  assert(a.tables.has("ops_widgets"), "CRLF DDL was not parsed");
  assertEquals(a.revoked.size, 0, "a commented-out REVOKE must not count");
  assertEquals(a.violations.length, 2);
});

Deno.test("US-3350 self-check: the registry parser reads a Set literal, not prose", () => {
  const src = `
const SERVICE_ROLE_ONLY = new Set([
  // "not_a_table" is a comment and must not be read as an entry.
  "alpha_table",
  /* "also_not_a_table" */
  "beta_table",
]);
`;
  assertEquals(parseServiceRoleRegistry(src), ["alpha_table", "beta_table"]);
  assertEquals(parseServiceRoleRegistry("no registry here"), []);
});
