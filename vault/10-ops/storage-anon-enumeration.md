---
title: A storage SELECT policy gates list, not the public read
type: reference
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/tests/storage-anon-list_test.ts
  - supabase/migrations/00807_scope_storage_public_read_policies.sql
reviewed: 2026-09-19
tags: [ops, security, storage, supabase, rls]
summary: A public Supabase bucket is served on a superuser connection, so the SELECT policy on storage.objects controls only list, sign and metadata - which is why a TO-less policy let anon walk 7,057 objects, why tightening it cannot take a listing image dark, and what 00807 narrowed each of the five buckets to.
---

# A storage SELECT policy gates list, not the public read

Found 2026-09-11 (US-3397, out of US-3391). Reached from [[moc-ops]].

## The fact people get backwards

`storage.buckets.public = true` is what makes a bucket publicly readable.
The `FOR SELECT` policy on `storage.objects` is **not** what serves
`GET /storage/v1/object/public/...`.

storage-api handles that route on a **superuser** connection after checking
the bucket's `public` flag. In v1.14.6 - the build running on
`api.gradethread.com` - `getPublicObject.ts` calls
`request.storage.asSuperUser()` for both the bucket lookup and the object
lookup. `listObjects.ts` in the same build calls `request.storage.from(...)`,
the caller's own connection, so RLS applies there.

So the SELECT policy controls exactly three things:

| Route | RLS? |
|---|---|
| `GET /object/public/{bucket}/{path}` | no - superuser |
| `GET /object/authenticated/{bucket}/{path}` on a public bucket | no - superuser |
| `POST /object/list/{bucket}` | **yes** |
| `POST /object/sign/{bucket}/{path}` | **yes** |
| `GET /object/info/public/...` | no - superuser |

Measured, not inferred: probed through a real storage-api on the local
throwaway stack, on v1.68.10 and on prod's exact v1.14.6 image against the
same schema.

## What that cost

`00017` wrote `item-photos public read` as

```sql
CREATE POLICY "item-photos public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'item-photos');
```

with no `TO` clause. **A policy with no `TO` applies to every role**, `anon`
included - `pg_policies.roles` shows `{public}`, which is easy to read as
"this is the public-read policy, of course it says public".

`POST /storage/v1/object/list/item-photos` with the anon key that ships in the
deployed frontend bundle returned HTTP 200 and walked the whole tree.
Measured against prod 2026-09-11:

| Bucket | anon-enumerable objects | bytes |
|---|---|---|
| item-photos | 7,057 (3,557 under `_staging/`) | 3.509 GB (2.213 GB staged) |
| content-images | 124 | 0.348 GB |
| cert-assets | 44 | 0.014 GB |
| avatars, content-videos | 0 | - |
| the four private buckets | 0 (RLS filtered) | - |

Nobody had to have kept a URL. US-3391's figure of 3,557 was the `_staging/`
subset of one bucket.

## Why the obvious fix is the wrong one

Narrowing the policy by PATH - excluding `_staging/` - would have been
harmless-looking and wrong. `item_photos.storage_path` points **into**
`_staging/`, so live listing images that eBay is serving right now sit at
staging paths (US-3391). That fix is blocked behind the copy-on-adopt work,
and it was never needed: the public read does not consult the policy at all.

## The shape of the fix

`00794` does two different things:

- Nine policies get a role change only, via `ALTER POLICY ... TO authenticated`.
  `ALTER` rather than `DROP`/`CREATE` on purpose: it preserves whatever USING
  clause is live on prod instead of restating one from a migration that may
  have drifted.
- `item-photos public read` is dropped and recreated, because its scope changes
  too - owner folder (`(storage.foldername(name))[1] = auth.uid()::text`) or a
  workspace member of that owner. It deliberately says nothing about what comes
  after the first path segment.

Five of the ten were already harmless (`auth.uid()`-gated, so `anon` matched
nothing) and five were unconditional `USING (bucket_id = '...')`.

## What 00807 settled (US-3403, 2026-09-19)

00794 was going to leave any **authenticated** user able to enumerate
`avatars`, `cert-assets`, `content-images` and `content-videos`, because those
four got the role change only. Signup is open, so that was a real if much
smaller exposure.

`00807` closes all five instead, and **does not assume 00794 has run** - it is
`DROP POLICY IF EXISTS` then `CREATE` for each, correct whether or not 00794
ever lands. That matters: a file narrowing only the four smaller buckets would
have tidied two EMPTY ones while leaving the 3.5 GB one open to anon.

| Bucket | Who may list / sign | Why |
|---|---|---|
| `item-photos` | the owner folder, or a workspace member of that owner | enumeration exposes another seller's whole catalogue shape |
| `avatars` | the owner folder | public display is unaffected; what goes is listing every user id that has one |
| `cert-assets` | `public.is_admin()` | a certificate is meant to be SHAREABLE, not DISCOVERABLE IN BULK - a list is every certificate id ever issued |
| `content-images` | `public.is_admin()` | already who its INSERT/UPDATE/DELETE policies name |
| `content-videos` | `public.is_admin()` | same |

**Nothing in the app lost a capability**, checked rather than assumed: the only
`.list()` in the tree is `account-storage-purge.ts` on the service-role client,
which bypasses RLS, and every client-side `createSignedUrl` targets
`submission-images`. `src/test/storage-public-read-scope.test.ts` pins both.

**Measured on Postgres 16 carrying all 799 migrations**, RLS on, one
transaction per role with `set local role` and `request.jwt.claims` - which is
what `POST /object/list` does:

| Reader | before 00807 | after |
|---|---|---|
| `anon` | all 8 seeded objects across the five | **0** |
| a signed-up stranger | all 8 | 2, both in their own folders |
| the owner | all 8 | their own 3 |
| an admin | all 8 | the 3 published-content objects |

⚠ The **folder-shape guard** in the `item-photos` policy is load-bearing:
`((storage.foldername(name))[1])::uuid` RAISES on a path whose first segment is
not a uuid, and in a SELECT policy that is not row-local - it fails the whole
list for everybody. The UPDATE and DELETE policies carry the same cast
unguarded, which survives there because they run against one named object.

## The check that needs no credentials

```sql
-- Anything here applies to anon. Five rows are EXPECTED, not zero.
select policyname, cmd, roles
from pg_policies
where schemaname = 'storage' and roles::text like '%public%';
```

⚠ **This note used to say "expect 0 rows", and that was wrong** - it would have
read as a live finding forever. Five `{public}` policies remain after 00807 and
all five are `submission-images`, gated on `auth.uid()`, so `anon` matches
nothing. Proved rather than argued: as `anon`, `select count(*) from
storage.objects where bucket_id = 'submission-images'` returns 0 with two rows
seeded, and an `anon` INSERT is refused by RLS. What the query is actually for
is spotting a `{public}` policy whose USING tests **only** `bucket_id` - which
is the rule `storage-anon-list_test.ts` enforces on the source.

Read this off `pg_policies`, never off the migration that created it - see
[[migrations-process]] for why that distinction has bitten this repo before.

## Related

- [[deploy]] - migrations apply before the edge rolls.
- [[migrations-process]] - the held-migration rule 00794 is parked under.
