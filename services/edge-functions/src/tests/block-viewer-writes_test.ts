// US-1928: behavioral test for the blockViewerWrites baseline write floor.
//
// The coverage guard (flipdesk-role-floor-coverage_test.ts) proves the middleware
// is MOUNTED across the surface; this proves it BEHAVES: a viewer is blocked on
// mutating verbs, allowed on reads, and every other role (and the no-role
// webhook/cron case) passes through untouched.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { blockViewerWrites } from "../middleware/workspace.ts";
import type { WorkspaceRole } from "../lib/workspace-roles.ts";

// A tiny app that stamps a fixed role (or none) then applies the floor, exposing
// the same path under several verbs.
function appWithRole(role: WorkspaceRole | null) {
  const app = new Hono<{ Variables: { workspaceRole: WorkspaceRole } }>();
  app.use("*", async (c, next) => {
    if (role) c.set("workspaceRole", role);
    await next();
  });
  app.use("*", blockViewerWrites);
  app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], "/x", (c) => c.json({ ok: true }));
  return app;
}

async function status(role: WorkspaceRole | null, method: string): Promise<number> {
  const res = await appWithRole(role).request("/x", { method });
  return res.status;
}

Deno.test("a viewer is blocked on every mutating verb", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assertEquals(await status("viewer", method), 403, `viewer ${method} should be 403`);
  }
});

Deno.test("a viewer is allowed on reads (GET)", async () => {
  assertEquals(await status("viewer", "GET"), 200);
});

Deno.test("the 403 body carries the machine-readable readonly code", async () => {
  const res = await appWithRole("viewer").request("/x", { method: "POST" });
  const body = await res.json();
  assertEquals(body.error_code, "workspace_viewer_readonly");
});

Deno.test("member, listing_manager, admin, owner all pass mutating verbs", async () => {
  for (const role of ["member", "listing_manager", "admin", "owner"] as WorkspaceRole[]) {
    assertEquals(await status(role, "POST"), 200, `${role} POST should pass`);
  }
});

Deno.test("no role context (webhook / cron) passes through on mutations", async () => {
  // Public webhook / job-secret cron sub-paths never run workspaceMiddleware, so
  // workspaceRole is undefined — the floor must NOT block them.
  assertEquals(await status(null, "POST"), 200);
  assert(true);
});
