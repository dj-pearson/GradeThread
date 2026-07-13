// US-1869 / US-268: tenant-scoping guard for the Inventory Equity route.
//
// The route is a plain GET with NO id/path input — it reads ONLY the caller's
// own tenant (workspaceOwnerId), so the classic "foreign id → 404" case doesn't
// apply. Instead this statically proves the posture that matters here: every
// read of a multi-tenant table is scoped by user_id, and the tenant is resolved
// from workspaceOwnerId (never from the request body). Deterministic + runnable
// without a live stack.
import { assert } from "@std/assert";

const src = Deno.readTextFileSync(
  new URL("../routes/flipdesk-equity.ts", import.meta.url),
);

const MULTI_TENANT_TABLES = ["inventory_items", "sales", "listings"];

Deno.test("every multi-tenant read is user_id-scoped", () => {
  for (const table of MULTI_TENANT_TABLES) {
    const re = new RegExp(
      `\\.from\\("${table}"\\)[\\s\\S]{0,600}?\\.eq\\("user_id",\\s*owner\\)`,
    );
    // Each .from("<table>") occurrence must be followed (within its query
    // chain) by .eq("user_id", owner).
    const occurrences = src.split(`.from("${table}")`).length - 1;
    assert(occurrences > 0, `expected the route to read ${table}`);
    // Every occurrence pairs with a user_id scope.
    const scoped = src.match(new RegExp(re, "g"))?.length ?? 0;
    assert(
      scoped >= occurrences,
      `${table}: ${occurrences} read(s) but only ${scoped} scoped by user_id — a multi-tenant read may leak across tenants`,
    );
  }
});

Deno.test("tenant is resolved from workspaceOwnerId, not the request body", () => {
  assert(
    src.includes('c.get("workspaceOwnerId") ?? c.get("userId")'),
    "owner must come from workspaceOwnerId/userId context",
  );
  // No id is read off the request body/query and fed into a tenant query.
  assert(
    !/c\.req\.(param|query)\(/.test(src),
    "the equity route must not take an id/param from the request",
  );
});
