// The Verified profile routes, driven end to end through the real supabase-js
// client against the in-memory PostgREST stand-in.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest } from "./_fake-postgrest.ts";

const db = installFakePostgrest();
const { verifiedRoutes } = await import("../routes/verified.ts");

const ME = "11111111-1111-4111-8111-111111111111";

function app() {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", ME);
    await next();
  });
  a.route("/", verifiedRoutes);
  return a;
}

async function get(path: string) {
  const res = await app().request(path);
  return { status: res.status, json: await res.json() };
}

Deno.test("GET /profile never pre-fills the account's full_name as the public name", async () => {
  db.reset({
    users: [{
      id: ME,
      full_name: "Jane Q. Legal",
      verified_display_name: null,
      verified_handle: null,
      verified_enabled: false,
    }],
  });
  const { status, json } = await get("/profile");
  assertEquals(status, 200);
  assertEquals(json.profile.display_name, null);
  // Offered separately, so the seller can CHOOSE to use it.
  assertEquals(json.profile.account_name, "Jane Q. Legal");
});

Deno.test("GET /profile keeps a chosen display name", async () => {
  db.reset({
    users: [{
      id: ME,
      full_name: "Jane Q. Legal",
      verified_display_name: "Jane's Closet",
    }],
  });
  const { json } = await get("/profile");
  assertEquals(json.profile.display_name, "Jane's Closet");
});

Deno.test("GET /handle-available fails closed when the lookup errors", async () => {
  db.reset({ users: [] });
  db.failNext("users", "GET");
  const { status, json } = await get("/handle-available?handle=new-store");
  assertEquals(status, 503);
  assertEquals(json.available, false);
  assertEquals(json.reason, "Couldn't check right now. Try again.");
});
