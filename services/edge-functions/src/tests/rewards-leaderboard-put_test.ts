// R4: PUT /api/rewards/leaderboard refuses a body it cannot read exactly.
//
// Driven through the real route and the real supabase-js client, answered by
// the in-memory PostgREST, so what is asserted is what a request actually does.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest } from "./_fake-postgrest.ts";
import { rewardsRoutes } from "../routes/rewards.ts";

const USER = "11111111-1111-4111-8111-111111111111";

function app() {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", USER);
    await next();
  });
  a.route("/", rewardsRoutes);
  return a;
}

async function put(body: unknown) {
  const res = await app().request("/leaderboard", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function seed(db: ReturnType<typeof installFakePostgrest>, row: Record<string, unknown>) {
  db.reset({ users: [{ id: USER, leaderboard_opt_in: false, leaderboard_alias: null, ...row }] });
}

Deno.test("R4: enabled must be a boolean, not the string 'true'", async () => {
  const db = installFakePostgrest();
  try {
    seed(db, { leaderboard_opt_in: true, leaderboard_alias: "Goblin" });
    const r = await put({ enabled: "true" });
    assertEquals(r.status, 400);
    assertEquals(db.writes("users").length, 0, "a bad body writes nothing");
    assertEquals(db.tables.users[0].leaderboard_opt_in, true, "still on the boards");
  } finally {
    db.restore();
  }
});

Deno.test("R4: a non-string alias is refused rather than treated as clear", async () => {
  const db = installFakePostgrest();
  try {
    seed(db, { leaderboard_alias: "Goblin" });
    const r = await put({ alias: 42 });
    assertEquals(r.status, 400);
    assertEquals(db.tables.users[0].leaderboard_alias, "Goblin");
  } finally {
    db.restore();
  }
});

Deno.test("R4: a hidden character comes back as a sentence the panel can show", async () => {
  const db = installFakePostgrest();
  try {
    seed(db, {});
    const r = await put({ alias: "Ali​ce" });
    assertEquals(r.status, 400);
    assert(typeof r.json.error === "string" && r.json.error.length > 0);
    assertEquals(db.writes("users").length, 0);
  } finally {
    db.restore();
  }
});

Deno.test("R4: clearing the only name while on the boards is refused", async () => {
  const db = installFakePostgrest();
  try {
    seed(db, { leaderboard_opt_in: true, leaderboard_alias: "Goblin" });
    const r = await put({ alias: "" });
    assertEquals(r.status, 400);
    assertEquals(db.tables.users[0].leaderboard_alias, "Goblin");

    // With a fallback name to publish instead, the clear is fine.
    seed(db, { leaderboard_opt_in: true, leaderboard_alias: "Goblin", rewards_display_name: "Fallback" });
    const ok = await put({ alias: null });
    assertEquals(ok.status, 200);
    assertEquals(ok.json.resolved_alias, "Fallback");
  } finally {
    db.restore();
  }
});

Deno.test("R4: a normal rename and a join still save", async () => {
  const db = installFakePostgrest();
  try {
    seed(db, {});
    const r = await put({ enabled: true, alias: "Thrift Goblin" });
    assertEquals(r.status, 200);
    assertEquals(r.json.opt_in, true);
    assertEquals(r.json.resolved_alias, "Thrift Goblin");
    const leave = await put({ enabled: false });
    assertEquals(leave.status, 200);
    assertEquals(leave.json.opt_in, false);
  } finally {
    db.restore();
  }
});
