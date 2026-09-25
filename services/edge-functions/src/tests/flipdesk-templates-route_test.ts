// Listing templates route: a failed save must never clear the seller's default
// (US-1265 on the edge path), a name clash and a default clash get different
// codes, and a malformed id answers 404 before any query. Driven through the
// real route and the real supabase-js client against the in-memory PostgREST.
//
// Run alone:
//   deno test --allow-net --allow-env --allow-read src/tests/flipdesk-templates-route_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import {
  classifyUniqueViolation,
  flipdeskTemplatesRoutes,
} from "../routes/flipdesk-templates.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DEFAULT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAIN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function app() {
  const a = new Hono<{ Variables: { userId: string; workspaceOwnerId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    await next();
  });
  a.route("/", flipdeskTemplatesRoutes);
  return a;
}

async function send(method: string, path: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function seed(): Record<string, Row[]> {
  return {
    listing_templates: [
      { id: DEFAULT_ID, user_id: OWNER, name: "Denim", is_default: true, sort_order: 0 },
      { id: PLAIN_ID, user_id: OWNER, name: "Tees", is_default: false, sort_order: 1 },
      { id: FOREIGN_ID, user_id: OTHER, name: "Theirs", is_default: true, sort_order: 0 },
    ],
  };
}

function defaults(db: ReturnType<typeof installFakePostgrest>, owner = OWNER): unknown[] {
  return db.tables.listing_templates
    .filter((r) => r.user_id === owner && r.is_default === true)
    .map((r) => r.id);
}

const NAME_CLASH = {
  status: 409,
  code: "23505",
  message:
    'duplicate key value violates unique constraint "listing_templates_user_id_name_key"',
};
const DEFAULT_CLASH = {
  status: 409,
  code: "23505",
  message:
    'duplicate key value violates unique constraint "idx_listing_templates_one_default"',
};

Deno.test("POST as default with a taken name returns 409 and keeps the old default", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    db.failNext("listing_templates", "POST", NAME_CLASH);
    const r = await send("POST", "/", { name: "Denim", is_default: true });
    assertEquals(r.status, 409);
    assertEquals(r.json.code, "template_name_taken");
    assertEquals(defaults(db), [DEFAULT_ID]);
    assertEquals(
      db.writes("listing_templates").filter((w) => w.method === "PATCH").length,
      0,
      "no clear may run before the insert succeeds",
    );
  } finally {
    db.restore();
  }
});

Deno.test("PUT as default to an unknown id returns 404 and keeps the default", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    const r = await send("PUT", `/${crypto.randomUUID()}`, { name: "X", is_default: true });
    assertEquals(r.status, 404);
    assertEquals(defaults(db), [DEFAULT_ID]);
  } finally {
    db.restore();
  }
});

Deno.test("PUT as default to another tenant's id returns 404 and touches neither default", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    const r = await send("PUT", `/${FOREIGN_ID}`, { name: "pwned", is_default: true });
    assertEquals(r.status, 404);
    assertEquals(defaults(db), [DEFAULT_ID]);
    assertEquals(defaults(db, OTHER), [FOREIGN_ID]);
    assertEquals(db.tables.listing_templates.find((t) => t.id === FOREIGN_ID)?.name, "Theirs");
  } finally {
    db.restore();
  }
});

Deno.test("PUT as default moves the default to that row only", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    const r = await send("PUT", `/${PLAIN_ID}`, { name: "Tees", is_default: true });
    assertEquals(r.status, 200);
    assertEquals(r.json.template.is_default, true);
    assertEquals(defaults(db), [PLAIN_ID]);
    assertEquals(defaults(db, OTHER), [FOREIGN_ID]);
  } finally {
    db.restore();
  }
});

Deno.test("PUT with is_default false turns the default off in the same write", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    const r = await send("PUT", `/${DEFAULT_ID}`, { name: "Denim", is_default: false });
    assertEquals(r.status, 200);
    assertEquals(defaults(db), []);
  } finally {
    db.restore();
  }
});

Deno.test("POST as default makes the new row the only default", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    const r = await send("POST", "/", { name: "Shoes", is_default: true });
    assertEquals(r.status, 201);
    assertEquals(r.json.template.is_default, true);
    assertEquals(defaults(db), [r.json.template.id]);
  } finally {
    db.restore();
  }
});

Deno.test("POST: a failed clear returns 500 and never sets a second default", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    db.failNext("listing_templates", "PATCH");
    const r = await send("POST", "/", { name: "Shoes", is_default: true });
    assertEquals(r.status, 500);
    assertEquals(defaults(db), [DEFAULT_ID]);
  } finally {
    db.restore();
  }
});

Deno.test("a default-index clash is reported as a default conflict, not a name clash", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    db.failNext("listing_templates", "POST", DEFAULT_CLASH);
    const r = await send("POST", "/", { name: "Shoes" });
    assertEquals(r.status, 409);
    assertEquals(r.json.code, "template_default_conflict");
    assert(!/name/i.test(r.json.error), "a default clash must not tell the seller to rename");
  } finally {
    db.restore();
  }
});

Deno.test("classifyUniqueViolation reads the constraint from message or details", () => {
  assertEquals(classifyUniqueViolation({ code: "23505", message: DEFAULT_CLASH.message }), "template_default_conflict");
  assertEquals(
    classifyUniqueViolation({
      code: "23505",
      message: "duplicate key",
      details: "idx_listing_templates_one_default",
    }),
    "template_default_conflict",
  );
  assertEquals(classifyUniqueViolation({ code: "23505", message: NAME_CLASH.message }), "template_name_taken");
  assertEquals(classifyUniqueViolation({ code: "23505" }), "template_name_taken");
});

Deno.test("PUT and DELETE on a malformed id return 404 before any query", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    const put = await send("PUT", "/abc", { name: "X" });
    assertEquals(put.status, 404);
    const del = await send("DELETE", "/abc");
    assertEquals(del.status, 404);
    assertEquals(db.calls.length, 0);
  } finally {
    db.restore();
  }
});
