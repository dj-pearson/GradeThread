// The passport identity routes, driven end to end through the real supabase-js
// client against the in-memory PostgREST stand-in.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest } from "./_fake-postgrest.ts";

const db = installFakePostgrest();
const { passportIdentityRoutes } = await import("../routes/passport-identity.ts");

const ME = "11111111-1111-4111-8111-111111111111";

function app() {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", ME);
    await next();
  });
  a.route("/", passportIdentityRoutes);
  return a;
}

function seed() {
  db.reset({
    users: [{ id: ME, verified_enabled: true, verified_handle: "alpha" }],
    owner_nodes: [{
      id: "node-1",
      linked_user_id: ME,
      pseudonymous_label: "Owner #1",
      kind: "seller",
      identity_revealed: false,
      created_at: "2026-09-01T00:00:00Z",
    }],
    garments: [{
      id: "g-1",
      public_passport_slug: "ab12",
      sku_class: { brand: "Levi's" },
      current_owner_node_id: "node-1",
    }],
  });
}

Deno.test("GET /nodes reports garments_unavailable when the garment lookup fails", async () => {
  seed();
  db.failNext("garments", "GET");
  const res = await app().request("/nodes");
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.garments_unavailable, true);
  assertEquals(json.nodes.length, 1);
});

Deno.test("GET /nodes resolves garments when the lookup works", async () => {
  seed();
  const json = await (await app().request("/nodes")).json();
  assertEquals(json.garments_unavailable, false);
  assertEquals(json.nodes[0].passport_slug, "ab12");
});

Deno.test("POST reveal reads the Verified profile once", async () => {
  seed();
  const res = await app().request("/nodes/node-1/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revealed: true }),
  });
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.revealed_effective, true);
  assertEquals(db.calls.filter((c) => c.table === "users").length, 1);
});
