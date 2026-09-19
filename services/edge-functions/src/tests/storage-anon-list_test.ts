// US-3397: anon must not be able to ENUMERATE a storage bucket.
//
// The hole: `00017` created `item-photos public read` as
// `CREATE POLICY ... FOR SELECT USING (bucket_id = 'item-photos')` with no
// `TO` clause. A policy with no `TO` applies to EVERY role, `anon` included.
// `POST /storage/v1/object/list/item-photos` with the anon key that ships in
// the deployed frontend bundle walked the whole tree: 7,057 objects / 3.5 GB
// on prod on 2026-09-11, of which 3,557 / 2.2 GB sat under `{owner}/_staging/`
// (files the Google Photos importer staged before the seller reviewed them).
// `cert-assets` (44) and `content-images` (124) were enumerable the same way.
//
// WHY THIS IS SAFE TO FIX, which is the part that looks wrong at first: a
// SELECT policy on storage.objects does NOT serve a public object read.
// storage-api answers `GET /object/public/...` on a SUPERUSER connection after
// checking `storage.buckets.public`. v1.14.6 (prod's build) calls
// `request.storage.asSuperUser()` for both the bucket and the object lookup.
// The SELECT policy gates `list`, `sign` and the metadata routes only. So
// tightening it cannot take a published listing image dark, and nothing here
// narrows an object PATH (live listing images sit under `_staging/` today).
//
// ── Why this file drives a SERVER and not the migration text ────────────────
// AC5, and the standing rule: read policies from pg_policies, not from the
// migration that created them. This repo has been bitten twice by that drift.
// The server that answers `list` is storage-api, not PostgREST;
// PostgREST never sees a storage request, so the live half below talks to storage-api.
// It is env-gated and SKIPS when no stack is configured, which is exactly the
// shape the tenant-isolation suite uses.
//
// HOW IT WAS RUN (2026-09-11, both storage-api builds, against the local
// throwaway stack with the full migration schema):
//
//   docker start supabase_storage_gradethread
//   STORAGE_LIST_BASE_URL=http://127.0.0.1:5000 \
//   STORAGE_LIST_ANON_KEY=<local anon key> \
//   STORAGE_LIST_REQUIRED=1 \
//   deno test --allow-net --allow-env --allow-read \
//     src/tests/storage-anon-list_test.ts
//
// Measured before 00794: list returned the whole bucket. After 00794: `[]` for
// anon AND for a logged-in stranger, while `GET /object/public/...` still
// returned the PNG with no key at all. Same result on v1.68.10 and on prod's
// v1.14.6.
//
// The always-on half is a RATCHET, not a repair: it fails the build if a NEW
// migration adds another storage.objects policy with no `TO` clause. It cannot
// see drift on a live database, and it does not pretend to.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../../../../", import.meta.url);
const MIGRATIONS_DIR = new URL("supabase/migrations/", REPO_ROOT);

// ⚠ THIS RATCHET POLICED NOTHING FOR ITS ENTIRE LIFE, AND IT REPORTED GREEN.
//
// It was `RATCHET_FROM = "00794"`, on the reasoning that 00794 brings all ten
// historical policies to `TO authenticated` and is itself in scope. 00794 was
// never written: it is parked on `held-v2/us-3397-00794`, which is on none of
// origin's 212 heads, and the migrations directory jumps 00793 -> 00796.
// Measured 2026-09-18: the highest-numbered migration touching storage.objects
// is 00463, so `prefix >= "00794"` selected ZERO policies out of 22. Two cases
// passed, one of them vacuously, and `deno test` printed ok.
//
// That is the exact failure this file's own header warns about one paragraph up
// ("a permanently red guard, which is the failure mode this repo keeps
// hitting") -- and the opposite error, a permanently GREEN one, is worse,
// because a red guard gets looked at.
//
// SO THE BASELINE IS NAMED, NOT NUMBERED. Every policy that exists today and
// breaks the rule is listed below with its file. Anything not on the list is in
// scope immediately, which is what a ratchet is for, and the list can only
// shrink: an entry that stops matching also fails, so fixing one forces its
// removal. No migration number gates it, so a held branch that never lands
// cannot disarm it again.
//
// AND THE RULE ITSELF WAS THE WRONG RULE. It asked whether a `TO` clause is
// PRESENT. A new bucket arriving with `TO authenticated USING (bucket_id =
// 'x')` -- precisely the shape US-3403 objects to, where any signed-up stranger
// can still enumerate the bucket -- satisfied that and always would have. The
// rule now asks whether the policy is unconditional on bucket_id alone,
// whatever role it names.
//
// AND THE SCAN READ EVERY STATEMENT AS LIVE, WHICH MADE THE BASELINE UNABLE TO
// CLEAR (US-3403, 2026-09-19). A policy is not the text of the first migration
// that created it; it is the text of the LAST one. 00807 drops and recreates
// all five with a scoped USING, and under the old scan the five original
// `create policy` statements in 00017, 00041, 00127, 00380 and 00463 still
// matched, so every baseline entry stayed satisfied and the shrink-only rule
// could never fire. The list would have gone on describing an exposure that
// had been closed -- which is the same defect as a stale note, with the added
// cost that it exempts any future policy reusing one of those names.
//
// So the corpus is now resolved IN MIGRATION ORDER: the last statement for a
// name wins, and a `drop policy` with no create after it removes the name
// entirely. That is what Postgres ends up with, and `pg_policies` on a stack
// carrying every migration is what proves it.
const KNOWN_UNSCOPED_SELECT: Record<string, string> = {
  // Empty since 00807 (US-3403). Every entry that was here is now scoped:
  // item-photos and avatars to the owner folder (plus workspace members for
  // item-photos), and cert-assets, content-images and content-videos to
  // public.is_admin(). Measured on a Postgres 16 carrying all 799 migrations:
  // anon listed 8 objects across the five buckets before and 0 after.
};

