// DEV-05: POST /api/oauth/connections/:id/revoke with an id that is not a
// uuid. It used to reach `.eq("id", id)`, Postgres answered 22P02, and the
// route logged an error-level failure and returned 500. It now answers the
// same way as a foreign or already-revoked id, without touching the database.
//
// The foreign-id half lives in tenant-isolation_test.ts, against a live stack.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { handleListOAuthConnections, handleRevokeOAuthConnection } from "../routes/oauth.ts";

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    // deno-lint-ignore no-explicit-any
    (c as any).set("userId", "11111111-1111-1111-1111-111111111111");
    await next();
  });
  a.get("/api/oauth/connections", (c) => handleListOAuthConnections(c));
  a.post("/api/oauth/connections/:id/revoke", (c) => handleRevokeOAuthConnection(c));
  return a;
}

Deno.test("revoke: a malformed id answers already:true with no query and no error log", async () => {
  // deno-lint-ignore no-explicit-any
  const rest = (supabaseAdmin as any).rest;
  let queried = 0;
  rest.from = () => {
    queried++;
    throw new Error("the database must not be reached for a malformed id");
  };
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    for (const id of ["not-a-uuid", "1", "' or 1=1 --", "11111111-1111-1111-1111-11111111111Z"]) {
      const res = await app().request(
        `/api/oauth/connections/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      );
      assertEquals(res.status, 200, `status for ${id}`);
      assertEquals(await res.json(), { revoked: true, already: true });
    }
    assertEquals(queried, 0);
    assertEquals(errors.length, 0, `error logged: ${JSON.stringify(errors)}`);
  } finally {
    console.error = originalError;
    delete rest.from;
  }
});

Deno.test("revoke: a well-formed id still reaches the owner-scoped update", async () => {
  // deno-lint-ignore no-explicit-any
  const rest = (supabaseAdmin as any).rest;
  const filters: Array<[string, unknown]> = [];
  rest.from = () => {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      update: () => b,
      eq: (col: string, val: unknown) => (filters.push([col, val]), b),
      is: () => b,
      select: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  };
  try {
    const id = "22222222-2222-2222-2222-222222222222";
    const res = await app().request(`/api/oauth/connections/${id}/revoke`, { method: "POST" });
    assertEquals(res.status, 200);
    assert(filters.some(([c, v]) => c === "id" && v === id));
    assert(filters.some(([c, v]) => c === "owner_user_id" && v === "11111111-1111-1111-1111-111111111111"));
  } finally {
    delete rest.from;
  }
});

Deno.test("list: the grant read is filtered on the session user", async () => {
  // deno-lint-ignore no-explicit-any
  const rest = (supabaseAdmin as any).rest;
  const filters: Array<[string, unknown]> = [];
  rest.from = () => {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => (filters.push([col, val]), b),
      is: () => b,
      order: () => b,
      limit: () => Promise.resolve({ data: [], error: null }),
    };
    return b;
  };
  try {
    const res = await app().request("/api/oauth/connections");
    assertEquals(res.status, 200);
    assert(filters.some(([c, v]) => c === "owner_user_id" && v === "11111111-1111-1111-1111-111111111111"));
  } finally {
    delete rest.from;
  }
});
