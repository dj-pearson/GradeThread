---
title: A storage SELECT policy gates list, not the public read
type: reference
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/tests/storage-anon-list_test.ts
reviewed: 2026-09-11
tags: [ops, security, storage, supabase, rls]
summary: A public Supabase bucket is served on a superuser connection, so the SELECT policy on storage.objects controls only list, sign and metadata - which is why a TO-less policy let anon walk 7,057 objects and why tightening it cannot take a listing image dark.
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

## What is still open after 00794

Any **authenticated** user can still enumerate `avatars`, `cert-assets`,
`content-images` and `content-videos`, because those four get the role change
only. Signup is open, so that is a real if much smaller exposure. Scoping them
needs a per-bucket decision about who legitimately reads them.

## The check that needs no credentials

```sql
-- expect 0 rows; anything here applies to anon
select policyname, cmd, roles
from pg_policies
where schemaname = 'storage' and roles::text like '%public%';
```

Read this off `pg_policies`, never off the migration that created it - see
[[migrations-process]] for why that distinction has bitten this repo before.

## Related

- [[deploy]] - migrations apply before the edge rolls.
- [[migrations-process]] - the held-migration rule 00794 is parked under.
