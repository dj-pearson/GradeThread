---
name: tenant-isolation
description: "Use when writing or editing ANY edge route or lib that queries a multi-tenant table with the service-role client (services/edge-functions/**): submissions, grade_reports, inventory_items, listings, sales, item_photos, marketplace_connections, api_keys, human_reviews, and friends. Encodes US-268: the explicit-scoping rule, ownership-via-parent, the tenant-isolation_test.ts case rule, and rls-guard registration for operator tables."
metadata:
  author: gradethread
  version: "1.0.0"
---

# GradeThread tenant isolation — US-268 (MANDATORY)

The edge service uses the **service-role client, which BYPASSES RLS**. Nothing
protects tenants except the discipline below. Per-request RLS was evaluated
and deliberately rejected (webhooks/jobs have no JWT; workspace members
legitimately act across the owner's tenant) — the defense is explicit scoping
PLUS the regression suite, not edge RLS.

## The rule

Every query on a multi-tenant table must be either:

1. **Directly scoped**: `.eq("user_id", ownerId)` where
   `const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");`
   (ALWAYS this exact resolution — a member acting in a workspace targets the
   OWNER's tenant, not their own id), **or**
2. **Scoped via an owner-verified parent** — load the parent row filtered by
   ownerId first, then key child reads/writes on the parent's id (the
   `loadListingOwned` / `assemblePublishContext` pattern in flipdesk-ebay.ts).

NEVER `update`/`delete`/`select`-by-id using an id from the request body
without one of the two. An id is attacker-controlled input.

## Patterns

```ts
// Direct scope — reads AND writes:
await supabaseAdmin.from("inventory_items")
  .update(patch).eq("id", itemId).eq("user_id", ownerId);

// Ownership-via-parent:
const listing = await loadListingOwned(listingId, ownerId); // .eq user_id inside
if (!listing) return c.json({ error: "Not found" }, 404);
await supabaseAdmin.from("item_photos")
  .select("*").eq("inventory_item_id", listing.inventory_item_id);

// Storage-path tenancy (staging uploads, verify-groups):
if (!path.startsWith(`${ownerId}/_staging/`)) return c.json({...}, 403);
// Check the prefix BEFORE any DB/AI work.
```

Webhooks/cron/jobs: no JWT — resolve the tenant from the resource itself
(e.g. the connection row the webhook key maps to), never from payload fields.

## The test rule

**Every new edge route that touches a multi-tenant table gets a case in
`services/edge-functions/src/tests/tenant-isolation_test.ts`** proving a
foreign-tenant id / path is rejected (404/403, not data). A route without a
case is unreviewable — add the case in the same commit as the route.

## Operator tables (no tenant data)

Deny-all tables written only by the service role must be registered in
`SERVICE_ROLE_ONLY` in `rls-guard_test.ts`, and must keep the literal token
`user_id` out of the CREATE TABLE block.

**Full rule, including why a COMMENT saying `user_id` trips discovery while a
column named `owner_user_id` does not:**
`vault/20-domain/service-role-tables.md`.

## Review checklist for an edge diff

1. Every `.from("<multi-tenant table>")` in the diff: scoped or
   parent-verified? (grep the diff for `.from(` and check each.)
2. Any id/path from the request body used in a filter? Must pass rule 1 or 2
   first — or a prefix check for storage paths.
3. `workspaceOwnerId ?? userId` used (not bare `userId`) wherever workspace
   members can act?
4. New route → tenant-isolation_test.ts case added?
5. New operator table → rls-guard registration?