const PUBLIC_BUCKETS = [
  "item-photos",
  "avatars",
  "cert-assets",
  "content-images",
  "content-videos",
] as const;

// ── half 1: the ratchet (always runs) ───────────────────────────────────────

type PolicyStatement = {
  file: string;
  name: string;
  /** A `drop policy` rather than a `create policy`. Ends the name's life. */
  dropped: boolean;
  hasToClause: boolean;
  isSelect: boolean;
  /**
   * True when the USING clause tests nothing but bucket_id. That is the shape
   * that makes a bucket enumerable by whichever role the policy names, so it is
   * the property worth failing on rather than the presence of a TO clause.
   */
  bucketIdOnly: boolean;
  /** The USING expression as written, so a case can assert WHICH condition. */
  using: string;
};

/**
 * The storage.objects policies a fresh database ENDS UP WITH, not every
 * statement ever written.
 *
 * Migrations are replayed in filename order and the last statement for a name
 * wins, because that is what Postgres does. A `drop policy` with no create
 * after it removes the name. Without this, a policy fixed by a later
 * migration still reads as broken from the file that first created it, and
 * the shrink-only baseline below can never clear.
 */
async function collectStoragePolicies(): Promise<PolicyStatement[]> {
  const all = await collectAllStoragePolicyStatements();
  const effective = new Map<string, PolicyStatement>();
  for (const stmt of all) {
    if (stmt.dropped) effective.delete(stmt.name);
    else effective.set(stmt.name, stmt);
  }
  return [...effective.values()];
}

/** Every statement, in migration order, drops included. */
async function collectAllStoragePolicyStatements(): Promise<PolicyStatement[]> {
  const out: PolicyStatement[] = [];
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  // Filename order IS apply order: the NNNNN prefix is the version.
  names.sort();
  for (const name of names) {
    const entry = { name };
    const sql = await Deno.readTextFile(new URL(entry.name, MIGRATIONS_DIR));
    for (
      const m of sql.matchAll(
        /drop\s+policy\s+(?:if\s+exists\s+)?("([^"]+)"|'([^']+)'|[a-z0-9_]+)\s+on\s+storage\.objects/gi,
      )
    ) {
      out.push({
        file: entry.name,
        name: m[2] ?? m[3] ?? m[1] ?? "",
        hasToClause: false,
        isSelect: false,
        bucketIdOnly: false,
        using: "",
        dropped: true,
      });
    }
    // Statement = from `create policy` to the first `;` that ends it. Policy
    // DDL has no inner semicolons, so this is exact rather than approximate.
    const re = /create\s+policy\s+("([^"]+)"|'([^']+)'|[a-z0-9_]+)([\s\S]*?);/gi;
    for (const m of sql.matchAll(re)) {
      const body = m[0];
      if (!/on\s+storage\.objects/i.test(body)) continue;
      const name = m[2] ?? m[3] ?? m[1] ?? "";
      const afterOn = body.replace(/on\s+storage\.objects/i, "");
      // The USING expression, up to WITH CHECK or the statement's end.
      const using = /\busing\s*\(([\s\S]*?)\)\s*(?:with\s+check|;\s*$)/i.exec(
        `${body}`,
      )?.[1] ?? /\busing\s*\(([\s\S]*)\)\s*;/i.exec(body)?.[1] ?? "";
      out.push({
        dropped: false,
        file: entry.name,
        name,
        // `TO <role>` sits between the ON clause and FOR/USING/WITH CHECK.
        hasToClause: /\bto\s+(authenticated|anon|service_role|public|[a-z_]+)\b/i
          .test(afterOn),
        // A policy with no FOR is FOR ALL, which includes SELECT.
        isSelect: !/\bfor\s+(insert|update|delete)\b/i.test(afterOn),
        // Strip the bucket_id test and see whether ANY other condition remains.
        // `auth.uid()`, `storage.foldername(...)`, `is_admin()` all leave one.
        using,
        bucketIdOnly:
          using.trim().length > 0 &&
          using
            .replace(/bucket_id\s*=\s*'[^']*'/gi, "")
            .replace(/[\s()]|\band\b|\btrue\b/gi, "")
            .length === 0,
      });
    }
  }
  return out;
}

