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

// Everything BELOW this number predates the rule; 00794 is the fix that brings
// all ten of them to `TO authenticated`, and it is itself in scope. The
// historical files are left alone on purpose: flagging them would produce a
// permanently red guard, which is the failure mode this repo keeps hitting.
// Do NOT raise this number to silence a failure.
const RATCHET_FROM = "00794";

const PUBLIC_BUCKETS = [
  "item-photos",
  "avatars",
  "cert-assets",
  "content-images",
  "content-videos",
] as const;

// ── half 1: the ratchet (always runs) ───────────────────────────────────────

type PolicyStatement = { file: string; name: string; hasToClause: boolean };

/** Every `create policy ... on storage.objects` statement in the tree. */
async function collectStoragePolicies(): Promise<PolicyStatement[]> {
  const out: PolicyStatement[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, MIGRATIONS_DIR));
    // Statement = from `create policy` to the first `;` that ends it. Policy
    // DDL has no inner semicolons, so this is exact rather than approximate.
    const re = /create\s+policy\s+("([^"]+)"|'([^']+)'|[a-z0-9_]+)([\s\S]*?);/gi;
    for (const m of sql.matchAll(re)) {
      const body = m[0];
      if (!/on\s+storage\.objects/i.test(body)) continue;
      const name = m[2] ?? m[3] ?? m[1] ?? "";
      out.push({
        file: entry.name,
        name,
        // `TO <role>` sits between the ON clause and FOR/USING/WITH CHECK.
        hasToClause: /\bto\s+(authenticated|anon|service_role|public|[a-z_]+)\b/i
          .test(body.replace(/on\s+storage\.objects/i, "")),
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

Deno.test("no NEW storage.objects policy may omit its TO clause", async () => {
  const policies = await collectStoragePolicies();
  const offenders = policies.filter((p) => {
    const prefix = p.file.slice(0, 5);
    return prefix >= RATCHET_FROM && !p.hasToClause;
  });
  assertEquals(
    offenders.map((p) => `${p.file}: "${p.name}"`),
    [],
    "A storage.objects policy with no TO clause applies to EVERY role, anon " +
      "included, and lets anyone with the bundled anon key enumerate the " +
      "bucket. Add `TO authenticated` (or the role you actually mean).",
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
