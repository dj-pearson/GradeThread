// IMP-07: the import tier of the body limit. POST /api/flipdesk/import/runs
// carries up to MAX_IMPORT_ROWS mapped rows in one JSON body, which the 256 KB
// JSON tier refused long before the row cap could be reached.
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { bodyLimit, capForPath, IMPORT_MAX_BYTES, JSON_MAX_BYTES } from "../middleware/body-limit.ts";
import { MAX_IMPORT_ROWS } from "../lib/inventory-import.ts";

function app() {
  const a = new Hono();
  a.use("/api/*", bodyLimit);
  a.post("/api/*", async (c) => {
    const text = await c.req.text();
    return c.json({ bytes: text.length });
  });
  return a;
}

function bigJson(bytes: number): string {
  return JSON.stringify({ rows: [{ title: "x".repeat(bytes) }] });
}

Deno.test("a 3 MB import POST passes the body limit", async () => {
  const body = bigJson(3 * 1024 * 1024);
  const res = await app().request("/api/flipdesk/import/runs", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  });
  assertEquals(res.status, 200);
});

Deno.test("a 3 MB body to another flipdesk route still gets a 413", async () => {
  const body = bigJson(3 * 1024 * 1024);
  const res = await app().request("/api/flipdesk/import/link/scan", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  });
  assertEquals(res.status, 413);
});

Deno.test("the import tier is exact: one path, POST only", () => {
  assertEquals(capForPath("/api/flipdesk/import/runs", "POST"), IMPORT_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/import/runs/abc/undo", "POST"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/import/runs", "PATCH"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/items", "POST"), JSON_MAX_BYTES);
});

Deno.test("the import tier fits the row cap at 1,500 bytes a row", () => {
  assert(IMPORT_MAX_BYTES >= MAX_IMPORT_ROWS * 1500);
});