Deno.test("storage.objects policies: the scan finds the real corpus", async () => {
  const policies = await collectStoragePolicies();
  // Fail closed: a regex that stops matching would otherwise report a clean
  // tree. There were 22 of these when this was written.
  assert(
    policies.length >= 20,
    `expected to find the storage.objects policy corpus, saw ${policies.length}`,
  );
  assert(
    policies.some((p) => p.name === "item-photos public read"),
    "the scan did not find the policy this story is about",
  );
});

Deno.test("no NEW storage.objects SELECT policy may be unconditional on bucket_id", async () => {
  const policies = await collectStoragePolicies();
  const offenders = policies.filter(
    (p) => p.isSelect && p.bucketIdOnly && !(p.name in KNOWN_UNSCOPED_SELECT),
  );
  assertEquals(
    offenders.map((p) => `${p.file}: "${p.name}"`),
    [],
    "A storage.objects SELECT policy whose USING clause tests nothing but " +
      "bucket_id lets every role it names enumerate the whole bucket. With no " +
      "TO clause that is anon, so the bundled key is enough; with " +
      "`TO authenticated` it is any stranger who signed up, which is US-3403. " +
      "Scope it: an owner-folder test ((storage.foldername(name))[1] = " +
      "(select auth.uid())::text) or public.is_admin(). If it is genuinely " +
      "meant to be world-readable, that read goes through " +
      "/object/public/<bucket>, which consults no policy at all.",
  );
});

Deno.test("the unscoped-SELECT baseline shrinks and never grows", async () => {
  // A baseline that can stay stale is a baseline nobody clears. Each entry has
  // to keep matching a real policy in the file it names, so fixing one forces
  // its removal here, and a rename cannot leave a dead entry behind that
  // silently exempts a new policy of the same name.
  const policies = await collectStoragePolicies();
  const stale: string[] = [];
  for (const [name, file] of Object.entries(KNOWN_UNSCOPED_SELECT)) {
    const hit = policies.find((p) => p.name === name && p.file === file);
    if (!hit) stale.push(`${name} (expected in ${file}) no longer exists`);
    else if (!hit.bucketIdOnly) stale.push(`${name} in ${file} is now scoped`);
  }
  assertEquals(
    stale,
    [],
    "Remove the fixed entries from KNOWN_UNSCOPED_SELECT. This list is the " +
      "record of what is still exposed, so a stale entry overstates the " +
      "problem and, worse, exempts any future policy reusing that name.",
  );
});

Deno.test("no storage.objects SELECT policy is unconditional any more", async () => {
  // THIS REPLACES A CASE THAT WOULD NOW PASS VACUOUSLY. It used to assert the
  // set of unscoped policies EQUALS the baseline; with 00807 both are empty,
  // so the equality holds while asserting nothing -- the failure this file's
  // own header calls worse than a red guard. The positive form is the one
  // worth keeping: nothing is unconditional, stated directly.
  const policies = await collectStoragePolicies();
  const unscoped = policies.filter((p) => p.isSelect && p.bucketIdOnly);
  assertEquals(
    unscoped.map((p) => `${p.file}: "${p.name}"`).sort(),
    [],
    "A storage.objects SELECT policy is unconditional on bucket_id again.",
  );
  assertEquals(
    Object.keys(KNOWN_UNSCOPED_SELECT),
    [],
    "KNOWN_UNSCOPED_SELECT is empty since 00807 and should stay that way. " +
      "An entry added here exempts a policy from the rule above.",
  );
});

