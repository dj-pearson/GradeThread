// IMP-09: starting an import, undoing one and starting a closet read need
// manage_inventory (listing_manager and up). A 'member' used to pass because
// the only guard on these paths was blockViewerWrites.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { requireWorkspaceRoleForWrites } from "../middleware/workspace.ts";
import type { WorkspaceRole } from "../lib/workspace-roles.ts";

const main = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));

const GUARDED = [
  "/api/flipdesk/import/runs",
  "/api/flipdesk/import/runs/:id/undo",
  "/api/flipdesk/closet-import/runs",
];

Deno.test("main.ts mounts the listing_manager write floor on each import write path", () => {
  const firstWorkspace = main.indexOf('app.use("/api/flipdesk/import/*", workspaceMiddleware)');
  assert(firstWorkspace > 0);
  for (const path of GUARDED) {
    const mount = `app.use("${path}", requireWorkspaceRoleForWrites("listing_manager"));`;
    const at = main.indexOf(mount);
    assert(at > 0, `missing: ${mount}`);
    assert(at > firstWorkspace, `${path}: the floor must run after workspaceMiddleware`);
  }
});

function app(role: WorkspaceRole) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    // deno-lint-ignore no-explicit-any
    (c as any).set("workspaceRole", role);
    await next();
  });
  a.use("/api/flipdesk/import/runs", requireWorkspaceRoleForWrites("listing_manager"));
  a.use("/api/flipdesk/import/runs/:id/undo", requireWorkspaceRoleForWrites("listing_manager"));
  a.all("*", (c) => c.json({ ok: true }));
  return a;
}

Deno.test("a member gets 403 on POST /runs and on undo", async () => {
  const a = app("member");
  assertEquals((await a.request("/api/flipdesk/import/runs", { method: "POST" })).status, 403);
  assertEquals((await a.request("/api/flipdesk/import/runs/x/undo", { method: "POST" })).status, 403);
});

Deno.test("a member can still read runs", async () => {
  const a = app("member");
  assertEquals((await a.request("/api/flipdesk/import/runs", { method: "GET" })).status, 200);
});

Deno.test("a listing_manager and the owner may import and undo", async () => {
  for (const role of ["listing_manager", "admin", "owner"] as const) {
    const a = app(role);
    assertEquals((await a.request("/api/flipdesk/import/runs", { method: "POST" })).status, 200);
    assertEquals((await a.request("/api/flipdesk/import/runs/x/undo", { method: "POST" })).status, 200);
  }
});
