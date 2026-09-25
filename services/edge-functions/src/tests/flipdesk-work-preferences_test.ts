// WMT-01: PATCH /api/flipdesk/work-preferences writes only the fields it was
// sent. Driven through the real route and the real supabase-js client, answered
// by the in-memory PostgREST, so the assertion is on what a request stores.
//
// Run alone:
//   deno test --allow-net --allow-env --allow-read src/tests/flipdesk-work-preferences_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest } from "./_fake-postgrest.ts";
import {
  flipdeskWorkPreferencesRoutes,
  patchToColumns,
} from "../routes/flipdesk-work-preferences.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";

function app() {
  const a = new Hono<{ Variables: { userId: string; workspaceOwnerId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    await next();
  });
  a.route("/", flipdeskWorkPreferencesRoutes);
  return a;
}

async function patch(body: unknown) {
  const res = await app().request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const STORED = {
  id: "row-1",
  user_id: OWNER,
  default_session_minutes: 30,
  work_context: "home",
  available_tools: ["measuring_tape", "camera"],
  hourly_target_amount: 25,
  hourly_target_currency: "USD",
  settings_version: 1,
};

Deno.test("WMT-01: a failed read can't reset the tools on a minutes save", async () => {
  const db = installFakePostgrest();
  try {
    db.reset({ flipdesk_work_preferences: [{ ...STORED }] });
    // If the route still read-then-merged, this failure would hand it the
    // camera-only defaults and it would write them back.
    db.failNext("flipdesk_work_preferences", "GET");
    const r = await patch({ default_session_minutes: 45 });
    assertEquals(r.status, 200);
    const row = db.tables.flipdesk_work_preferences[0];
    assertEquals(row.default_session_minutes, 45);
    assertEquals(row.available_tools, ["measuring_tape", "camera"]);
    assertEquals(row.work_context, "home");
    assertEquals(row.hourly_target_amount, 25);
    const sent = db.writes("flipdesk_work_preferences")[0].body as Record<string, unknown>;
    assert(!("available_tools" in sent), "the write must not name available_tools");
    assert(!("hourly_target_amount" in sent), "the write must not name hourly_target_amount");
  } finally {
    db.restore();
  }
});

Deno.test("WMT-01: two single-field saves both survive", async () => {
  const db = installFakePostgrest();
  try {
    db.reset({ flipdesk_work_preferences: [{ ...STORED }] });
    assertEquals((await patch({ work_context: "phone_only" })).status, 200);
    const r = await patch({ available_tools: ["camera", "steamer"] });
    assertEquals(r.status, 200);
    const row = db.tables.flipdesk_work_preferences[0];
    assertEquals(row.work_context, "phone_only");
    assertEquals(row.available_tools, ["camera", "steamer"]);
    // And the response is the stored row, not a guess.
    assertEquals(r.json.work_context, "phone_only");
  } finally {
    db.restore();
  }
});

Deno.test("WMT-01: clearing the hourly target names only that column", () => {
  assertEquals(patchToColumns({ hourlyTargetAmount: null }), {
    hourly_target_amount: null,
  });
  assertEquals(patchToColumns({ defaultSessionMinutes: 45 }), {
    default_session_minutes: 45,
  });
});
