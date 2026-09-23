// INV-4: DELETE /api/flipdesk/listings/item/:id fails CLOSED and is admin-only.
//
// Two defects, both on the one route that hard-deletes an inventory item
// through the service-role client:
//
//   • The listings and sales guard reads dropped their `error`. A failed read
//     returned no rows, which reads exactly like "no live listing, no sales",
//     so both guards passed and the delete cascaded the item's sales and
//     orphaned a live marketplace listing.
//   • Nothing checked the workspace role. RLS reserves DELETE on
//     inventory_items for admins (00042), but the service-role client skips
//     RLS, so any member could hard-delete the owner's inventory here.
//
// These DRIVE the route: a stubbed PostgREST layer fails one read at a time,
// and every test asserts how many DELETEs reached the database.
//
//   deno test --allow-net --allow-env --allow-read src/tests/delete-item-guards_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

type Fail = "none" | "item" | "listings" | "sales";
let fail: Fail = "none";
let deletes: string[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function pgError(message: string): Response {
  return json({ code: "XX000", message, details: null, hint: null }, 500);
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
  if (!url.includes("/rest/v1/") && !url.includes("/storage/v1/")) return realFetch(input, init);
  if (method === "DELETE") {
    deletes.push(url);
    return Promise.resolve(json([], 200));
  }
  if (url.includes("/rest/v1/inventory_items")) {
    if (fail === "item") return Promise.resolve(pgError("could not read inventory_items"));
    return Promise.resolve(json(wantsObject ? { id: ITEM_ID, title: "Jacket" } : [{ id: ITEM_ID }]));
  }
  if (url.includes("/rest/v1/listings")) {
    if (fail === "listings") return Promise.resolve(pgError("could not read listings"));
    return Promise.resolve(json([]));
  }
  if (url.includes("/rest/v1/sales")) {
    if (fail === "sales") return Promise.resolve(pgError("could not read sales"));
    return Promise.resolve(json(null, 200, { "Content-Range": "*/0" }));
  }
  return Promise.resolve(json([]));
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const { flipdeskListingsRoutes } = await import("../routes/flipdesk-listings.ts");

type Role = "viewer" | "member" | "listing_manager" | "admin" | "owner";
function appAs(role: Role) {
  // Stands in for auth + workspaceMiddleware, which main.ts mounts ahead of
  // this router on /api/flipdesk/listings/*.
  // deno-lint-ignore no-explicit-any
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("workspaceOwnerId", OWNER);
    c.set("workspaceRole", role);
    await next();
  });
  app.route("/", flipdeskListingsRoutes);
  return app;
}

async function del(role: Role, mode: Fail): Promise<Response> {
  fail = mode;
  deletes = [];
  return await appAs(role).request(`/item/${ITEM_ID}`, { method: "DELETE" });
}

Deno.test("an admin deleting a clean item reaches the delete", async () => {
  const res = await del("admin", "none");
  assertEquals(res.status, 200);
  assertEquals(deletes.filter((u) => u.includes("/rest/v1/inventory_items")).length, 1);
});

Deno.test("a failed LISTINGS read returns 500 and deletes nothing", async () => {
  const res = await del("owner", "listings");
  await res.body?.cancel();
  assertEquals(res.status, 500);
  assertEquals(deletes, [], "a guard that could not be read must not pass");
});

Deno.test("a failed SALES read returns 500 and deletes nothing", async () => {
  const res = await del("owner", "sales");
  await res.body?.cancel();
  assertEquals(res.status, 500);
  assertEquals(deletes, [], "sales cascade on delete; an unread guard must stop it");
});

Deno.test("a failed ITEM read is a 500, not 'Item not found'", async () => {
  const res = await del("owner", "item");
  const body = await res.json() as { error?: string };
  assertEquals(res.status, 500);
  assertEquals(body.error === "Item not found.", false);
  assertEquals(deletes, []);
});

Deno.test("a listing_manager gets 403 and nothing is read or deleted", async () => {
  for (const role of ["listing_manager", "member", "viewer"] as const) {
    const res = await del(role, "none");
    await res.body?.cancel();
    assertEquals(res.status, 403, `${role} must not hard-delete`);
    assertEquals(deletes, []);
  }
});