Deno.test("the five public buckets are scoped, each to the reader it named", async () => {
  // Not "they have a condition" -- WHICH condition, because the per-bucket
  // decision is the whole of US-3403 and a later edit could satisfy the rule
  // above while quietly widening one of them back out.
  const byName = new Map(
    (await collectStoragePolicies()).map((p) => [p.name, p]),
  );
  const EXPECTED: Record<string, RegExp> = {
    // The seller's own folder, or a member of that seller's workspace.
    "item-photos public read": /is_workspace_member\(/i,
    // The owner's own folder. Public display is unaffected either way.
    "avatars public read": /foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)/i,
    // Shareable, not discoverable in bulk: a list is every certificate id.
    "cert-assets public read": /is_admin\(\)/i,
    // Admin-only, which is who their write policies already name.
    "content-images public read": /is_admin\(\)/i,
    "content-videos public read": /is_admin\(\)/i,
  };
  for (const [name, want] of Object.entries(EXPECTED)) {
    const policy = byName.get(name);
    assert(policy, `"${name}" no longer exists`);
    assert(
      !policy.bucketIdOnly,
      `"${name}" is unconditional on bucket_id again (${policy.file})`,
    );
    assert(
      want.test(policy.using),
      `"${name}" in ${policy.file} no longer gates on ${want.source}`,
    );
    // `TO authenticated` is belt and braces over the condition, and its
    // absence is what made this an anon exposure rather than a smaller one.
    assert(policy.hasToClause, `"${name}" lost its TO clause (${policy.file})`);
  }
});

Deno.test("a later migration supersedes an earlier policy of the same name", async () => {
  // The scan's own mechanism, asserted rather than trusted. If the effective
  // resolution broke, every case above would go back to reading 00017's
  // original unscoped statement and this file would report an exposure that
  // no longer exists -- or, once the baseline is empty, report it as a
  // failure nobody can clear.
  const all = await collectAllStoragePolicyStatements();
  const creates = all.filter((p) => p.name === "item-photos public read" && !p.dropped);
  assert(
    creates.length >= 2,
    "expected item-photos public read to be created by 00017 and again by " +
      `00807, saw ${creates.length}`,
  );
  const effective = (await collectStoragePolicies())
    .find((p) => p.name === "item-photos public read");
  assert(effective, "the effective item-photos policy vanished");
  assertEquals(
    effective.file,
    "00807_scope_storage_public_read_policies.sql",
    "the scan is reading an earlier statement as live",
  );
});

// ── half 2: the live check (env-gated) ──────────────────────────────────────

const BASE_URL = Deno.env.get("STORAGE_LIST_BASE_URL");
const ANON_KEY = Deno.env.get("STORAGE_LIST_ANON_KEY");
const REQUIRED = Boolean(Deno.env.get("STORAGE_LIST_REQUIRED"));
const CONFIGURED = Boolean(BASE_URL && ANON_KEY);
// `{bucket}/{path}` of an object known to exist, e.g.
// `item-photos/<uuid>/_staging/x.png`. Optional: without it the read half of
// the assertion is skipped rather than guessed at.
const PUBLIC_OBJECT = Deno.env.get("STORAGE_LIST_PUBLIC_OBJECT");

Deno.test({
  name: "live storage fixture is configured when it is required",
  ignore: !REQUIRED,
  fn: () => {
    assert(
      CONFIGURED,
      "STORAGE_LIST_REQUIRED is set but STORAGE_LIST_BASE_URL + " +
        "STORAGE_LIST_ANON_KEY are not both present",
    );
  },
});

async function listAsAnon(bucket: string): Promise<{ status: number; rows: unknown[] }> {
  const res = await fetch(`${BASE_URL}/object/list/${bucket}`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY ?? "",
      Authorization: `Bearer ${ANON_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }),
  });
  const text = await res.text();
  let rows: unknown[] = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    // A non-JSON body is a refusal, which is the outcome we want anyway.
  }
  return { status: res.status, rows };
}

for (const bucket of PUBLIC_BUCKETS) {
  Deno.test({
    name: `anon cannot enumerate ${bucket}`,
    ignore: !CONFIGURED,
    fn: async () => {
      const { status, rows } = await listAsAnon(bucket);
      // Either shape is a pass: storage-api answers 200 with an empty array
      // when RLS filters everything out, and 4xx if the route is denied.
      assert(
        status >= 400 || rows.length === 0,
        `anon listed ${rows.length} entries in ${bucket} (HTTP ${status}). ` +
          `The SELECT policy on storage.objects for this bucket is missing ` +
          `its TO clause, or has drifted from the migration that created it.`,
      );
    },
  });
}

Deno.test({
  name: "a public object still reads with NO key at all",
  ignore: !CONFIGURED || !PUBLIC_OBJECT,
  fn: async () => {
    // This is the half that would catch an over-tightening. A public bucket is
    // served on a superuser connection, so no SELECT policy should be able to
    // break it; assert that rather than trusting it.
    const res = await fetch(`${BASE_URL}/object/public/${PUBLIC_OBJECT}`);
    const body = await res.arrayBuffer();
    assertEquals(
      res.status,
      200,
      `public read of ${PUBLIC_OBJECT} returned ${res.status}. If this went ` +
        `red after a policy change, the change narrowed something that ` +
        `serves live listing imagery.`,
    );
    assert(body.byteLength > 0, "public read returned an empty body");
  },
});
